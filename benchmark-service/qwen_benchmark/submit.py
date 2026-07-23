from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from typing import Any

from pydantic import ValidationError

from .config import Settings, load_suites
from .models import RunRequest
from .store import Store


def submit_run(
    settings: Settings,
    request: RunRequest,
    idempotency_key: str,
) -> dict[str, Any]:
    if request.repository != settings.allowed_repository:
        raise ValueError(f"repository is not allowed: {request.repository}")
    if not 1 <= len(idempotency_key) <= 255:
        raise ValueError("idempotency key must contain 1 to 255 characters")

    suites = load_suites()
    suite = suites.get(request.suite)
    if not suite:
        raise ValueError(f"suite is not allowlisted: {request.suite}")

    store = Store(settings.database_path)
    store.initialize()
    row, deduplicated = store.create_run(request, suite, idempotency_key)
    return {
        "run_id": row["run_id"],
        "status": row["status"],
        "deduplicated": deduplicated,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Submit a Qwen Code benchmark directly to the local SQLite store."
    )
    parser.add_argument("--repository", default="QwenLM/qwen-code")
    parser.add_argument("--qwen-ref", required=True)
    parser.add_argument("--qwen-commit")
    parser.add_argument("--suite", required=True)
    parser.add_argument(
        "--trigger",
        choices=("release", "workflow_dispatch", "manual"),
        required=True,
    )
    parser.add_argument("--release-id", type=int)
    parser.add_argument("--github-run-id", type=int)
    parser.add_argument("--github-run-attempt", type=int)
    parser.add_argument("--idempotency-key")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.idempotency_key:
        idempotency_key = args.idempotency_key
    elif args.github_run_id is not None and args.github_run_attempt is not None:
        idempotency_key = (
            f"{args.repository}:{args.github_run_id}:{args.github_run_attempt}"
        )
    else:
        parser.error(
            "provide --idempotency-key or both --github-run-id and "
            "--github-run-attempt"
        )

    try:
        request = RunRequest(
            repository=args.repository,
            qwen_ref=args.qwen_ref,
            qwen_commit=args.qwen_commit,
            suite=args.suite,
            trigger=args.trigger,
            release_id=args.release_id,
            github_run_id=args.github_run_id,
            github_run_attempt=args.github_run_attempt,
        )
        result = submit_run(Settings.from_env(), request, idempotency_key)
    except (ValidationError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
