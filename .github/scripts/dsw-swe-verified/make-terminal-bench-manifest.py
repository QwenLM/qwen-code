#!/usr/bin/env python3
"""Build a frozen Terminal-Bench task manifest from the versioned ACR cache."""
from __future__ import annotations

import argparse
import json
import re
import tarfile
from pathlib import PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

task_names: set[str] = set()
with tarfile.open(args.archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        parts = PurePosixPath(member.name).parts
        if (
            len(parts) >= 4
            and parts[0] == "tasks"
            and parts[1] != "packages"
            and parts[-1] == "instruction.md"
        ):
            task_names.add(parts[-2])
if len(task_names) != 89:
    raise SystemExit(f"expected 89 Terminal-Bench 2.0 tasks, found {len(task_names)}")
payload = {
    "schema_version": "qwen-code-terminal-bench-2.0-manifest/v1",
    "dataset": "terminal-bench",
    "dataset_revision": "2.0",
    "instance_ids": sorted(task_names),
}
with open(args.output, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, indent=2)
    stream.write("\n")