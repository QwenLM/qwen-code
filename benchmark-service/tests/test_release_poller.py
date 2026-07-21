from __future__ import annotations

from pathlib import Path

import httpx

from qwen_benchmark.config import Settings
from qwen_benchmark.release_poller import ReleasePoller
from qwen_benchmark.store import Store


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
        poll_seconds=1,
        github_token="test-github-token",
        release_poll_suite="swebench_verified_harbor_smoke",
    )


def test_poller_queues_latest_stable_release_once(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-github-token"
        if request.url.path.endswith("/releases"):
            return httpx.Response(
                200,
                json=[
                    {"id": 3, "tag_name": "v9.9.9-preview.0", "prerelease": True, "draft": False, "published_at": "2026-07-21T10:00:00Z"},
                    {"id": 2, "tag_name": "v1.2.0", "prerelease": False, "draft": False, "published_at": "2026-07-21T09:00:00Z"},
                    {"id": 1, "tag_name": "v1.1.0", "prerelease": False, "draft": False, "published_at": "2026-07-20T09:00:00Z"},
                ],
            )
        assert request.url.path.endswith("/commits/v1.2.0")
        return httpx.Response(200, json={"sha": "a" * 40})

    config = settings(tmp_path)
    config.prepare_directories()
    store = Store(config.database_path)
    store.initialize()
    client = httpx.Client(transport=httpx.MockTransport(handler))
    poller = ReleasePoller(config, store, client=client)

    first = poller.poll_once()
    second = poller.poll_once()

    assert first == {"run_id": first["run_id"], "tag": "v1.2.0", "deduplicated": False}
    assert second == {"run_id": first["run_id"], "tag": "v1.2.0", "deduplicated": True}
    run = store.get_run(first["run_id"])
    assert run and run["qwen_commit"] == "a" * 40
