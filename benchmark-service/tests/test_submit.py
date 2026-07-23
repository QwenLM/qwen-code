from __future__ import annotations

from pathlib import Path

import pytest

from qwen_benchmark.config import Settings
from qwen_benchmark.models import RunRequest
from qwen_benchmark.submit import submit_run


def settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=tmp_path / "state/benchmark.db",
        work_root=tmp_path / "work",
        artifact_root=tmp_path / "artifacts",
        qwen_repo=tmp_path,
        swebench_python=Path("/usr/bin/python3"),
        allowed_repository="QwenLM/qwen-code",
        poll_seconds=0.01,
        github_token=None,
    )


def test_submit_creates_an_idempotent_local_run(tmp_path: Path) -> None:
    request = RunRequest(
        qwen_ref="v0.20.0-nightly.20260722.b98306b7e",
        qwen_commit="a" * 40,
        suite="swebench_verified_harbor_smoke",
        trigger="workflow_dispatch",
        release_id=123,
        github_run_id=456,
        github_run_attempt=1,
    )

    first = submit_run(settings(tmp_path), request, "QwenLM/qwen-code:456:1")
    second = submit_run(settings(tmp_path), request, "QwenLM/qwen-code:456:1")

    assert first["status"] == "QUEUED"
    assert first["deduplicated"] is False
    assert second == {
        "run_id": first["run_id"],
        "status": "QUEUED",
        "deduplicated": True,
    }


def test_submit_rejects_a_suite_outside_the_allowlist(tmp_path: Path) -> None:
    request = RunRequest(
        qwen_ref="v0.20.0",
        qwen_commit="a" * 40,
        suite="untrusted-suite",
        trigger="manual",
    )

    with pytest.raises(ValueError, match="not allowlisted"):
        submit_run(settings(tmp_path), request, "manual-test")
