#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--limit", type=int, required=True)
    parser.add_argument("--instance-id")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    instance_ids = sorted(
        path.name
        for path in args.dataset_root.iterdir()
        if path.is_dir() and "__" in path.name
    )
    if len(instance_ids) != 500:
        raise SystemExit(
            f"Expected exactly 500 SWE-bench Verified instances, found {len(instance_ids)}"
        )
    if args.instance_id:
        if args.limit != 1:
            raise SystemExit("--instance-id requires --limit 1")
        if args.instance_id not in instance_ids:
            raise SystemExit(f"Unknown SWE-bench Verified instance: {args.instance_id}")
        selected = [args.instance_id]
    else:
        selected = instance_ids[: args.limit]
    if len(selected) != args.limit:
        raise SystemExit(f"Requested {args.limit} instances, found {len(selected)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "dataset": "swe-bench/swe-bench-verified",
                "dataset_revision": "2",
                "expected_instances": len(selected),
                "instance_ids": selected,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
