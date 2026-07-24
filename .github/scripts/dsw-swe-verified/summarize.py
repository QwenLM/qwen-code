#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row


def json_default(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--status-override")
    parser.add_argument("--executor-count", type=int, required=True)
    parser.add_argument("--execution-mode", choices=("harbor", "synthetic"), required=True)
    parser.add_argument("--trigger", required=True)
    parser.add_argument("--github-run-url", default="")
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--output-markdown", type=Path, required=True)
    args = parser.parse_args()

    with psycopg.connect(args.database_url, row_factory=dict_row) as connection:
        run = connection.execute(
            "SELECT * FROM pool_runs WHERE run_id = %s", (args.run_id,)
        ).fetchone()
        tasks = connection.execute(
            """
            SELECT instance_id, state, attempt_count
            FROM pool_tasks
            WHERE run_id = %s
            ORDER BY instance_id
            """,
            (args.run_id,),
        ).fetchall()
    if run is None:
        raise SystemExit(f"Unknown run: {args.run_id}")

    status = args.status_override or run["status"]
    expected = int(run["expected_instances"])
    resolved = int(run["resolved_instances"])
    publish_score = (
        args.execution_mode == "harbor"
        and status == "SUCCEEDED"
        and len(tasks) == expected
    )
    score = round(resolved * 100.0 / expected, 2) if publish_score else None
    result = {
        "schema_version": "qwen-code-dsw-swe-verified/v1",
        "status": status,
        "dataset": run["dataset"],
        "dataset_revision": run["dataset_revision"],
        "suite": run["suite"],
        "qwen_ref": run["qwen_ref"],
        "qwen_commit": run["qwen_commit"],
        "qwen_version": run["qwen_version"],
        "model": run["model"],
        "trigger": args.trigger,
        "github_run_url": args.github_run_url,
        "run_id": run["run_id"],
        "executor_count": args.executor_count,
        "execution_mode": args.execution_mode,
        "expected_instances": expected,
        "completed_instances": int(run["completed_instances"]),
        "resolved_instances": resolved,
        "unresolved_instances": int(run["unresolved_instances"]),
        "execution_error_instances": int(run["execution_error_instances"]),
        "infra_failed_instances": int(run["infra_failed_instances"]),
        "score_percent": score,
        "started_at": run["started_at"],
        "finished_at": run["finished_at"],
        "instances": [
            {
                "instance_id": task["instance_id"],
                "state": task["state"],
                "attempt_count": task["attempt_count"],
            }
            for task in tasks
        ],
    }

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(result, indent=2, default=json_default) + "\n",
        encoding="utf-8",
    )

    lines = [
        "### SWE-bench Verified",
        "",
        f"- Status: **{status}**",
        f"- Qwen Code: `{run['qwen_ref']}` (`{run['qwen_commit']}`)",
        f"- Dataset: `SWE-bench Verified@{run['dataset_revision']}` ({expected} instances)",
        f"- Execution: {args.executor_count} concurrent DSW executors",
        (
            "- Result: "
            f"{resolved} resolved / {int(run['unresolved_instances'])} unresolved / "
            f"{int(run['execution_error_instances'])} execution errors / "
            f"{int(run['infra_failed_instances'])} infrastructure failures"
        ),
    ]
    if args.execution_mode != "harbor":
        lines.append("- Score: not published for synthetic infrastructure validation")
    elif publish_score:
        lines.append(f"- Score: **{score:.2f}%**")
    else:
        lines.append("- Score: not published because the run did not pass the completion gate")
    if args.github_run_url:
        lines.append(f"- Workflow: {args.github_run_url}")
    args.output_markdown.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
