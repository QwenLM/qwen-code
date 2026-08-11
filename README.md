# PR #8765 local verification evidence

Screenshots produced while verifying https://github.com/QwenLM/qwen-code/pull/8765
in a real ubuntu-24.04 / node 22.x container (the qwen-autofix workflow's runner
and node pin).

- `01-environment-and-suite.png` — environment, gate-script hash, targeted suite
- `02-verdict-matrix-pr-vs-main.png` — gate verdicts, PR head vs current main
- `03-real-gate-run-preexisting.png` — a real run of the gate script
- `04-mutation-testing.png` — mutation results against current main
