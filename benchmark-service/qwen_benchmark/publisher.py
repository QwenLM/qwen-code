from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings


def publish_check(
    settings: Settings,
    run: dict[str, Any],
    summary: dict[str, Any],
) -> str:
    if not settings.github_token or not run.get("qwen_commit"):
        return "SKIPPED"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {settings.github_token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    succeeded = run["status"] == "SUCCEEDED"
    conclusion = "success" if succeeded else "failure"
    release_id = json.loads(run["request_json"]).get("release_id")
    if release_id:
        _update_release_body(settings, run, summary, headers, int(release_id))
    response = httpx.post(
        f"https://api.github.com/repos/{run['repository']}/check-runs",
        headers=headers,
        json={
            "name": f"Qwen Code Benchmark / {run['suite']}",
            "head_sha": run["qwen_commit"],
            "status": "completed",
            "conclusion": conclusion,
            "output": {
                "title": _check_title(summary, succeeded),
                "summary": _check_summary(summary, succeeded),
            },
        },
        timeout=30,
    )
    response.raise_for_status()
    return "PUBLISHED"


def _update_release_body(
    settings: Settings,
    run: dict[str, Any],
    summary: dict[str, Any],
    headers: dict[str, str],
    release_id: int,
) -> None:
    """Append a replaceable, public-safe benchmark summary to the Release."""
    url = f"https://api.github.com/repos/{run['repository']}/releases/{release_id}"
    response = httpx.get(url, headers=headers, timeout=30)
    response.raise_for_status()
    existing_body = response.json().get("body") or ""
    marker = "<!-- qwen-code-benchmark -->"
    section = _release_section(marker, summary, run["status"] == "SUCCEEDED")
    if marker in existing_body:
        body = existing_body.split(marker, 1)[0].rstrip() + "\n\n" + section
    else:
        body = existing_body.rstrip() + "\n\n" + section
    patch = httpx.patch(url, headers=headers, json={"body": body}, timeout=30)
    patch.raise_for_status()


def _check_title(summary: dict[str, Any], succeeded: bool) -> str:
    if not succeeded:
        return "Benchmark failed (not scored)"
    return (
        f"{_score(summary):.2f}% — "
        f"{summary['resolved_instances']} / {summary['expected_instances']} resolved"
    )


def _check_summary(summary: dict[str, Any], succeeded: bool) -> str:
    if not succeeded:
        return (
            f"Dataset: `{summary['dataset']}` at `{summary['dataset_revision']}`.\n\n"
            f"Execution: {summary['completed_instances']} / "
            f"{summary['expected_instances']} cases completed.\n\n"
            f"Run `{summary['run_id']}` failed before a valid score was available."
        )
    return (
        f"Dataset: `{summary['dataset']}` at `{summary['dataset_revision']}`.\n\n"
        f"Execution: {summary['completed_instances']} / "
        f"{summary['expected_instances']} cases completed; "
        f"{summary['resolved_instances']} resolved, "
        f"{summary['unresolved_instances']} unresolved, and "
        f"{summary['error_instances']} infrastructure errors.\n\n"
        f"Score: **{_score(summary):.2f}%**. Run `{summary['run_id']}`."
    )


def _release_section(marker: str, summary: dict[str, Any], succeeded: bool) -> str:
    version = summary["qwen_version"] or summary["qwen_ref"]
    commit = summary["qwen_commit"]
    commit_url = f"https://github.com/{summary['repository']}/commit/{commit}"
    lines = [
        marker,
        "## Qwen Code benchmark",
        "",
        "| Field | Result |",
        "| --- | --- |",
        f"| Status | **{'Completed' if succeeded else 'Failed — not scored'}** |",
        f"| Dataset | `{summary['dataset']}` at `{summary['dataset_revision']}` |",
        f"| Suite | `{summary['suite']}` |",
        f"| Evaluation | {_evaluation_method(summary['runner_mode'])} |",
        f"| Cases | {summary['completed_instances']} / {summary['expected_instances']} completed |",
    ]
    if succeeded:
        lines.extend(
            [
                "| Results | "
                f"{summary['resolved_instances']} resolved · "
                f"{summary['unresolved_instances']} unresolved · "
                f"{summary['error_instances']} infrastructure errors |",
                f"| Score | **{_score(summary):.2f}%** |",
            ]
        )
    else:
        lines.append("| Score | Not published |")
    lines.extend(
        [
            f"| Qwen Code | `{version}` · [`{commit[:7]}`]({commit_url}) |",
            f"| Run | `{summary['run_id']}` |",
            "",
        ]
    )
    return "\n".join(lines)


def _score(summary: dict[str, Any]) -> float:
    expected = int(summary["expected_instances"])
    if expected <= 0:
        return 0.0
    return int(summary["resolved_instances"]) * 100.0 / expected


def _evaluation_method(runner_mode: str) -> str:
    return {
        "harbor": "Qwen Code agent (Harbor)",
        "qwen": "Qwen Code agent (SWE-bench harness)",
        "gold": "Gold patch harness validation",
    }.get(runner_mode, runner_mode)
