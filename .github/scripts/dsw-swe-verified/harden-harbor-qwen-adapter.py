#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prevent Harbor from expanding OPENAI_API_KEY into qwen argv"
    )
    parser.add_argument("adapter", type=Path)
    args = parser.parse_args()

    text = args.adapter.read_text(encoding="utf-8")
    unsafe = '                    \'--openai-api-key "$OPENAI_API_KEY" \'\n'
    if unsafe in text:
        if text.count(unsafe) != 1:
            raise SystemExit("Refusing to patch an unexpected Harbor adapter layout")
        args.adapter.write_text(text.replace(unsafe, ""), encoding="utf-8")
        state = "patched"
    elif "--openai-api-key" in text:
        raise SystemExit(
            "Harbor adapter still contains an unknown --openai-api-key invocation"
        )
    else:
        state = "already-safe"

    digest = hashlib.sha256(args.adapter.read_bytes()).hexdigest()
    print(f"Harbor Qwen adapter: {state}; sha256={digest}")


if __name__ == "__main__":
    main()
