#!/usr/bin/env python3

# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

import html
import json
import os
import re
import sqlite3
import subprocess
import threading
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import jwt
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

REPOSITORY = "QwenLM/qwen-code"
REPOSITORY_ID = "1008713177"
REPOSITORY_OWNER_ID = "141221163"
OIDC_ISSUER = "https://token.actions.githubusercontent.com"
OIDC_SUBJECT = f"repo:{REPOSITORY}:environment:release-benchmark"
WORKFLOW_PREFIX = f"{REPOSITORY}/.github/workflows/release-benchmark.yml@"
STABLE_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

ROOT = Path(os.environ.get("BENCHMARK_ROOT", Path(__file__).resolve().parent))
DB_PATH = ROOT / "state" / "benchmark.db"
CONFIG_DIR = ROOT / "state" / "configs"
LOG_DIR = ROOT / "logs"
JOBS_DIR = ROOT / "jobs"
SUITES_PATH = Path(os.environ.get("BENCHMARK_SUITES", ROOT / "suites.json"))
HARBOR_BIN = os.environ.get("HARBOR_BIN", str(ROOT / ".venv/bin/harbor"))
PUBLIC_BASE_URL = os.environ["PUBLIC_BASE_URL"].rstrip("/")
VIEWER_BASE_URL = os.environ["VIEWER_BASE_URL"].rstrip("/")
OIDC_AUDIENCE = os.environ.get(
    "RELEASE_BENCHMARK_OIDC_AUDIENCE", "qwen-release-benchmark"
)
MODEL_NAME = os.environ["OPENAI_MODEL"]
PYPI_INDEX_URL = os.environ.get("PYPI_INDEX_URL")
GITHUB_RELEASE_CACHE_DIR = Path(os.environ["GITHUB_RELEASE_CACHE_DIR"]).resolve()

oidc_keys = jwt.PyJWKClient(
    f"{OIDC_ISSUER}/.well-known/jwks",
    cache_keys=True,
    lifespan=300,
)
worker_wakeup = threading.Event()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Release(StrictModel):
    repository: Literal["QwenLM/qwen-code"]
    tag: str
    version: str
    url: str
    commit_sha: str = Field(pattern=r"^[0-9a-f]{40}$")


class Trigger(StrictModel):
    event_name: Literal["release", "workflow_dispatch"]
    actor: str = Field(min_length=1, max_length=100)
    run_id: str = Field(pattern=r"^[0-9]+$")
    run_attempt: str = Field(pattern=r"^[0-9]+$")
    workflow_ref: str


class Callback(StrictModel):
    repository: Literal["QwenLM/qwen-code"]
    commit_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    actions_run_url: str


class BenchmarkRequest(StrictModel):
    schema_version: Literal[1]
    idempotency_key: str = Field(min_length=1, max_length=200)
    release: Release
    suite: str
    trigger: Trigger
    callback: Callback


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def initialize() -> None:
    for directory in (DB_PATH.parent, CONFIG_DIR, LOG_DIR, JOBS_DIR):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              job_id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              state TEXT NOT NULL,
              repository TEXT NOT NULL,
              tag TEXT NOT NULL,
              version TEXT NOT NULL,
              commit_sha TEXT NOT NULL,
              suite TEXT NOT NULL,
              release_url TEXT NOT NULL,
              actions_run_url TEXT NOT NULL,
              harbor_job_name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              exit_code INTEGER,
              error TEXT
            )
            """
        )
        connection.execute(
            """
            UPDATE jobs
            SET state = 'failed',
                finished_at = ?,
                error = 'Benchmark service restarted while the job was running.'
            WHERE state = 'running'
            """,
            (utc_now(),),
        )


def load_suites() -> dict[str, dict[str, Any]]:
    suites = json.loads(SUITES_PATH.read_text())
    if not isinstance(suites, dict):
        raise RuntimeError("suites.json must contain an object")
    return suites


def decode_oidc(token: str) -> dict[str, Any]:
    try:
        signing_key = oidc_keys.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=OIDC_AUDIENCE,
            issuer=OIDC_ISSUER,
        )
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="Invalid GitHub OIDC token") from error


def validate_claims(claims: dict[str, Any], payload: BenchmarkRequest) -> None:
    expected = {
        "sub": OIDC_SUBJECT,
        "repository": REPOSITORY,
        "repository_id": REPOSITORY_ID,
        "repository_owner_id": REPOSITORY_OWNER_ID,
        "event_name": payload.trigger.event_name,
        "actor": payload.trigger.actor,
        "run_id": payload.trigger.run_id,
        "run_attempt": payload.trigger.run_attempt,
    }
    if any(str(claims.get(key, "")) != value for key, value in expected.items()):
        raise HTTPException(status_code=403, detail="OIDC identity does not match request")

    workflow_ref = str(claims.get("workflow_ref", ""))
    if (
        not workflow_ref.startswith(WORKFLOW_PREFIX)
        or workflow_ref != payload.trigger.workflow_ref
    ):
        raise HTTPException(status_code=403, detail="Unexpected workflow identity")

    expected_ref = (
        f"refs/tags/{payload.release.tag}"
        if payload.trigger.event_name == "release"
        else "refs/heads/main"
    )
    if claims.get("ref") != expected_ref:
        raise HTTPException(status_code=403, detail="Unexpected workflow ref")


def github_json(path: str) -> dict[str, Any]:
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "qwen-release-benchmark",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=502, detail="Could not verify release with GitHub"
        ) from error
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Unexpected GitHub response")
    return data


def validate_release(payload: BenchmarkRequest) -> None:
    release = payload.release
    if not STABLE_TAG.fullmatch(release.tag) or release.version != release.tag[1:]:
        raise HTTPException(status_code=422, detail="Release tag is not stable semver")
    if not SAFE_NAME.fullmatch(payload.suite):
        raise HTTPException(status_code=422, detail="Invalid benchmark suite")
    if payload.suite not in load_suites():
        raise HTTPException(status_code=422, detail="Unknown benchmark suite")

    expected_key = f"{REPOSITORY}:{release.tag}:{payload.suite}"
    expected_release_url = f"https://github.com/{REPOSITORY}/releases/tag/{release.tag}"
    expected_actions_url = (
        f"https://github.com/{REPOSITORY}/actions/runs/{payload.trigger.run_id}"
    )
    if (
        payload.idempotency_key != expected_key
        or release.url != expected_release_url
        or payload.callback.repository != REPOSITORY
        or payload.callback.commit_sha != release.commit_sha
        or payload.callback.actions_run_url != expected_actions_url
    ):
        raise HTTPException(status_code=422, detail="Request metadata is inconsistent")

    github_release = github_json(f"/repos/{REPOSITORY}/releases/tags/{release.tag}")
    if github_release.get("draft") is not False or github_release.get("prerelease") is not False:
        raise HTTPException(status_code=422, detail="Release is not published and stable")
    github_commit = github_json(f"/repos/{REPOSITORY}/commits/{release.tag}")
    if github_commit.get("sha") != release.commit_sha:
        raise HTTPException(status_code=422, detail="Release commit does not match tag")


def make_job_id(payload: BenchmarkRequest) -> str:
    return f"qwen-code-{payload.release.tag}-{payload.suite}"


def enqueue(payload: BenchmarkRequest) -> tuple[str, bool]:
    job_id = make_job_id(payload)
    harbor_job_name = f"{payload.release.tag}-{payload.suite}"
    with connect() as connection:
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO jobs (
              job_id, idempotency_key, state, repository, tag, version,
              commit_sha, suite, release_url, actions_run_url, harbor_job_name,
              created_at
            ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                payload.idempotency_key,
                REPOSITORY,
                payload.release.tag,
                payload.release.version,
                payload.release.commit_sha,
                payload.suite,
                payload.release.url,
                payload.callback.actions_run_url,
                harbor_job_name,
                utc_now(),
            ),
        )
        if cursor.rowcount == 0:
            existing = connection.execute(
                "SELECT job_id FROM jobs WHERE idempotency_key = ?",
                (payload.idempotency_key,),
            ).fetchone()
            if existing is None:
                raise RuntimeError("Could not resolve existing benchmark job")
            return str(existing["job_id"]), False
    worker_wakeup.set()
    return job_id, True


def claim_job() -> sqlite3.Row | None:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        connection.execute(
            "UPDATE jobs SET state = 'running', started_at = ? WHERE job_id = ?",
            (utc_now(), row["job_id"]),
        )
        return row


def run_job(job: sqlite3.Row) -> None:
    suites = load_suites()
    suite = suites[str(job["suite"])]
    environment_env = {
        "UV_INSTALLER_GITHUB_BASE_URL": "file:///opt/github",
        "UV_PYTHON_INSTALL_MIRROR": (
            "https://releases.astral.sh/github/"
            "python-build-standalone/releases/download"
        ),
    }
    if PYPI_INDEX_URL:
        environment_env.update(
            {
                "PIP_INDEX_URL": PYPI_INDEX_URL,
                "UV_INDEX_URL": PYPI_INDEX_URL,
            }
        )
    environment: dict[str, Any] = {
        "type": "docker",
        "delete": True,
        "env": environment_env,
        "mounts": [
            {
                "type": "bind",
                "source": str(GITHUB_RELEASE_CACHE_DIR),
                "target": "/opt/github",
                "read_only": True,
            }
        ],
    }
    config = {
        "jobs_dir": str(JOBS_DIR),
        "n_attempts": 1,
        "timeout_multiplier": 1.0,
        "orchestrator": {
            "type": "local",
            "n_concurrent_trials": suite["n_concurrent_trials"],
            "quiet": True,
        },
        "environment": environment,
        "agents": [
            {
                "import_path": "qwen_coder_mirror:QwenCoderMirror",
                "model_name": MODEL_NAME,
                "kwargs": {"version": str(job["version"])},
            }
        ],
        "datasets": suite["datasets"],
    }
    config_path = CONFIG_DIR / f"{job['job_id']}.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    config_path.chmod(0o600)
    log_path = LOG_DIR / f"{job['job_id']}.log"

    command = [
        HARBOR_BIN,
        "run",
        "--config",
        str(config_path),
        "--job-name",
        str(job["harbor_job_name"]),
        "--yes",
        "--quiet",
    ]
    return_code = -1
    error: str | None = None
    try:
        with log_path.open("w") as log:
            log_path.chmod(0o600)
            environment = os.environ.copy()
            environment["PYTHONPATH"] = os.pathsep.join(
                value
                for value in (str(ROOT), environment.get("PYTHONPATH"))
                if value
            )
            completed = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
            return_code = completed.returncode
    except OSError as exception:
        error = str(exception)[:500]

    state = "completed" if return_code == 0 else "failed"
    if return_code != 0 and error is None:
        error = f"Harbor exited with status {return_code}."
    with connect() as connection:
        connection.execute(
            """
            UPDATE jobs
            SET state = ?, finished_at = ?, exit_code = ?, error = ?
            WHERE job_id = ?
            """,
            (state, utc_now(), return_code, error, job["job_id"]),
        )


def worker() -> None:
    while True:
        job = claim_job()
        if job is None:
            worker_wakeup.wait(10)
            worker_wakeup.clear()
            continue
        try:
            run_job(job)
        except Exception as exception:
            with connect() as connection:
                connection.execute(
                    """
                    UPDATE jobs
                    SET state = 'failed', finished_at = ?, error = ?
                    WHERE job_id = ?
                    """,
                    (utc_now(), str(exception)[:500], job["job_id"]),
                )


def result_summary(job: sqlite3.Row) -> dict[str, Any] | None:
    path = JOBS_DIR / str(job["harbor_job_name"]) / "result.json"
    if not path.is_file():
        return None
    try:
        result = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    stats = result.get("stats", {})
    return {
        "total": result.get("n_total_trials"),
        "completed": stats.get("n_completed_trials"),
        "errors": stats.get("n_errored_trials"),
        "running": stats.get("n_running_trials"),
        "pending": stats.get("n_pending_trials"),
        "evals": stats.get("evals", {}),
    }


def get_job(job_id: str) -> sqlite3.Row:
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return row


def render_page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font: 16px/1.5 system-ui, sans-serif; max-width: 960px; margin: 48px auto; padding: 0 20px; color: #172033; }}
    a {{ color: #2457d6; }} table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border-bottom: 1px solid #d9deea; padding: 10px; text-align: left; }}
    code {{ background: #f2f4f8; padding: 2px 5px; border-radius: 4px; }}
    .state {{ display: inline-block; padding: 3px 9px; border-radius: 99px; background: #e8edf8; }}
  </style>
</head>
<body><h1>{html.escape(title)}</h1>{body}</body>
</html>""",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        },
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize()
    threading.Thread(target=worker, daemon=True, name="benchmark-worker").start()
    yield


app = FastAPI(title="Qwen Release Benchmarks", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    with connect() as connection:
        jobs = connection.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
    rows = "".join(
        f"<tr><td><a href='/jobs/{html.escape(str(job['job_id']))}'>{html.escape(str(job['tag']))}</a></td>"
        f"<td>{html.escape(str(job['suite']))}</td><td><span class='state'>{html.escape(str(job['state']))}</span></td>"
        f"<td>{html.escape(str(job['created_at']))}</td></tr>"
        for job in jobs
    )
    return render_page(
        "Qwen Release Benchmarks",
        "<p>Public release evaluation status and Harbor reports.</p>"
        "<table><thead><tr><th>Release</th><th>Suite</th><th>State</th><th>Created</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>",
    )


@app.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_page(job_id: str) -> HTMLResponse:
    job = get_job(job_id)
    summary = result_summary(job)
    summary_html = (
        "<p>Harbor has not written a result summary yet.</p>"
        if summary is None
        else "<h2>Progress</h2><pre>"
        + html.escape(json.dumps(summary, indent=2))
        + "</pre>"
    )
    body = f"""
<p><span class="state">{html.escape(str(job["state"]))}</span></p>
<table>
  <tr><th>Release</th><td><a href="{html.escape(str(job["release_url"]))}">{html.escape(str(job["tag"]))}</a></td></tr>
  <tr><th>Suite</th><td><code>{html.escape(str(job["suite"]))}</code></td></tr>
  <tr><th>Commit</th><td><code>{html.escape(str(job["commit_sha"]))}</code></td></tr>
  <tr><th>Started</th><td>{html.escape(str(job["started_at"] or "pending"))}</td></tr>
  <tr><th>Finished</th><td>{html.escape(str(job["finished_at"] or "pending"))}</td></tr>
</table>
{summary_html}
<p><a href="{html.escape(VIEWER_BASE_URL)}/jobs/{html.escape(str(job["harbor_job_name"]))}">Open detailed Harbor report</a></p>
<p><a href="{html.escape(str(job["actions_run_url"]))}">Open GitHub Actions dispatch</a></p>
"""
    return render_page(f"{job['tag']} · {job['suite']}", body)


@app.get("/v1/jobs/{job_id}")
def job_json(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    return {
        "job_id": job["job_id"],
        "state": job["state"],
        "release": job["tag"],
        "suite": job["suite"],
        "created_at": job["created_at"],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
        "error": job["error"],
        "summary": result_summary(job),
        "status_url": f"{PUBLIC_BASE_URL}/jobs/{job['job_id']}",
    }


@app.post("/v1/release-benchmarks", status_code=202)
def create_benchmark(
    payload: BenchmarkRequest,
    authorization: Annotated[str | None, Header()] = None,
    idempotency_key: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    if idempotency_key != payload.idempotency_key:
        raise HTTPException(status_code=422, detail="Idempotency key mismatch")
    claims = decode_oidc(authorization.removeprefix("Bearer "))
    validate_claims(claims, payload)
    validate_release(payload)
    job_id, created = enqueue(payload)
    return {
        "job_id": job_id,
        "state": "queued" if created else "already_exists",
        "status_url": f"{PUBLIC_BASE_URL}/jobs/{job_id}",
    }
