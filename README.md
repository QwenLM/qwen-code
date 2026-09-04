# PR #9402 — local runtime validation assets

Screenshots produced while validating `feat: agent board` (#9402) on Linux with a
real build of the PR head (`7e998c2571`), driving the shipped `dist/cli.js`.

| file | what it shows |
| --- | --- |
| `fig1-two-agents.png` | two independently started shells sharing one board: task → claim → ask → answer → done |
| `fig2-ask-exit-codes.png` | `ask --wait` exit codes 0 / 2 / 3 / 4 |
| `fig3-claim-exclusivity-ab.png` | 12 concurrent `claim` processes; A/B with the guard removed from the shipped bundle |
| `fig4-prune-lock-race-ab.png` | prune vs. a record reopened while its item lock is held; A/B with a stale pre-lock read |
| `fig5-show-emfile.png` | `qwen board show` failing with EMFILE on a board that has merely accumulated items |
| `fig6-pull-visibility.png` | `show --as` hides unclaimed work; `--owner` is not binding |
| `fig7-mutation-matrix.png` | 18 mutants against the PR's own 41 tests |
| `fig8-storage-hardening.png` | name rejection, malformed foreign records, 0700/0600 modes, escape sanitization |
