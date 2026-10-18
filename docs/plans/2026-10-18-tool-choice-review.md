# PR #13919 review follow-up plan

**Goal:** Resolve the remaining model-switch defect and verified review feedback.

**Design:** [English](../design/2026-10-11-forced-tool-choice-capability.md) | [中文](../design/2026-10-11-forced-tool-choice-capability.zh-CN.md)

**Approach:** Preserve the existing per-model capability and Chat Completions
guard. Copy its value and source during Qwen OAuth hot switches, following
the adjacent metadata field. Keep Responses, Anthropic, reasoning, and
fallback parsers unchanged.

- [ ] Reproduce R3-1 with the test engineer before changing production code.
      Pin both directions of hot switching and configuration source tracking
      in `packages/core/src/config/config.test.ts`.
- [ ] Update the hot-switch value and source in
      `packages/core/src/config/config.ts`; verify the regressions pass.
- [ ] Extend `pipeline.test.ts` with a non-DashScope endpoint and diagnostic
      assertions. Confirm they fail under endpoint-gating and log-removal
      mutations, then restore the implementation.
- [ ] Correct affected-query lists, the shipped guard snippet, fallback
      semantics, and the observability decision in both design languages and
      the user documentation. Clarify the generated setting's wire scope and
      remove duplicated tests already covered by existing cases.
- [ ] Build, bundle, typecheck, run targeted core and CLI suites, lint and
      format the changed files. Have the test engineer verify the fix.
- [ ] Audit the complete diff until two consecutive passes are clean and
      obtain an independent code review.
- [ ] Prepare accurate thread replies, including the deferred parser and
      abstraction notes. Ask for approval of the exact commit message before
      committing or pushing. Replies must distinguish local validation from
      changes available on the PR.

Constraints: ESM, no new dependencies, no unrelated checkout edits, and no
live macOS `fm serve` claim from this Linux environment. All scratch artifacts
remain under `.qwen/` inside the project. The global `qwen` CLI is unavailable,
so the test engineer records the required E2E attempt and uses a focused
test-script fallback.
