# Behavioral Eval Harness

[English](2026-11-23-behavioral-eval-harness.md) | [简体中文](2026-11-23-behavioral-eval-harness.zh-CN.md)

Status: proposal. No implementation yet; this document is the buy-in vehicle —
it fixes the design so maintainers can approve or trim it before any code
lands.

## Why

The repo's test layers verify that the system _functions_: unit tests cover
mechanics, `integration-tests/` covers end-to-end flows, and `.qwen/e2e-tests/`
plans cover release checklists. Nothing verifies that the model _chooses_ the
right action — whether a system-prompt change makes the model more or less
likely to call a tool, whether a new tool definition confuses steering, whether
a notice rewording changes what the model does next. Those surfaces (system
prompt, tool descriptions, compaction and memory notices, subagent delegation
wording) change frequently, and every change currently lands without a
behavioral feedback loop.

The upstream lineage makes the gap concrete: qwen-code is a fork of
gemini-cli, which now carries a behavioral eval suite — 38 `.eval.ts` cases in
a root `evals/` directory, an `LLMJudge` utility (`judgeYesNo` with
self-consistency majority voting), a two-tier policy (`ALWAYS_PASSES` gating
CI, `USUALLY_PASSES` running nightly under `RUN_EVALS=1`), and a documented
promotion path. The fork inherits the steering surfaces but not the harness.
This proposal adopts that harness shape, adapted to this repo's conventions.

Recent work here would have benefited directly: the compaction-input failure
digest (#17314) has no check that summaries actually preserve failure reasons;
the shell untrusted framing (#17325) has no check that the model treats framed
output as data; memory recall (#16517) has no check that recall injects the
right memory and not noise.

## Design

### Directory and entry points

A root `evals/` directory, mirroring gemini-cli so fork-side parity stays
mechanical:

- `evals/test-helper.ts` — exports `evalTest(policy, evalCase)`, a Vitest
  wrapper. `policy` is `'ALWAYS_PASSES' | 'USUALLY_PASSES'`; `evalCase` is
  `{ name, prompt, params?, assert(rig, result), log? }`.
- `evals/llm-judge.ts` — `LLMJudge` wrapping the core
  `BaseLlmClient.generateContent`: `judgeYesNo(question, options)` returns
  `{ verdict, reasoning, votes }`, with `selfConsistencyRuns` (default 1, use
  3 or 5 for majority voting) and a configurable judge model defaulting to a
  fast small-tier model. The judge runs under a utility role and a dedicated
  `promptId`, with a strict system instruction that demands a bare `YES`/`NO`.
- `evals/*.eval.ts` — the cases themselves, one behavior per file.
- `evals/README.md` — the authoring rules (mirroring upstream's: realistic
  but small scenarios, unambiguous assertions, fail-first, less-is-more).

### Rig

`evalTest` drives the bundled CLI (`npm run build && npm run bundle` → the
single-file bundle), reusing the interaction patterns already proven by
`integration-tests/` (headless `-p` where the behavior is observable from the
final state; the tmux/interactive harness where mid-turn behavior matters).
The rig records tool calls and the final state; `assert` receives both. No
new session machinery: the rig composes existing helpers.

### Policies and gating

- `ALWAYS_PASSES`: expected deterministic-stable behaviors. Runs in the PR CI
  lane and blocks merges on failure. Kept deliberately small (target ≤ 10
  cases).
- `USUALLY_PASSES`: model-steering behaviors with inherent variance. Gated
  behind `RUN_EVALS=1` and run nightly. All new evals start here.
- Promotion: nightly artifacts record per-eval pass rate; an eval promoted to
  `ALWAYS_PASSES` only after a sustained green streak (proposal: 14
  consecutive nightly runs), and demoted back on a flake. Same process as
  upstream.

### Cost and keys

Evals call real models. Controls:

- `USUALLY_PASSES` runs only nightly; `ALWAYS_PASSES` stays small and uses
  short prompts.
- Judging uses the small-tier model, not the working model.
- When no API key is present, evals skip with a logged reason rather than
  fail — local development without keys stays green. CI provides the key via
  a secret and is the only place the suites actually execute.
- The nightly lane respects the repo's CI budget gate.

## Non-goals

- No general benchmark adoption (SWE-bench-style) — behavioral evals target
  granular product behaviors only.
- No eval authoring automation (the upstream "behavioral-evals" agent skill)
  in this slice.
- No multi-model comparison matrix in v1; the harness records per-model
  results only if the runner already provides them for free.
- No changes to the existing unit/integration lanes' semantics.

## Implementation steps

1. `evals/test-helper.ts` + rig composition + `LLMJudge`, with unit tests for
   the helper and judge parsing (mock client).
2. Three seed evals, all `USUALLY_PASSES`, on the highest-value steering
   surfaces: tool selection under the compaction context-remaining tool
   (#17320 family), shell-output untrusted framing adherence (#17325 family),
   compaction summary preserving failure reasons (#17314 family).
3. Nightly workflow publishing per-eval pass rates; npm scripts
   `test:always_passing_evals` / `test:all_evals` matching upstream's names.
4. `evals/README.md` with the authoring rules and promotion process.
5. CI lane for `ALWAYS_PASSES` once any eval is promoted (the lane may start
   empty).

## Risks and mitigations

| Risk                  | Mitigation                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| API spend             | nightly-only for the volatile tier; small-tier judge; short prompts; budget gate                       |
| Flakiness blocks work | new evals can never gate CI (`USUALLY_PASSES`); promotion requires a measured streak                   |
| CI time               | `ALWAYS_PASSES` ≤ 10 fast cases; `USUALLY_PASSES` never in the PR lane                                 |
| Key management        | skip-without-key locally; CI-only execution via secret                                                 |
| Judge misjudges       | strict YES/NO contract, self-consistency voting on contested cases, nightly reports reviewed by humans |

## Acceptance criteria

- `evalTest` + `LLMJudge` unit-tested; parsing and voting verified with a mock
  client.
- Without an API key, the eval suites skip cleanly and every existing lane
  stays green.
- With a key, the three seed evals run and produce per-eval results.
- Nightly workflow publishes the pass-rate artifact; promotion/demotion rules
  are documented and followed.
- The PR CI lane runs only promoted (`ALWAYS_PASSES`) evals.

## Open questions

1. Which model is the small-tier judge default in this repo's routing
   (upstream uses a flash-tier default; the equivalent here needs a pick)?
2. Nightly budget cap per run (proposed: time-boxed, fail-open on budget
   exhaustion rather than red).
3. Does v1 ship with an empty `ALWAYS_PASSES` set until the first promotion,
   or seed one trivial case to exercise the lane end to end?
4. Key provisioning for external contributors — CI-only, or a documented
   local path?
