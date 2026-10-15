# Unit-test lane: coverage only after merge, cli tests under node

Design note for the two configuration changes that take the pull-request
unit-test lane from 410 s to 290 s on the cli suite (idle host, 6 workers):
coverage is collected only on the post-merge `main` run, and the cli package
runs under node by default with the DOM-dependent files opting into jsdom.

## Context

Over a 21-hour window (2026-09-02 10:00 → 09-03 07:00 UTC, 3,016 runs and
4,724 jobs sampled through the Actions API) the `Qwen Code CI` Test job was
the largest single consumer of the shared ECS pool: 42% of the pool's
slot-minutes, and the job that hits `timeout-minutes: 120` whenever a host is
contended. Its duration tracked the number of concurrent jobs on the same host
(p50 37 min at 0–3 concurrent jobs, 120 min at 16 or more), so every minute of
per-run cost is multiplied by the pool's contention.

Breaking the cli suite (1,002 files, 28k tests) down with vitest's own duration
summary showed that test bodies are about a tenth of the worker time on CI; the
rest is module import per isolated worker, environment creation and coverage.

## Measurements

Local A/B on the cli suite, `--maxWorkers=6`, 10-core Apple Silicon, one run
per configuration:

| Configuration                                | Wall  | Delta | Note                                           |
| -------------------------------------------- | ----- | ----- | ---------------------------------------------- |
| Baseline (CI-equivalent: coverage, jsdom)    | 410 s | —     |                                                |
| `--coverage.enabled=false`                   | 326 s | −21%  |                                                |
| coverage off + `--environment=node`          | 290 s | −29%  | 90 files need jsdom; 912 pass under node       |
| coverage off + `--pool=threads`              | 280 s | −32%  | 32 files use `process.chdir`; not adopted yet  |
| coverage off + core alias pointing at `dist` | 325 s | 0     | import cost is evaluation, not transform       |
| coverage off + `--no-isolate`                | —     | —     | died after 47 files; mocks leaked across files |

The `environment` line of vitest's summary for the cli suite fell from 187 s to
19 s of worker time once only the 90 annotated files create a jsdom.

## Decision

1. **Coverage is switched by `QWEN_CI_COVERAGE`.** `ci.yml` sets it to `1` on
   the unit-test step only for `push` (which is only `main`). The vitest
   configs of cli, core, web-shell and vscode-ide-companion enable coverage
   from that switch; cli and core keep their local default (coverage on when
   `CI` is unset). The upload step is gated on `push` to match, and the
   pull-request coverage comment job plus its composite action are removed —
   they were the reports' only reader. web-shell and vscode-ide-companion no
   longer pass `--coverage` from `test:ci`, so one switch decides for every
   package.
2. **cli runs under `environment: 'node'`.** The 90 files that need a
   document carry a `// @vitest-environment jsdom` control comment after their
   license header; vitest reads it from the file. A future file that needs a
   document and lacks the comment fails with `document is not defined`, which
   is the intended nudge.

## Alternatives considered

- **`environmentMatchGlobs`** would avoid touching 90 files but is deprecated
  in vitest 3 and would run every file under `src/ui/hooks` in jsdom, not just
  the ones that need it.
- **Dropping coverage entirely.** Kept on the post-merge run so a per-commit
  record of `main` still exists; the cost lands once per merge instead of once
  per push.
- **`isolate: false`** is not viable: module mocks leak between files, and in
  the trial a mocked `gh` call reached GitHub for real.
- **Resolving core through `dist`** made no difference; the import tax is the
  per-worker evaluation of the module graph, which only fewer workers or a
  narrower graph can reduce.

## Follow-ups

- Package-scoped test selection in `classify_pr` (most merged PRs touch one
  package; core changes still run everything).
- `pool: 'threads'` for the cli files that do not `chdir`, via vitest
  projects.
- A per-file budget check and moving process-spawning unit tests to the
  integration lane.
