from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict


class Suite(TypedDict):
    dataset: str
    dataset_revision: str
    instance_ids: list[str]
    runner_mode: Literal["gold", "qwen", "harbor"]
    grader_concurrency: int
    instance_timeout_seconds: int
    publish: bool
    harbor_dataset: NotRequired[str]
    harbor_dataset_version: NotRequired[str]
    harbor_task_prefix: NotRequired[str]
    harbor_max_turns: NotRequired[int]


@dataclass(frozen=True)
class Settings:
    database_path: Path
    work_root: Path
    artifact_root: Path
    qwen_repo: Path
    swebench_python: Path
    auth_mode: Literal["token", "oidc"]
    shared_token: str | None
    oidc_audience: str
    allowed_repository: str
    allowed_repository_id: str | None
    allowed_workflow: str | None
    poll_seconds: float
    github_token: str | None
    harbor_binary: Path = Path("/srv/qwen-benchmark/venv/bin/harbor")
    harbor_jobs_root: Path = Path("/srv/qwen-benchmark/harbor/jobs")
    benchmark_model: str | None = None
    npm_registry: str = "https://registry.npmjs.org"
    npm_wait_seconds: int = 600

    @classmethod
    def from_env(cls) -> "Settings":
        base = Path(os.environ.get("BENCHMARK_ROOT", "/mnt/workspace/qwen-benchmark"))
        return cls(
            database_path=Path(
                os.environ.get("BENCHMARK_DATABASE_PATH", base / "state/benchmark.db")
            ),
            work_root=Path(
                os.environ.get("BENCHMARK_WORK_ROOT", "/tmp/qwen-benchmark/workspaces")
            ),
            artifact_root=Path(
                os.environ.get(
                    "BENCHMARK_ARTIFACT_ROOT",
                    "/mnt/data/qwen-benchmark/runs",
                )
            ),
            qwen_repo=Path(
                os.environ.get("BENCHMARK_QWEN_REPO", base / "src/qwen-code")
            ),
            swebench_python=Path(
                os.environ.get("BENCHMARK_SWEBENCH_PYTHON", base / "venv/bin/python")
            ),
            auth_mode=os.environ.get("BENCHMARK_AUTH_MODE", "oidc"),  # type: ignore[arg-type]
            shared_token=os.environ.get("BENCHMARK_SHARED_TOKEN"),
            oidc_audience=os.environ.get("BENCHMARK_OIDC_AUDIENCE", "qwen-benchmark"),
            allowed_repository=os.environ.get(
                "BENCHMARK_ALLOWED_REPOSITORY", "QwenLM/qwen-code"
            ),
            allowed_repository_id=os.environ.get("BENCHMARK_ALLOWED_REPOSITORY_ID"),
            allowed_workflow=os.environ.get("BENCHMARK_ALLOWED_WORKFLOW"),
            poll_seconds=float(os.environ.get("BENCHMARK_POLL_SECONDS", "5")),
            github_token=os.environ.get("BENCHMARK_GITHUB_TOKEN"),
            harbor_binary=Path(
                os.environ.get(
                    "BENCHMARK_HARBOR_BINARY", "/srv/qwen-benchmark/venv/bin/harbor"
                )
            ),
            harbor_jobs_root=Path(
                os.environ.get("BENCHMARK_HARBOR_JOBS_ROOT", base / "harbor/jobs")
            ),
            benchmark_model=os.environ.get("OPENAI_MODEL"),
            npm_registry=os.environ.get(
                "BENCHMARK_NPM_REGISTRY", "https://registry.npmmirror.com"
            ),
            npm_wait_seconds=int(os.environ.get("BENCHMARK_NPM_WAIT_SECONDS", "600")),
        )

    def prepare_directories(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self.harbor_jobs_root.mkdir(parents=True, exist_ok=True)


def load_suites(path: Path | None = None) -> dict[str, Suite]:
    if path is None:
        path = Path(__file__).with_name("suites.json")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)
