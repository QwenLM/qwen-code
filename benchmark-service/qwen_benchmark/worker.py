from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from .artifacts import Artifacts
from .config import Settings, Suite, load_suites
from .harbor_runner import HarborRunner, qwen_version_from_ref
from .publisher import publish_check
from .runner import AgentError, InfrastructureError, RunResult, SwebenchRunner
from .store import Store


LOGGER = logging.getLogger(__name__)


class Worker:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        suites: dict[str, Suite],
        runner_factory: Callable[[Callable[[], None]], SwebenchRunner] | None = None,
    ):
        self.settings = settings
        self.store = store
        self.suites = suites
        self.runner_factory = runner_factory

    def _heartbeat(self, run_id: str) -> None:
        try:
            self.store.heartbeat(run_id)
        except Exception:
            # State storage must not terminate an in-flight agent or verifier.
            # The next heartbeat/final transition can reconcile the run once the
            # transient SQLite/filesystem problem clears.
            LOGGER.exception(
                "heartbeat unavailable for %s; benchmark continues", run_id
            )

    def run_once(self) -> bool:
        run = self.store.claim_run()
        if not run:
            return False
        run_id = run["run_id"]
        suite = self.suites[run["suite"]]
        artifacts = Artifacts(self.settings.artifact_root, run_id)
        request = json.loads(run["request_json"])
        instances = self.store.get_instances(run_id)
        artifacts.write_json("request.json", request)
        artifacts.write_json(
            "manifest.json",
            {
                "run_id": run_id,
                "qwen_ref": run["qwen_ref"],
                "qwen_commit": request.get("qwen_commit"),
                "qwen_version": (
                    qwen_version_from_ref(run["qwen_ref"])
                    if suite["runner_mode"] == "harbor"
                    else None
                ),
                "dataset": suite["dataset"],
                "dataset_revision": suite["dataset_revision"],
                "instance_ids": suite["instance_ids"],
                "runner_mode": suite["runner_mode"],
            },
        )
        self._write_status(artifacts, run_id)

        if self.runner_factory:
            runner = self.runner_factory(lambda: self._heartbeat(run_id))
        elif suite["runner_mode"] == "harbor":
            runner = HarborRunner(self.settings, lambda: self._heartbeat(run_id))
        else:
            runner = SwebenchRunner(self.settings, lambda: self._heartbeat(run_id))
        try:
            request_commit = request.get("qwen_commit")
            qwen_commit = request_commit or runner.resolve_qwen_commit(
                run["qwen_ref"]
            )
            self.store.transition(run_id, "RUNNING_AGENT", qwen_commit=qwen_commit)
            for instance in instances:
                self.store.update_instance(run_id, instance["instance_id"], "RUNNING")
            self._write_status(artifacts, run_id)

            result = runner.run(
                run_id,
                qwen_commit,
                suite,
                artifacts,
                on_grading=lambda: self._start_grading(artifacts, run_id),
                qwen_ref=run["qwen_ref"],
            )
            if result.completed != len(suite["instance_ids"]):
                raise InfrastructureError(
                    "grader did not complete every manifest instance"
                )
            if result.error_ids:
                raise InfrastructureError(
                    f"grader returned error instances: {result.error_ids}"
                )
            self._record_result(run_id, suite, result)

            self.store.transition(
                run_id,
                "UPLOADING",
                completed_instances=result.completed,
                resolved_instances=result.resolved,
            )
            summary = self._summary(run_id, result)
            artifacts.write_json("summary.json", summary)
            self.store.transition(
                run_id,
                "SUCCEEDED",
                completed_instances=result.completed,
                resolved_instances=result.resolved,
            )
            self._write_status(artifacts, run_id)
            artifacts.write_checksums()
            self._publish(artifacts, run_id, summary)
        except AgentError as error:
            LOGGER.exception("agent failed for %s", run_id)
            for instance in self.store.get_instances(run_id):
                if instance["status"] == "RUNNING":
                    self.store.update_instance(
                        run_id, instance["instance_id"], "AGENT_FAILED", str(error)
                    )
            self.store.transition(run_id, "FAILED", error=str(error))
            artifacts.write_json("error.json", {"class": "agent", "error": str(error)})
            self._write_status(artifacts, run_id)
            self._publish(artifacts, run_id, self._failed_summary(run_id))
        except InfrastructureError as error:
            LOGGER.exception("infrastructure failed for %s", run_id)
            status = self.store.requeue_or_fail(run_id, str(error))
            if status == "FAILED":
                for instance in self.store.get_instances(run_id):
                    if instance["status"] == "RUNNING":
                        self.store.update_instance(
                            run_id,
                            instance["instance_id"],
                            "INFRA_FAILED",
                            str(error),
                        )
            artifacts.write_json(
                "error.json", {"class": "infrastructure", "error": str(error)}
            )
            self._write_status(artifacts, run_id)
            if status == "FAILED":
                self._publish(artifacts, run_id, self._failed_summary(run_id))
        except Exception as error:
            LOGGER.exception("unexpected worker failure for %s", run_id)
            artifacts.write_json(
                "error.json", {"class": "unexpected", "error": str(error)}
            )
            try:
                self.store.transition(run_id, "FAILED", error=str(error))
                self._write_status(artifacts, run_id)
                self._publish(artifacts, run_id, self._failed_summary(run_id))
            except Exception:
                LOGGER.exception(
                    "could not persist failure state for %s; worker remains alive",
                    run_id,
                )
        return True

    def _start_grading(self, artifacts: Artifacts, run_id: str) -> None:
        try:
            self.store.transition(run_id, "GRADING")
            self._write_status(artifacts, run_id)
        except Exception:
            LOGGER.exception(
                "could not persist GRADING state for %s; benchmark continues", run_id
            )

    def _record_result(self, run_id: str, suite: Suite, result: RunResult) -> None:
        resolved = set(result.resolved_ids)
        unresolved = set(result.unresolved_ids)
        errors = set(result.error_ids)
        for instance_id in suite["instance_ids"]:
            if instance_id in resolved:
                status = "RESOLVED"
            elif instance_id in unresolved:
                status = "UNRESOLVED"
            elif instance_id in errors:
                status = "INFRA_FAILED"
            else:
                status = "INFRA_FAILED"
            self.store.update_instance(run_id, instance_id, status)

    def _summary(self, run_id: str, result: RunResult) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise RuntimeError(f"run disappeared: {run_id}")
        return {
            "run_id": run_id,
            "repository": run["repository"],
            "qwen_ref": run["qwen_ref"],
            "qwen_commit": run["qwen_commit"],
            "qwen_version": (
                qwen_version_from_ref(run["qwen_ref"])
                if run["runner_mode"] == "harbor"
                else None
            ),
            "suite": run["suite"],
            "dataset": run["dataset"],
            "dataset_revision": run["dataset_revision"],
            "runner_mode": run["runner_mode"],
            "expected_instances": run["expected_instances"],
            "completed_instances": result.completed,
            "resolved_instances": result.resolved,
            "unresolved_instances": len(result.unresolved_ids),
            "error_instances": len(result.error_ids),
            "resolved_ids": result.resolved_ids,
            "unresolved_ids": result.unresolved_ids,
            "error_ids": result.error_ids,
        }

    def _failed_summary(self, run_id: str) -> dict[str, Any]:
        run = self.store.get_run(run_id)
        if not run:
            raise RuntimeError(f"run disappeared: {run_id}")
        return {
            "run_id": run_id,
            "repository": run["repository"],
            "qwen_ref": run["qwen_ref"],
            "qwen_commit": run["qwen_commit"],
            "qwen_version": (
                qwen_version_from_ref(run["qwen_ref"])
                if run["runner_mode"] == "harbor"
                else None
            ),
            "suite": run["suite"],
            "dataset": run["dataset"],
            "dataset_revision": run["dataset_revision"],
            "runner_mode": run["runner_mode"],
            "expected_instances": run["expected_instances"],
            "completed_instances": run["completed_instances"],
            "resolved_instances": run["resolved_instances"],
            "unresolved_instances": 0,
            "error_instances": 0,
            "resolved_ids": [],
            "unresolved_ids": [],
            "error_ids": [],
        }

    def _publish(
        self, artifacts: Artifacts, run_id: str, summary: dict[str, Any]
    ) -> None:
        current = self.store.get_run(run_id)
        if not current:
            return
        try:
            publish_check(self.settings, current, summary)
        except Exception as error:
            LOGGER.exception("result publishing failed for %s", run_id)
            artifacts.write_json("publisher-error.json", {"error": str(error)})

    def _write_status(self, artifacts: Artifacts, run_id: str) -> None:
        run = self.store.get_run(run_id)
        if run:
            artifacts.write_json(
                "status.json",
                {
                    "run_id": run_id,
                    "status": run["status"],
                    "expected_instances": run["expected_instances"],
                    "completed_instances": run["completed_instances"],
                    "resolved_instances": run["resolved_instances"],
                    "heartbeat_at": run["heartbeat_at"],
                    "error": run["error"],
                },
            )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    settings.prepare_directories()
    store = Store(settings.database_path)
    store.initialize()
    recovered = store.recover_interrupted_runs()
    if recovered:
        LOGGER.warning("recovered interrupted benchmark runs: %s", recovered)
    worker = Worker(settings, store, load_suites())
    while True:
        if not worker.run_once():
            time.sleep(settings.poll_seconds)
