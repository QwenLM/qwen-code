from __future__ import annotations

import json
from pathlib import Path

import pytest

from qwen_benchmark.config import Settings, load_suites
from qwen_benchmark.harbor_runner import HarborRunner, qwen_version_from_ref
from qwen_benchmark.runner import AgentError


def settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=tmp_path / "state/benchmark.db",
        work_root=tmp_path / "work",
        artifact_root=tmp_path / "artifacts",
        qwen_repo=tmp_path,
        swebench_python=Path("/usr/bin/python3"),
        auth_mode="token",
        shared_token="test-token",
        oidc_audience="qwen-benchmark",
        allowed_repository="QwenLM/qwen-code",
        allowed_repository_id=None,
        allowed_workflow=None,
        poll_seconds=0.01,
        github_token=None,
        harbor_binary=tmp_path / "harbor",
        harbor_jobs_root=tmp_path / "harbor-jobs",
        benchmark_model="test-model",
        npm_wait_seconds=0,
    )


def test_qwen_version_from_release_ref() -> None:
    assert qwen_version_from_ref("v0.19.7") == "0.19.7"
    assert qwen_version_from_ref("0.20.0-beta.1") == "0.20.0-beta.1"
    with pytest.raises(AgentError):
        qwen_version_from_ref("main")


def test_parse_harbor_result_and_validate_version(tmp_path: Path) -> None:
    runner = HarborRunner(settings(tmp_path), lambda: None)
    suite = load_suites()["swebench_verified_harbor_smoke"]
    jobs_root = tmp_path / "jobs"
    trial = jobs_root / "sympy__sympy-20590" / "sympy__sympy-20590__abc123"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps(
            {
                "task_name": "sympy__sympy-20590",
                "agent_info": {"name": "qwen-coder", "version": "0.19.7"},
                "exception_info": None,
                "verifier_result": {"rewards": {"reward": 1}},
            }
        ),
        encoding="utf-8",
    )
    work_dir = tmp_path / "work"
    work_dir.mkdir()

    result = runner._parse_results(jobs_root, suite, "0.19.7", work_dir)
    assert result.completed == 1
    assert result.resolved == 1
    assert result.resolved_ids == ["sympy__sympy-20590"]
    assert result.error_ids == []

    payload = json.loads(result.report_path.read_text())
    assert payload["qwen_version"] == "0.19.7"
    assert payload["trials"][0]["reward"] == 1


def test_parse_harbor_result_rejects_wrong_qwen_version(tmp_path: Path) -> None:
    runner = HarborRunner(settings(tmp_path), lambda: None)
    suite = load_suites()["swebench_verified_harbor_smoke"]
    jobs_root = tmp_path / "jobs"
    trial = jobs_root / "sympy__sympy-20590" / "trial"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps(
            {
                "task_name": "sympy__sympy-20590",
                "agent_info": {"name": "qwen-coder", "version": "latest"},
                "exception_info": None,
                "verifier_result": {"rewards": {"reward": 0}},
            }
        ),
        encoding="utf-8",
    )
    work_dir = tmp_path / "work"
    work_dir.mkdir()

    with pytest.raises(AgentError, match="version mismatch"):
        runner._parse_results(jobs_root, suite, "0.19.7", work_dir)


def test_npm_metadata_accepts_flattened_dist_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = HarborRunner(settings(tmp_path), lambda: None)

    class Result:
        returncode = 0
        stdout = json.dumps(
            {
                "version": "0.19.7",
                "dist.integrity": "sha512-test",
                "dist.tarball": "https://registry.example/qwen-code-0.19.7.tgz",
            }
        )
        stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *args, **kwargs: Result())
    metadata = runner._wait_for_npm_release("0.19.7")
    assert metadata["dist.integrity"] == "sha512-test"
