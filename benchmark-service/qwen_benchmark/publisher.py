from __future__ import annotations

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
    conclusion = "success" if run["status"] == "SUCCEEDED" else "failure"
    response = httpx.post(
        f"https://api.github.com/repos/{run['repository']}/check-runs",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {settings.github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
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
