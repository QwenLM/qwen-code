# PR #9228 — local real-environment verification evidence

Screenshots and raw evidence for the verification comment on
https://github.com/QwenLM/qwen-code/pull/9228

* `01-pin-and-mutations.png` — the repo's own pin test at the PR head + an
  11-case mutation matrix against the pin.
* `02-replay-verdict.png` — three consecutive jobs on one reusable self-hosted
  workspace: post-wipe state, bytes pulled from "github.com", the trade-off,
  and the wipe-script edge cases.
* `03-slowlink-and-recovery.png` — the same job 3 with the git server throttled
  to the pool's 750 kB/s, damaged-`.git` recovery, and the tree-identity check.

`harness/` is the harness itself (Ubuntu 24.04 container, real
`actions/checkout@df4cb1c` v6.0.3, a real 1.1 GB mirror of this repository
served over git smart-HTTP with per-request byte accounting, and the wipe steps
extracted verbatim from each arm's `serve-ab.yml`).

`results/` is what it produced: per-request ledgers, workspace snapshots,
driver logs, and the edge/resilience/integrity tables.
