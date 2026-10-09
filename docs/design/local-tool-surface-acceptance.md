# Local tool-surface acceptance

[English](local-tool-surface-acceptance.md) | [简体中文](local-tool-surface-acceptance.zh-CN.md)

## Problem and scope

Issue #12333 needs evidence that withholding tool declarations reduces total task cost without losing tool recall or correct results. The existing release benchmark dispatches to a separate pool without a repository-owned settings injection point. A local normal CLI run can already compare configurations; it needs an actual caller and independently checked tasks rather than another unused profiling utility.

This change adds a fixed real-model paired acceptance command and a manual GitHub Actions caller. It does not change production defaults, add telemetry, replace SWE-bench or Terminal-Bench, or claim to finish the external pool's settings-overlay integration.

## Paired runs

Both arms run the same source commit, model, prompts and initial fixture bytes. A makes built-in tools visible at startup; B uses default startup visibility. Both omit `tools.eager`, use direct tool mode and a zero deferred-preload threshold, and enable the same capabilities. The initial provider requests must demonstrate the intended declaration difference; a configuration that produces the same surface cannot be accepted as evidence of a saving.

Each session has an isolated home, settings and runtime. User memory, hooks, extensions, MCP and optional background title work are disabled equally. Credentials come only from `OPENAI_API_KEY` and are never written into settings or evidence. The runner records source identity before and after; drift invalidates the result. Paired order alternates A/B and B/A across repetitions.

## Tasks and independent evidence

The fixed set covers ordinary dialogue, file aggregation, actual Shell execution, multi-step file generation, foreground Agent delegation, persistent Goal state, Workflow execution and fixture-only safety cases. Capability prompts ask for user actions without prescribing `tool_search` or `tool_call`; they must produce genuine invocation evidence. A correct final sentence without the required execution is a failure.

The runner checks exact answers, resulting files, unchanged read-only inputs and recorded tool or lifecycle results. Agent and Workflow work must actually execute; Goal acceptance must observe persisted state. Safety checks require all relevant fixture boundaries to hold. These checks establish correctness only for this bounded task set and model, not universal recall quality.

## Cost and acceptance

An owned loopback proxy transparently forwards requests to the real configured provider and counts upstream attempts, including SDK retries and child work. It does not generate model responses. The runner reconciles this count with the captured request records; an unrecorded attempt makes the cost evidence incomplete.

Whole-task totals include recorded parent, child, side-query, failed and retry requests. Reports expose input, output, total and cached tokens separately, mean/p50/p95 task input, tool-search frequency, invalid calls, task outcomes and safety outcomes. Missing usage is incomplete evidence, never zero cost. Extra rounds and failures are retained.

Acceptance requires complete paired tasks, different startup surfaces, stable sources, actual required capability execution, correct independently checked results, all safety cases passing and a lower aggregate input-plus-output total in B. A failure or incomplete capture returns nonzero and preserves its evidence. Provider caches are not reset, so a pass does not establish cold-cache savings or a priced billing reduction.

## Running and maintaining the gate

After installing the frozen dependency tree and building workspace prerequisites:

```bash
OPENAI_API_KEY=... npm run test:tool-surface:real -- \
  --model <model> --base-url <api-base-url> \
  --repetitions 2 --output /tmp/tool-surface-acceptance-new
```

Use a fresh output directory. The command removes only its temporary session profiles/workspaces and retains sanitized reports and request evidence. It never modifies the user's configuration. A bounded session timeout stops owned processes and records failure.

The `Tool surface real-model acceptance` workflow invokes this same command with a compatible model/base URL and the existing `QWEN_API_KEY` secret. It is manually dispatched, so ordinary PR CI does not require model credentials or spend provider tokens. Its report and sanitized artifacts are retained even when the acceptance command fails. Deterministic result-logic tests are picked up by the existing `test:scripts` CI lane; those tests exercise failure rejection and accounting, not model quality.

## Validation and remaining work

Verify missing usage, child-inclusive totals, extra rounds, false completion claims, source/surface mismatch and safety/result failures with deterministic tests. Run the complete paired task set against a real provider and inspect the sanitized evidence. Keep the tested commit, model, repetitions and failures explicit when publishing a result.

A larger stratified task set, additional models and the standard-suite pool overlay remain separate acceptance work under #12333. This callable local gate can detect regressions in its fixed cases without waiting for external runner access.
