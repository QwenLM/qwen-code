#!/usr/bin/env python3
"""Display token usage stats from the last X request logs in ~/.qwen/logs."""

import argparse
import json
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(description="Show token stats from qwen request logs")
    p.add_argument("count", nargs="?", type=int, default=10, help="Number of recent logs to show (default: 10)")
    p.add_argument("--log-dir", default=Path.home() / ".qwen" / "logs", type=Path)
    return p.parse_args()


def load_logs(log_dir: Path, count: int):
    files = sorted(log_dir.glob("*.json"))
    for f in files[-count:]:
        try:
            with open(f) as fh:
                yield json.load(fh), f.name
        except (json.JSONDecodeError, OSError):
            continue


def main():
    args = parse_args()
    if not args.log_dir.is_dir():
        print(f"Log directory not found: {args.log_dir}")
        return

    rows = []
    total_input = total_cached = total_output = 0

    for data, fname in load_logs(args.log_dir, args.count):
        ts = data.get("timestamp", "?")
        model = data.get("request", {}).get("model", "?")
        usage = data.get("response", {}).get("usage", {})

        input_tok = usage.get("prompt_tokens", 0)
        output_tok = usage.get("completion_tokens", 0)
        cached_tok = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
        cache_rate = (cached_tok / input_tok * 100) if input_tok else 0

        total_input += input_tok
        total_cached += cached_tok
        total_output += output_tok

        rows.append((ts, model, input_tok, cached_tok, output_tok, cache_rate))

    if not rows:
        print("No logs found.")
        return

    # Print table
    hdr = f"{'Timestamp':<28} {'Model':<16} {'Input':>8} {'Cached':>8} {'Output':>8} {'Cache%':>7}"
    sep = "-" * len(hdr)
    print(hdr)
    print(sep)
    for ts, model, inp, cached, out, rate in rows:
        print(f"{ts:<28} {model:<16} {inp:>8,} {cached:>8,} {out:>8,} {rate:>6.1f}%")

    # Totals
    print(sep)
    overall_rate = (total_cached / total_input * 100) if total_input else 0
    print(f"{'TOTAL':<28} {'':<16} {total_input:>8,} {total_cached:>8,} {total_output:>8,} {overall_rate:>6.1f}%")


if __name__ == "__main__":
    main()
