#!/usr/bin/env python3
"""Turn the git-server ledgers into the per-job wire cost of each arm."""
import json
import os
import sys

EV = sys.argv[1] if len(sys.argv) > 1 else "/Users/wenshao/pr9228-verify/evidence/container"
TAG = sys.argv[2] if len(sys.argv) > 2 else "full"
JOBS = ["job1", "job2", "job3"]


def load(arm):
    path = os.path.join(EV, f"{arm}-{TAG}", "ledger.jsonl")
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def spans(rows):
    """Map job -> (start_ms, end_ms) from the driver's marks."""
    out = {}
    for r in rows:
        if r.get("kind") != "mark":
            continue
        for j in JOBS:
            if r["label"] == f"{j}:start":
                out.setdefault(j, [None, None])[0] = r["t"]
            if r["label"] == f"{j}:end":
                out.setdefault(j, [None, None])[1] = r["t"]
    return out


def human(n):
    for unit in ["B", "KB", "MB", "GB"]:
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


def report(arm):
    rows = load(arm)
    sp = spans(rows)
    reqs = [r for r in rows if r.get("kind") == "req"]
    res = {}
    for j in JOBS:
        s, e = sp.get(j, (None, None))
        sel = [r for r in reqs if s is not None and e is not None and s <= r["t"] <= e]
        res[j] = {
            "requests": len(sel),
            "bytes": sum(r["respBytes"] for r in sel),
            "up": sum(r["reqBytes"] for r in sel),
            "wall_s": (e - s) / 1000.0 if s and e else 0.0,
        }
    res["total"] = {
        "requests": len(reqs),
        "bytes": sum(r["respBytes"] for r in reqs),
        "up": sum(r["reqBytes"] for r in reqs),
        "wall_s": sum(v["wall_s"] for k, v in res.items() if k in JOBS),
    }
    return res


def main():
    arms = {a: report(a) for a in ("base", "head")}
    label = {
        "job1": "job 1  Test @ root, depth 0 (creates the shared .git)",
        "job2": "job 2  serve-ab: wipe + head/ + base/ checkouts",
        "job3": "job 3  Test @ root, depth 0 (the NEXT job pays here)",
        "total": "TOTAL  bytes this runner pulled from github.com",
    }
    w = 52
    print(f"{'phase':<{w}} {'base (main)':>22} {'head (PR 9228)':>22}")
    print("-" * (w + 46))
    for j in JOBS + ["total"]:
        b, h = arms["base"][j], arms["head"][j]
        print(
            f"{label[j]:<{w}} {human(b['bytes']):>12} {b['requests']:>4} req "
            f"{human(h['bytes']):>12} {h['requests']:>4} req"
        )
    print("-" * (w + 46))
    saved = arms["base"]["job3"]["bytes"] - arms["head"]["job3"]["bytes"]
    ratio = (
        arms["base"]["job3"]["bytes"] / max(1, arms["head"]["job3"]["bytes"])
    )
    print(f"job 3 re-download avoided by PR 9228: {human(saved)}  ({ratio:.0f}x less)")
    for rate, name in ((750_000, "0.75 MB/s (the pool link measured in the PR)"),
                       (300_000, "0.30 MB/s (pool worst case)"),
                       (1_100_000, "1.10 MB/s (pool best case)")):
        tb = arms["base"]["job3"]["bytes"] / rate
        th = arms["head"]["job3"]["bytes"] / rate
        print(
            f"  at {name:<44} job 3 transfer: base {tb/60:6.1f} min  vs  head {th/60:6.2f} min"
        )
    with open(os.path.join(EV, "wire-cost.json"), "w") as f:
        json.dump(arms, f, indent=2)


if __name__ == "__main__":
    main()
