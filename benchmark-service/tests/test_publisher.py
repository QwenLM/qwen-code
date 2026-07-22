from __future__ import annotations

import json
from pathlib import Path

import httpx

from qwen_benchmark.config import Settings
from qwen_benchmark.publisher import publish_check


def test_publish_updates_the_triggering_release(monkeypatch, tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "state.db",
        work_root=tmp_path / "work",
        artifact_root=tmp_path / "artifacts",
        qwen_repo=tmp_path,
        swebench_python=Path("/usr/bin/python3"),
        auth_mode="token",
        shared_token=None,
        oidc_audience="qwen-benchmark",
        allowed_repository="QwenLM/qwen-code",
        allowed_repository_id=None,
        allowed_workflow=None,
        poll_seconds=1,
        github_token="token",
    )
    calls: list[tuple[str, str, dict | None]] = []

    def response(method: str, url: str, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        if method == "get":
            return httpx.Response(
                200,
                json={"body": "Original notes"},
                request=httpx.Request(method.upper(), url),
            )
        return httpx.Response(
            201 if method == "post" else 200,
            json={},
            request=httpx.Request(method.upper(), url),
        )

    monkeypatch.setattr("qwen_benchmark.publisher.httpx.get", lambda url, **kwargs: response("get", url, **kwargs))
    monkeypatch.setattr("qwen_benchmark.publisher.httpx.patch", lambda url, **kwargs: response("patch", url, **kwargs))
    monkeypatch.setattr("qwen_benchmark.publisher.httpx.post", lambda url, **kwargs: response("post", url, **kwargs))
    run = {
        "run_id": "qwen-bench-test",
        "repository": "QwenLM/qwen-code",
        "qwen_commit": "a" * 40,
        "suite": "swebench_verified_harbor_smoke",
        "status": "SUCCEEDED",
        "request_json": json.dumps({"release_id": 123}),
    }
    summary = {
        "run_id": "qwen-bench-test",
        "suite": "swebench_verified_harbor_smoke",
        "qwen_version": "0.19.7",
        "qwen_commit": "a" * 40,
        "resolved_instances": 1,
        "expected_instances": 1,
        "error_instances": 0,
    }

    assert publish_check(settings, run, summary) == "PUBLISHED"
    assert calls[0] == ("get", "https://api.github.com/repos/QwenLM/qwen-code/releases/123", None)
    assert calls[1][0] == "patch"
    assert "Qwen Code benchmark" in calls[1][2]["body"]
    assert calls[2][0] == "post"


def test_failed_run_is_published_without_a_score(monkeypatch, tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "state.db",
        work_root=tmp_path / "work",
        artifact_root=tmp_path / "artifacts",
        qwen_repo=tmp_path,
        swebench_python=Path("/usr/bin/python3"),
        auth_mode="token",
        shared_token=None,
        oidc_audience="qwen-benchmark",
        allowed_repository="QwenLM/qwen-code",
        allowed_repository_id=None,
        allowed_workflow=None,
        poll_seconds=1,
        github_token="token",
    )
    calls: list[tuple[str, dict | None]] = []

    def response(method: str, url: str, **kwargs):
        calls.append((method, kwargs.get("json")))
        return httpx.Response(
            200 if method != "post" else 201,
            json={"body": "Original notes"} if method == "get" else {},
            request=httpx.Request(method.upper(), url),
        )

    monkeypatch.setattr("qwen_benchmark.publisher.httpx.get", lambda url, **kwargs: response("get", url, **kwargs))
    monkeypatch.setattr("qwen_benchmark.publisher.httpx.patch", lambda url, **kwargs: response("patch", url, **kwargs))
    monkeypatch.setattr("qwen_benchmark.publisher.httpx.post", lambda url, **kwargs: response("post", url, **kwargs))
    run = {
        "run_id": "qwen-bench-failed",
        "repository": "QwenLM/qwen-code",
        "qwen_commit": "a" * 40,
        "suite": "swebench_verified_harbor_smoke",
        "status": "FAILED",
        "request_json": json.dumps({"release_id": 123}),
    }
    summary = {
        "run_id": "qwen-bench-failed",
        "suite": "swebench_verified_harbor_smoke",
        "qwen_version": "0.19.7",
        "qwen_commit": "a" * 40,
        "resolved_instances": 0,
        "expected_instances": 1,
        "error_instances": 1,
    }

    assert publish_check(settings, run, summary) == "PUBLISHED"
    assert "not scored" in calls[1][1]["body"]
    assert "Result:" not in calls[1][1]["body"]
    assert calls[2][1]["conclusion"] == "failure"
    assert calls[2][1]["output"]["title"] == "Benchmark failed (not scored)"
