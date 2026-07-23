from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Callable

from .artifacts import Artifacts
from .config import Settings, Suite
from .runner import AgentError, InfrastructureError, RunResult


VERSION_RE = re.compile(r"^v?(?P<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")
LOGGER = logging.getLogger(__name__)


def qwen_version_from_ref(qwen_ref: str) -> str:
    match = VERSION_RE.fullmatch(qwen_ref)
    if not match:
        raise AgentError(
            "Harbor runs require a Qwen Code release tag such as v0.19.7"
        )
    return match.group("version")


class HarborRunner:
    def __init__(self, settings: Settings, heartbeat: Callable[[], None]):
        self.settings = settings
        self.heartbeat = heartbeat

    def resolve_qwen_commit(self, qwen_ref: str) -> str:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(self.settings.qwen_repo),
                "rev-parse",
                f"{qwen_ref}^{{commit}}",
            ],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise InfrastructureError(
                "release commit is not present locally; dispatch must include qwen_commit"
            )
        return result.stdout.strip()

    def run(
        self,
        run_id: str,
        qwen_commit: str,
        suite: Suite,
        artifacts: Artifacts,
        on_grading: Callable[[], None] | None = None,
        qwen_ref: str | None = None,
    ) -> RunResult:
        if not qwen_ref:
            raise AgentError("qwen_ref is required for a Harbor run")
        version = qwen_version_from_ref(qwen_ref)
        npm_metadata = self._wait_for_npm_release(version)
        artifacts.write_json("release/npm-metadata.json", npm_metadata)

        if not self.settings.benchmark_model:
            raise AgentError("OPENAI_MODEL is not configured")
        if not os.environ.get("OPENAI_API_KEY"):
            raise AgentError("OPENAI_API_KEY is not configured")
        if not os.environ.get("OPENAI_BASE_URL"):
            raise AgentError("OPENAI_BASE_URL is not configured")
        if not self.settings.harbor_binary.is_file():
            raise InfrastructureError(
                f"Harbor binary not found: {self.settings.harbor_binary}"
            )

        run_jobs_base = self.settings.harbor_jobs_root / run_id
        run_jobs_base.mkdir(parents=True, exist_ok=True)
        attempt_number = 1
        while (run_jobs_base / f"attempt-{attempt_number:02d}").exists():
            attempt_number += 1
        run_jobs_root = run_jobs_base / f"attempt-{attempt_number:02d}"
        run_jobs_root.mkdir(parents=True, exist_ok=True)
        work_dir = self.settings.work_root / run_id
        work_dir.mkdir(parents=True, exist_ok=True)

        harbor_dataset = suite.get(
            "harbor_dataset", "swe-bench/swe-bench-verified"
        )
        dataset_version = suite.get("harbor_dataset_version")
        dataset_spec = (
            f"{harbor_dataset}@{dataset_version}"
            if dataset_version
            else harbor_dataset
        )

        result: RunResult | None = None
        try:
            for instance_id in suite["instance_ids"]:
                harbor_task_name = f"{suite.get('harbor_task_prefix', '')}{instance_id}"
                command = [
                    str(self.settings.harbor_binary),
                    "run",
                    "--dataset",
                    dataset_spec,
                    "--include-task-name",
                    harbor_task_name,
                    "--agent",
                    "qwen-coder",
                    "--model",
                    self.settings.benchmark_model,
                    "--agent-kwarg",
                    f"version={version}",
                    "--agent-kwarg",
                    f"max_turns={suite.get('harbor_max_turns', 200)}",
                    "--env",
                    "docker",
                    "--n-concurrent",
                    "1",
                    "--max-retries",
                    "0",
                    "--job-name",
                    instance_id,
                    "--jobs-dir",
                    str(run_jobs_root),
                    "--yes",
                ]
                returncode = self._command(
                    command,
                    work_dir,
                    work_dir / f"harbor-{instance_id}.log",
                    suite["instance_timeout_seconds"],
                )
                job_dir = run_jobs_root / instance_id
                if returncode != 0 and not list(job_dir.glob("*/result.json")):
                    raise InfrastructureError(
                        f"Harbor failed before producing a trial result: {instance_id}"
                    )

            if on_grading:
                on_grading()
            result = self._parse_results(run_jobs_root, suite, version, work_dir)
            return result
        finally:
            # Preserve all evidence even when Harbor, the verifier, or state-store
            # bookkeeping fails after a trial has already produced useful output.
            try:
                artifacts.copy_tree(
                    run_jobs_root, f"harbor/jobs/attempt-{attempt_number:02d}"
                )
                for instance_id in suite["instance_ids"]:
                    log_path = work_dir / f"harbor-{instance_id}.log"
                    if log_path.exists():
                        artifacts.copy(log_path, f"harbor/logs/{instance_id}.log")
                if result is not None:
                    artifacts.copy(
                        result.report_path, "harbor/evaluation-report.json"
                    )
            except OSError:
                LOGGER.exception("failed to collect Harbor artifacts for %s", run_id)

    def _wait_for_npm_release(self, version: str) -> dict:
        deadline = time.monotonic() + self.settings.npm_wait_seconds
        command = [
            "npm",
            "view",
            f"@qwen-code/qwen-code@{version}",
            "version",
            "dist.integrity",
            "dist.tarball",
            "--json",
            "--registry",
            self.settings.npm_registry,
        ]
        env = os.environ.copy()
        env["NPM_CONFIG_REGISTRY"] = self.settings.npm_registry
        env.setdefault("NPM_CONFIG_CACHE", "/srv/qwen-benchmark/cache/npm")
        last_error = "npm release not found"
        while True:
            try:
                result = subprocess.run(
                    command,
                    text=True,
                    capture_output=True,
                    timeout=60,
                    env=env,
                )
            except subprocess.TimeoutExpired:
                last_error = "npm view timed out after 60 seconds"
                result = None
            if result is not None and result.returncode == 0:
                try:
                    metadata = json.loads(result.stdout)
                except json.JSONDecodeError as error:
                    raise InfrastructureError("npm returned invalid JSON") from error
                if metadata.get("version") != version:
                    raise AgentError(
                        f"npm version mismatch: expected {version}, got {metadata.get('version')}"
                    )
                integrity = metadata.get("dist.integrity") or (
                    metadata.get("dist") or {}
                ).get("integrity")
                if not integrity:
                    raise InfrastructureError("npm metadata is missing dist.integrity")
                return metadata
            if result is not None:
                last_error = (result.stderr or result.stdout).strip()[-1000:]
            if time.monotonic() >= deadline:
                raise InfrastructureError(
                    f"Qwen Code npm release {version} is unavailable: {last_error}"
                )
            LOGGER.warning(
                "Qwen Code npm release %s is not visible yet; retrying: %s",
                version,
                last_error,
            )
            self.heartbeat()
            time.sleep(min(30, max(self.settings.npm_wait_seconds, 1)))

    def _parse_results(
        self,
        run_jobs_root: Path,
        suite: Suite,
        expected_version: str,
        work_dir: Path,
    ) -> RunResult:
        expected = set(suite["instance_ids"])
        seen: set[str] = set()
        resolved_ids: list[str] = []
        unresolved_ids: list[str] = []
        error_ids: list[str] = []
        details: list[dict] = []

        for result_path in sorted(run_jobs_root.glob("*/*/result.json")):
            result = json.loads(result_path.read_text(encoding="utf-8"))
            instance_id = result.get("task_name") or result.get("task_id")
            task_prefix = suite.get("harbor_task_prefix", "")
            if task_prefix and isinstance(instance_id, str):
                instance_id = instance_id.removeprefix(task_prefix)
            if instance_id not in expected or instance_id in seen:
                continue
            seen.add(instance_id)
            agent_info = result.get("agent_info") or {}
            actual_version = str(agent_info.get("version") or "")
            exception = result.get("exception_info")
            rewards = (result.get("verifier_result") or {}).get("rewards") or {}
            reward = rewards.get("reward")

            if actual_version != expected_version:
                raise AgentError(
                    f"Qwen Code version mismatch for {instance_id}: "
                    f"expected {expected_version}, got {actual_version or 'unknown'}"
                )
            if exception is not None or not isinstance(reward, (int, float)):
                error_ids.append(instance_id)
            elif float(reward) > 0:
                resolved_ids.append(instance_id)
            else:
                unresolved_ids.append(instance_id)
            details.append(
                {
                    "instance_id": instance_id,
                    "qwen_version": actual_version,
                    "reward": reward,
                    "has_exception": exception is not None,
                    "result_path": str(result_path.relative_to(run_jobs_root)),
                }
            )

        for instance_id in sorted(expected - seen):
            error_ids.append(instance_id)

        completed = len(resolved_ids) + len(unresolved_ids)
        report = {
            "completed_instances": completed,
            "resolved_instances": len(resolved_ids),
            "resolved_ids": sorted(resolved_ids),
            "unresolved_ids": sorted(unresolved_ids),
            "error_ids": sorted(error_ids),
            "qwen_version": expected_version,
            "trials": details,
        }
        report_path = work_dir / "harbor-evaluation-report.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        return RunResult(
            completed=completed,
            resolved=len(resolved_ids),
            resolved_ids=sorted(resolved_ids),
            unresolved_ids=sorted(unresolved_ids),
            error_ids=sorted(error_ids),
            report_path=report_path,
        )

    def _command(
        self, command: list[str], cwd: Path, log_path: Path, timeout_seconds: int
    ) -> int:
        env = os.environ.copy()
        env["NPM_CONFIG_REGISTRY"] = self.settings.npm_registry
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
            deadline = time.monotonic() + timeout_seconds
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                    raise AgentError(f"Harbor trial timed out: {command[5]}")
                self.heartbeat()
                time.sleep(5)
            return process.returncode
