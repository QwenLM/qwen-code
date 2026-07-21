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
    conclusion = "success" if run["status"] == "SUCCEEDED" else "failure"
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
                "title": f"{summary['resolved_instances']} / {summary['expected_instances']} resolved",
                "summary": (
                    f"Run `{run['run_id']}` completed with "
                    f"{summary['resolved_instances']} resolved instances and "
                    f"{summary['error_instances']} infrastructure errors."
                ),
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
    section = "\n".join(
        [
            marker,
            "## Qwen Code benchmark",
            "",
            f"- Suite: `{summary['suite']}`",
            f"- Qwen Code version: `{summary['qwen_version']}`",
            f"- Commit: `{summary['qwen_commit']}`",
            f"- Result: **{summary['resolved_instances']} / {summary['expected_instances']} resolved**",
            f"- Run ID: `{summary['run_id']}`",
            "",
        ]
    )
    if marker in existing_body:
        body = existing_body.split(marker, 1)[0].rstrip() + "\n\n" + section
    else:
        body = existing_body.rstrip() + "\n\n" + section
    patch = httpx.patch(url, headers=headers, json={"body": body}, timeout=30)
    patch.raise_for_status()
