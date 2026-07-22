from __future__ import annotations

import json
import hashlib
import sqlite3
from pathlib import Path

from qwen_benchmark.config import Settings, load_suites
from qwen_benchmark.models import RunRequest
from qwen_benchmark.runner import AgentError, RunResult
from qwen_benchmark.store import Store
from qwen_benchmark.worker import Worker


class FakeRunner:
    def __init__(self, heartbeat):
        self.heartbeat = heartbeat

    def resolve_qwen_commit(self, qwen_ref: str) -> str:
        assert qwen_ref == "HEAD"
        return "a" * 40

    def run(
        self,
        run_id,
        qwen_commit,
        suite,
        artifacts,
        on_grading=None,
        qwen_ref=None,
    ) -> RunResult:
        assert qwen_ref == "HEAD"
        self.heartbeat()
        if on_grading:
            on_grading()
        report = artifacts.write_json(
            "grader/evaluation-report.json",
            {
                "completed_instances": 1,
                "resolved_instances": 1,
                "resolved_ids": ["sympy__sympy-20590"],
                "unresolved_ids": [],
                "error_ids": [],
            },
        )
        return RunResult(1, 1, ["sympy__sympy-20590"], [], [], report)


class FlakyHeartbeatStore(Store):
    def __init__(self, database_path: Path):
        super().__init__(database_path)
        self.heartbeat_calls = 0

    def heartbeat(self, run_id: str) -> None:
        self.heartbeat_calls += 1
        if self.heartbeat_calls == 1:
            raise sqlite3.OperationalError("unable to open database file")
        super().heartbeat(run_id)


class FailingRunner(FakeRunner):
    def run(self, *args, **kwargs) -> RunResult:
        raise AgentError("agent setup failed")


def test_worker_completes_and_writes_artifacts(tmp_path: Path) -> None:
    settings = Settings(
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
        harbor_jobs_root=tmp_path / "harbor-jobs",
    )
    settings.prepare_directories()
    store = Store(settings.database_path)
    store.initialize()
    suites = load_suites()
    request = RunRequest(
        qwen_ref="HEAD",
        suite="swebench_verified_gold_smoke",
        trigger="manual",
    )
    run, _ = store.create_run(request, suites[request.suite], "worker-test-1")

    worker = Worker(
        settings,
        store,
        suites,
        runner_factory=lambda heartbeat: FakeRunner(heartbeat),
    )
    assert worker.run_once() is True
    assert worker.run_once() is False

    final = store.get_run(run["run_id"])
    assert final is not None
    assert final["status"] == "SUCCEEDED"
    assert final["resolved_instances"] == 1

    instance = store.get_instances(run["run_id"])[0]
    assert instance["status"] == "RESOLVED"

    artifact_root = settings.artifact_root / run["run_id"]
    summary = json.loads((artifact_root / "summary.json").read_text())
    assert summary["dataset"] == "princeton-nlp/SWE-bench_Verified"
    checksum_file = artifact_root / "checksums.sha256"
    for line in checksum_file.read_text().splitlines():
        expected, relative_path = line.split("  ", 1)
        actual = hashlib.sha256(
            (artifact_root / relative_path).read_bytes()
        ).hexdigest()
        assert actual == expected


def test_transient_heartbeat_failure_does_not_abort_runner(tmp_path: Path) -> None:
    settings = Settings(
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
        harbor_jobs_root=tmp_path / "harbor-jobs",
    )
    settings.prepare_directories()
    store = FlakyHeartbeatStore(settings.database_path)
    store.initialize()
    suites = load_suites()
    request = RunRequest(
        qwen_ref="HEAD",
        suite="swebench_verified_gold_smoke",
        trigger="manual",
    )
    run, _ = store.create_run(request, suites[request.suite], "worker-test-flaky")
    worker = Worker(
        settings,
        store,
        suites,
        runner_factory=lambda heartbeat: FakeRunner(heartbeat),
    )

    assert worker.run_once() is True
    final = store.get_run(run["run_id"])
    assert final is not None
    assert final["status"] == "SUCCEEDED"
    assert store.heartbeat_calls >= 1


def test_worker_publishes_terminal_failure_without_score(tmp_path: Path, monkeypatch) -> None:
    settings = Settings(
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
        github_token="token",
        harbor_jobs_root=tmp_path / "harbor-jobs",
    )
    settings.prepare_directories()
    store = Store(settings.database_path)
    store.initialize()
    suites = load_suites()
    request = RunRequest(
        qwen_ref="HEAD",
        suite="swebench_verified_gold_smoke",
        trigger="manual",
    )
    run, _ = store.create_run(request, suites[request.suite], "worker-failure")
    published: list[tuple[dict, dict]] = []
    monkeypatch.setattr(
        "qwen_benchmark.worker.publish_check",
        lambda settings, current, summary: published.append((current, summary)),
    )

    worker = Worker(
        settings,
        store,
        suites,
        runner_factory=lambda heartbeat: FailingRunner(heartbeat),
    )
    assert worker.run_once() is True

    final = store.get_run(run["run_id"])
    assert final is not None and final["status"] == "FAILED"
    assert len(published) == 1
    assert published[0][0]["status"] == "FAILED"
    assert published[0][1]["resolved_instances"] == 0


def test_recover_interrupted_run_requeues_with_attempt_remaining(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "state/benchmark.db")
    store.initialize()
    suites = load_suites()
    request = RunRequest(
        qwen_ref="HEAD",
        suite="swebench_verified_gold_smoke",
        trigger="manual",
    )
    run, _ = store.create_run(request, suites[request.suite], "worker-recovery")
    claimed = store.claim_run()
    assert claimed is not None
    store.transition(run["run_id"], "GRADING")
    store.update_instance(run["run_id"], "sympy__sympy-20590", "RUNNING")

    assert store.recover_interrupted_runs() == [run["run_id"]]
    recovered = store.get_run(run["run_id"])
    assert recovered is not None
    assert recovered["status"] == "QUEUED"
    assert recovered["attempt_count"] == 1
    instance = store.get_instances(run["run_id"])[0]
    assert instance["status"] == "PENDING"
