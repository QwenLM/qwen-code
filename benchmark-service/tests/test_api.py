from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from qwen_benchmark.config import Settings


def settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=tmp_path / "benchmark.db",
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
        harbor_jobs_root=tmp_path / "harbor-jobs",
    )


def payload() -> dict:
    return {
        "repository": "QwenLM/qwen-code",
        "qwen_ref": "HEAD",
        "suite": "swebench_verified_gold_smoke",
        "trigger": "manual",
    }


def test_auth_suite_validation_and_idempotency(tmp_path: Path) -> None:
    from qwen_benchmark.api import create_app

    client = TestClient(create_app(settings(tmp_path)))
    headers = {
        "Authorization": "Bearer test-token",
        "Idempotency-Key": "test-run-1",
    }

    assert client.post("/api/v1/runs", json=payload()).status_code == 401

    invalid = payload()
    invalid["suite"] = "arbitrary-command"
    response = client.post("/api/v1/runs", json=invalid, headers=headers)
    assert response.status_code == 422

    invalid_ref = payload()
    invalid_ref["qwen_ref"] = "--upload-pack=malicious"
    response = client.post("/api/v1/runs", json=invalid_ref, headers=headers)
    assert response.status_code == 422

    first = client.post("/api/v1/runs", json=payload(), headers=headers)
    assert first.status_code == 202
    assert first.json()["deduplicated"] is False

    second = client.post("/api/v1/runs", json=payload(), headers=headers)
    assert second.status_code == 202
    assert second.json()["run_id"] == first.json()["run_id"]
    assert second.json()["deduplicated"] is True

    detail = client.get(
        f"/api/v1/runs/{first.json()['run_id']}",
        headers={"Authorization": "Bearer test-token"},
    )
    assert detail.status_code == 200
    assert detail.json()["dataset"] == "princeton-nlp/SWE-bench_Verified"
    assert detail.json()["expected_instances"] == 1
