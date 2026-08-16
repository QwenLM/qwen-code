#!/usr/bin/env python3
"""Job-3 wall clock with the git server throttled to the ECS pool's link speed."""
import json
import os
import re

EV = os.environ.get("EV","/Users/wenshao/pr9228-verify/evidence/container")
B = "\033[1m"; R = "\033[31m"; G = "\033[32m"; N = "\033[0m"; D = "\033[90m"; Y = "\033[33m"
POOL_HISTORY_MB = 890  # the PR's measured re-download on the real pool


def job3(arm):
    rows = [json.loads(l) for l in open(os.path.join(EV, f"{arm}-slowlink", "ledger.jsonl")) if l.strip()]
    s = e = None
    for r in rows:
        if r.get("kind") == "mark" and r["label"] == "job3:start":
            s = r["t"]
        if r.get("kind") == "mark" and r["label"] == "job3:end":
            e = r["t"]
    sel = [r for r in rows if r.get("kind") == "req" and s <= r["t"] <= e]
    by = sum(r["respBytes"] for r in sel)
    return by, (e - s) / 1000.0


def mmss(sec):
    return f"{int(sec // 60)}m{sec % 60:04.1f}s"


print(f"{B}Job 3 with the git server throttled to 750 kB/s — the ECS pool link speed in the description{N}")
print(f"{D}(jobs 1-2 always run at local disk speed; only the phase under measurement is throttled){N}")
print()
res = {}
for arm, name, col in (("base", "base (main)   ", R), ("head", "head (this PR)", G)):
    by, sec = job3(arm)
    res[arm] = (by, sec)
    print(f"   {col}{name}{N}  job 3 checkout: {col}{mmss(sec):>9}{N}   "
          f"{by/1048576:8.1f} MB on the wire   ({by/sec/1000:.0f} kB/s effective)")
print()
b, h = res["base"][1], res["head"][1]
print(f"   {G}→ {b - h:.0f} s of runner time given back, every time serve-ab runs before a "
      f"depth-0 job{N}")
scale = POOL_HISTORY_MB / (res["base"][0] / 1048576)
print(f"   {D}fixture = {res['base'][0]/1048576:.0f} MB; scaled to the pool's {POOL_HISTORY_MB} MB "
      f"-> {mmss(b*scale)} (description measured 19m45s){N}")
