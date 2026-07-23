from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings


START_MARKER = "<!-- qwen-code-benchmark:start -->"
END_MARKER = "<!-- qwen-code-benchmark:end -->"
LEGACY_MARKER = "<!-- qwen-code-benchmark -->"


def publish_release(
    settings: Settings,
    run: dict[str, Any],
    summary: dict[str, Any],
) -> str:
    if not settings.github_token:
        return "SKIPPED"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {settings.github_token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    release_id = json.loads(run["request_json"]).get("release_id")
    if not release_id:
        return "SKIPPED"
    _update_release_body(settings, run, summary, headers, int(release_id))
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
    release = response.json()
    if release.get("tag_name") != run["qwen_ref"]:
        raise ValueError("release tag does not match the benchmarked Qwen Code ref")
    request = json.loads(run["request_json"])
    if request.get("trigger") == "workflow_dispatch" and not release.get(
        "prerelease"
    ):
        raise ValueError("manual benchmark publication requires a prerelease")

    existing_body = release.get("body") or ""
    section = (
        _release_section(START_MARKER, summary, run["status"] == "SUCCEEDED")
        + END_MARKER
    )
    if START_MARKER in existing_body and END_MARKER in existing_body:
        prefix, remainder = existing_body.split(START_MARKER, 1)
        _, suffix = remainder.split(END_MARKER, 1)
        body = prefix.rstrip() + "\n\n" + section + suffix
    elif LEGACY_MARKER in existing_body:
        body = (
            existing_body.split(LEGACY_MARKER, 1)[0].rstrip() + "\n\n" + section
        )
    else:
        body = existing_body.rstrip() + "\n\n" + section
    patch = httpx.patch(url, headers=headers, json={"body": body}, timeout=30)
    patch.raise_for_status()


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
