# PR #7975 — local verification assets

Screenshots and reproducible harnesses for the maintainer verification round on
[#7975](https://github.com/QwenLM/qwen-code/pull/7975).

Verified head: `9ea71220d432237dcbeda9851aca907c3dc8c012`
Base: `97aaa3808d1e198069e5f4005821f2581afd5464`

## Screenshots

| File                                            | Shows                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `01-writer-lease-ab-base-vs-head.png`           | delete / archive / unarchive against a live foreign writer lease    |
| `02-runtime-isolation-decoy-base-vs-head.png`   | workspace-qualified maintenance vs a primary-runtime decoy          |
| `03-shutdown-drain-503-daemon-draining.png`     | SIGTERM during an admitted maintenance batch                        |
| `04-mutation-matrix-and-assertion-totals.png`   | mutation matrix over the PR's new guards, plus assertion totals     |

## Harnesses

Each harness starts a real `qwen serve` daemon from a built tree, plants real
transcripts under real runtime roots, and drives the real HTTP routes. Nothing
about the daemon or the writer-lease protocol is mocked.

```bash
# one arm = one built worktree (npm install && npm run build in each)
node harness/ab-writer-lease.mjs      head <tree> logs/head.json
node harness/ab-writer-lease.mjs      base <tree> logs/base.json
node harness/assert-writer-lease.mjs  logs/head.json logs/base.json out.json

node harness/ab-runtime-isolation.mjs head <tree> logs/iso-head.json
node harness/ab-shutdown-drain.mjs    head <tree> logs/drain-head.json

bash harness/mutate.sh <pr-head-tree> logs/mutation-matrix.txt
```

`harness/logs/` holds the raw captured results behind every number in the report.
Absolute paths in those logs were replaced with `<PR-HEAD-TREE>`, `<BASE-TREE>`,
`<SCRATCH>` and `<TMP>` placeholders.
