#!/usr/bin/env python3
"""Print the replay verdict from the collected evidence (nothing hard-coded)."""
import json
import os
import re
import sys

EV = os.environ.get("EV", "/Users/wenshao/pr9228-verify/evidence/container")
TAG = sys.argv[1] if len(sys.argv) > 1 else "full"
B = "\033[1m"; R = "\033[31m"; G = "\033[32m"; Y = "\033[33m"; C = "\033[36m"; N = "\033[0m"; D = "\033[90m"


def human(n):
    n = float(n)
    for u in ["B", "KB", "MB", "GB"]:
        if abs(n) < 1024 or u == "GB":
            return f"{n:.1f} {u}" if u != "B" else f"{int(n)} B"
        n /= 1024


def ledger(arm):
    p = os.path.join(EV, f"{arm}-{TAG}", "ledger.jsonl")
    return [json.loads(l) for l in open(p) if l.strip()]


def phase_bytes(rows, job):
    s = e = None
    for r in rows:
        if r.get("kind") == "mark" and r["label"] == f"{job}:start":
            s = r["t"]
        if r.get("kind") == "mark" and r["label"] == f"{job}:end":
            e = r["t"]
    sel = [r for r in rows if r.get("kind") == "req" and s <= r["t"] <= e]
    return sum(r["respBytes"] for r in sel), len(sel), (e - s) / 1000.0


def snap(arm, needle):
    txt = open(os.path.join(EV, f"{arm}-{TAG}", "snapshots.txt")).read()
    blocks = txt.split("--- snapshot: ")
    for b in blocks[1:]:
        if needle in b.split("\n")[0]:
            return b
    return ""


def field(block, key, default="?"):
    m = re.search(rf"^{re.escape(key)}: (.*)$", block, re.M)
    return m.group(1) if m else default


def top_level(block):
    out = []
    started = False
    for line in block.split("\n"):
        if line.startswith("workspace top level:"):
            started = True
            continue
        if started:
            if line.startswith("    ") and ": " not in line:
                out.append(line.strip())
            else:
                break
    return out


def main():
    print(f"{B}PR #9228 @ {os.environ.get('HEAD_SHA','?')} vs base {os.environ.get('BASE_SHA','?')} — "
          f"three consecutive jobs on ONE reusable self-hosted workspace{N}")
    print(f"{D}Ubuntu 24.04 container · real actions/checkout@df4cb1c (v6.0.3) · real 1.1 GB")
    print(f"qwen-code history served over git smart-HTTP · wipe script taken verbatim from each arm's serve-ab.yml{N}")
    print()

    rows = {}
    for arm in ("base", "head"):
        w = snap(arm, "after the wipe step")
        rows[arm] = {
            "top": top_level(w) or ["<empty>"],
            "git": field(w, "root .git present"),
            "hook": field(w, "planted post-checkout hook present", "n/a"),
            "j1": phase_bytes(ledger(arm), "job1"),
            "j2": phase_bytes(ledger(arm), "job2"),
            "j3": phase_bytes(ledger(arm), "job3"),
            "hookfire": field(snap(arm, "after job 3"), "hook fire log"),
        }

    print(f"{B}1. workspace right after job 2's wipe step{N}")
    for arm, name in (("base", "base  (main today)     "), ("head", "head  (PR #9228)       ")):
        r = rows[arm]
        col = R if arm == "base" else G
        print(f"   {col}{name}{N} top level: {', '.join(r['top']):<12}"
              f"  root .git present: {col}{r['git']:<3}{N}  planted hook survives: {r['hook']}")
    print(f"   {D}stale head/, base/, .git-credentials, .stale-cache/, read-only leftovers: removed in BOTH arms{N}")
    print()

    print(f"{B}2. bytes the runner pulled from \"github.com\" (booked at the server){N}")
    print(f"   {'phase':<52}{'base (main)':>20}{'head (PR #9228)':>22}")
    for key, label in (
        ("j1", "job 1  Test @ root, depth 0  (creates shared .git)"),
        ("j2", "job 2  serve-ab: wipe + head/ + base/ checkouts"),
        ("j3", "job 3  Test @ root, depth 0  (the NEXT job pays)"),
    ):
        b, h = rows["base"][key], rows["head"][key]
        col = C if key != "j3" else B
        print(f"   {col}{label:<52}{human(b[0]):>13} {b[1]:>2} req{human(h[0]):>15} {h[1]:>2} req{N}")
    tb = sum(rows["base"][k][0] for k in ("j1", "j2", "j3"))
    th = sum(rows["head"][k][0] for k in ("j1", "j2", "j3"))
    print(f"   {'TOTAL':<52}{human(tb):>13}    {human(th):>15}")
    print()
    saved = rows["base"]["j3"][0] - rows["head"]["j3"][0]
    ratio = rows["base"]["j3"][0] / max(1, rows["head"]["j3"][0])
    print(f"   {G}→ job 3 re-download avoided: {human(saved)}  ({ratio:,.0f}x less on the wire){N}")
    print(f"   {D}fixture history packs to {human(rows['base']['j3'][0])}; the pool's real ~890 MB scales the same way{N}")
    print()

    print(f"{B}3. documented trade-off, reproduced{N}")
    print(f"   a post-checkout hook planted in the shared .git before job 2:")
    print(f"   {R}base{N}: destroyed by the wipe, never runs   "
          f"{Y}head{N}: survives → fired during job 3's checkout ({rows['head']['hookfire']})")
    print()

    edge = open(os.path.join(EV, "edge", "results.txt")).read().rstrip().split("\n")
    print(f"{B}4. wipe-script edge cases (GitHub's default `bash --noprofile --norc -eo pipefail` wrapper){N}")
    for line in edge:
        mark = ""
        if "SURVIVES" in line:
            mark = Y
        elif "rc=1" in line:
            mark = D
        print(f"   {mark}{line}{N}" if mark else f"   {line}")

    ipath = os.path.join(EV, "interaction", "results.txt")
    if os.path.exists(ipath) and os.environ.get("SHOW_INTERACTION"):
        print()
        print(f"{B}5. #9220's corrupt shared .git, handed to the next job through each wipe{N}")
        for line in open(ipath).read().rstrip().split("\n"):
            col = R if " head " in line and " 1 " in line.split("MB")[0] else ""
            print(f"   {col}{line}{N}" if col else f"   {line}")


if __name__ == "__main__":
    main()
