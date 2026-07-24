from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .artifacts import Artifacts
from .config import Settings, Suite


class InfrastructureError(RuntimeError):
    pass


class AgentError(RuntimeError):
    pass


@dataclass(frozen=True)
class RunResult:
    completed: int
    resolved: int
    resolved_ids: list[str]
    unresolved_ids: list[str]
    error_ids: list[str]
    report_path: Path


class SwebenchRunner:
    def __init__(
        self,
        settings: Settings,
        heartbeat: Callable[[], None],
    ):
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
            fetch = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.settings.qwen_repo),
                    "fetch",
                    "--tags",
                    "origin",
                    qwen_ref,
                ],
                text=True,
                capture_output=True,
            )
            if fetch.returncode != 0:
                raise InfrastructureError(fetch.stderr.strip() or "git fetch failed")
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
            raise AgentError(result.stderr.strip() or "qwen ref not found")
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
        work_dir = self.settings.work_root / run_id
        work_dir.mkdir(parents=True, exist_ok=True)
        predictions: Path | str = "gold"
        if suite["runner_mode"] == "qwen":
            predictions = self._run_qwen(
                run_id, qwen_commit, suite, work_dir, artifacts
            )
        if on_grading:
            on_grading()
        return self._grade(run_id, suite, work_dir, predictions, artifacts)

    def _run_qwen(
        self,
        run_id: str,
        qwen_commit: str,
        suite: Suite,
        work_dir: Path,
        artifacts: Artifacts,
    ) -> Path:
        if not os.environ.get("OPENAI_API_KEY"):
            raise AgentError("OPENAI_API_KEY is not configured")

        try:
            from datasets import load_dataset
        except ImportError as error:
            raise InfrastructureError("datasets package is not installed") from error

        qwen_source = work_dir / "qwen-code"
        self._command(
            [
                "git",
                "-C",
                str(self.settings.qwen_repo),
                "worktree",
                "add",
                "--detach",
                str(qwen_source),
                qwen_commit,
            ],
            work_dir,
            work_dir / "prepare-qwen.log",
            300,
        )
        self._command(
            ["npm", "ci", "--no-audit", "--progress=false"],
            qwen_source,
            work_dir / "npm-ci.log",
            1200,
        )
        self._command(
            ["npm", "run", "build"],
            qwen_source,
            work_dir / "qwen-build.log",
            1200,
        )

        dataset = load_dataset(
            suite["dataset"],
            split="test",
            revision=suite["dataset_revision"],
        )
        by_id = {item["instance_id"]: item for item in dataset}
        predictions: list[dict[str, str]] = []

        for instance_id in suite["instance_ids"]:
            instance = by_id.get(instance_id)
            if not instance:
                raise InfrastructureError(f"dataset instance missing: {instance_id}")
            repository = work_dir / "repositories" / instance_id
            repository.parent.mkdir(parents=True, exist_ok=True)
            self._command(
                [
                    "git",
                    "clone",
                    "--quiet",
                    f"https://github.com/{instance['repo']}.git",
                    str(repository),
                ],
                work_dir,
                work_dir / f"{instance_id}-clone.log",
                900,
            )
            self._command(
                ["git", "checkout", "--quiet", instance["base_commit"]],
                repository,
                work_dir / f"{instance_id}-checkout.log",
                120,
            )
            prompt = (
                "Solve the following GitHub issue in this repository. "
                "Modify the working tree, run focused tests when practical, "
                "and do not commit the changes.\n\n" + instance["problem_statement"]
            )
            self._command(
                [
                    "node",
                    str(qwen_source / "scripts/cli-entry.js"),
                    "-y",
                    "--prompt",
                    prompt,
                ],
                repository,
                work_dir / f"{instance_id}-agent.log",
                suite["instance_timeout_seconds"],
                AgentError,
            )
            subprocess.run(["git", "add", "-N", "."], cwd=repository, check=False)
            patch = subprocess.run(
                ["git", "diff", "--binary"],
                cwd=repository,
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            patch_path = work_dir / f"{instance_id}.patch"
            patch_path.write_text(patch, encoding="utf-8")
            artifacts.copy(patch_path, f"instances/{instance_id}/patch.diff")
            artifacts.copy(
                work_dir / f"{instance_id}-agent.log",
                f"instances/{instance_id}/agent.log",
            )
            predictions.append(
                {
                    "instance_id": instance_id,
                    "model_name_or_path": f"qwen-code@{qwen_commit}",
                    "model_patch": patch,
                }
            )

        predictions_path = work_dir / "predictions.jsonl"
        predictions_path.write_text(
            "".join(json.dumps(item) + "\n" for item in predictions),
            encoding="utf-8",
        )
        artifacts.copy(predictions_path, "predictions.jsonl")
        return predictions_path

    def _grade(
        self,
        run_id: str,
        suite: Suite,
        work_dir: Path,
        predictions: Path | str,
        artifacts: Artifacts,
    ) -> RunResult:
        command = [
            str(self.settings.swebench_python),
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            suite["dataset"],
            "--predictions_path",
            str(predictions),
            "--max_workers",
            str(suite["grader_concurrency"]),
            "--run_id",
            run_id,
            "--cache_level",
            "env",
            "--instance_ids",
            *suite["instance_ids"],
        ]
        self._command(
            command,
            work_dir,
            work_dir / "grader.log",
            max(suite["instance_timeout_seconds"] * len(suite["instance_ids"]), 600),
        )
        reports = sorted(work_dir.glob(f"*.{run_id}.json"))
        if len(reports) != 1:
            raise InfrastructureError(
                f"expected one grader report for {run_id}, found {len(reports)}"
            )
        report_path = reports[0]
        report = json.loads(report_path.read_text(encoding="utf-8"))
        artifacts.copy(report_path, "grader/evaluation-report.json")
        artifacts.copy(work_dir / "grader.log", "grader/grader.log")
        artifacts.copy_tree(
            work_dir / "logs/run_evaluation" / run_id,
            "grader/run_evaluation",
        )
        return RunResult(
            completed=int(report["completed_instances"]),
            resolved=int(report["resolved_instances"]),
            resolved_ids=list(report["resolved_ids"]),
            unresolved_ids=list(report["unresolved_ids"]),
            error_ids=list(report["error_ids"]),
            report_path=report_path,
        )

    def _command(
        self,
        command: list[str],
        cwd: Path,
        log_path: Path,
        timeout_seconds: int,
        failure_type: type[RuntimeError] = InfrastructureError,
    ) -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=os.environ.copy(),
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
                    raise failure_type(f"command timed out: {command[0]}")
                self.heartbeat()
                time.sleep(5)
            if process.returncode != 0:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
                raise failure_type(
                    f"command failed ({process.returncode}): {' '.join(command[:4])}\n{tail}"
                )
