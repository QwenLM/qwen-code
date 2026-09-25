# Advisor behavior alignment

[English](advisor-alignment.md) | [简体中文](advisor-alignment.zh-CN.md)

## Goal and reference

Complete the executor/advisor behavior introduced by #9636 and the acceptance contract in #9036. Baseline: merged main `90232f0eb0c0`. Reference: Claude Code `2.1.282`, verified against npm on 2026-09-25. The older local source is a structural reference only; the matching released native binary contains the consultation-policy and model-pairing anchors. No upstream implementation is copied.

Confirmed from the released binary: the executor receives detailed guidance about consulting after orientation, before a substantial approach, when stuck, and before completion, and reconciling conflicting evidence. Confirmed by the [CLI documentation](https://code.claude.com/docs/en/advisor): consultation timing is model-driven, ordinary subagents inherit Advisor, usage costs extra, and the CLI exposes no call-count limit. The [API contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) separately supports optional usage limits and returns advice to the executor.

## Decisions

- Keep the no-argument schema and a short searchable description. Advisor is deferred by default and discovered with `tool_search`, then invoked with `tool_call`; explicit visibility and the existing no-bridge fallback still apply. A separate task reminder tells the executor when to consult before discovery. Ordinary subagents receive the same guidance subject to their declared tools and execution permissions. Consultation is model-driven, never mandatory per turn, and advice does not grant approval.
- Native consultation returns readable text or Markdown with no required JSON fields and no tools, including no schema tool. Manual `/advisor review` retains its structured contract. Removing the native parser eliminates the duplication concern without changing the manual parser or reserving case variants of valid model IDs.
- Bind the current agent chat to the existing asynchronous agent context. Both normal execution and approval continuations re-enter that binding. An agent with no bound chat fails closed instead of consulting on the parent's transcript. Subagents inherit registration but their explicit tool allowlists, disallowed tools, safe/bare modes, and permissions still apply. Internal single-turn side queries and Advisor inference have no executable tools, preventing consultation recursion there.
- Add `advisorMaxUses`, a non-negative integer in user/system settings: `0` means unlimited. A session shares one counter across its executor and derived subagent configs; attempted requests, including failures, consume a slot before awaiting inference. Disabling or switching models does not reset it. A new runtime session gets a new counter. Workspace settings cannot raise or override this cost boundary. This is a Qwen issue-contract extension, not a Claude CLI setting.
- Preserve the full current transcript, system instruction, and tool declarations with the existing reasoning/binary filtering. Do not silently truncate evidence to meet a speculative payload budget. Explain the repeated token cost and expose the configured limit/current count in the non-picker command output. Existing model/source telemetry attributes inference to `advisor`.
- Render free-form advice in the existing Advisor card; retain rendering of persisted structured reviews. Non-interactive `/advisor` reports the current model and budget; configuration and off follow the existing command policy.

## Intentional differences

Qwen makes a separate cross-provider inference instead of using Anthropic's server tool. Model eligibility follows Qwen's configured model capabilities, not a hard-coded ranking of Anthropic model families. This does not promise identical prompt caching, billing, server-side refusal signals, or vendor-specific model pairing. Off removes the Qwen tool, which can change the executor's tool prefix. These differences are documented rather than hidden behind a claim of identical implementation.

## Acceptance

1. Native plain-text advice is returned to the executor, displayed, and followed by task continuation. The request uses the selected model and no tools, and includes all transcript categories.
2. Empty advice, provider failure, limit exhaustion, and cancellation have their declared behavior. Limits prevent another network request and are shared across subagents.
3. Subagent evidence comes from its own chat, including tool results, and missing agent context never falls back to the parent. Existing tool/permission policies remain enforced.
4. User/system configuration wins over workspace input. Off avoids Advisor requests. Historical structured cards and new free-text cards both render.
5. Focused unit and bundled CLI integration tests pass, along with build and typecheck. A bounded real-model task must demonstrate autonomous consultation and subsequent executor behavior; exit status alone is insufficient. Record provider errors and unverified scenarios explicitly.

## Validation status

Implementation, focused automated acceptance, and Ink terminal mock acceptance passed. Five bundled CLI scenarios cover success, provider failure, subagent evidence, usage exhaustion, and off. The OpenTUI adapter was corrected after terminal verification exposed raw JSON output; its regression tests and strict OpenTUI terminal retest pass. The globally installed CLI predates native Advisor. Live baseline attempts with the two locally configured models whose credential is available both returned provider errors indicating retired models. Live-model acceptance therefore requires a working configuration; it is not counted as passed. Results will be recorded in the PR and the acceptance report.
