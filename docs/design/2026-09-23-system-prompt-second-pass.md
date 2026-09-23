# Second-pass system prompt simplification

[English](2026-09-23-system-prompt-second-pass.md) | [简体中文](2026-09-23-system-prompt-second-pass.zh-CN.md)

## Problem and scope

After the first pass (#12360), the default main-session prompt still restates the same rules in adjacent sections: the dedicated-tool policy is explained twice, verification appears as two overlapping bullets plus a restated summary, adaptive response detail is described in both the communication and tone sections, and the Git guidance splits one commit-message rule across two bullets and three overlapping source-of-truth bullets.

This second pass edits prompt text only. It preserves public APIs, model-family routing, declared-tool filtering, direct and CodeModeOnly calling conventions, every gated line prefix, all interaction-mode question policies, the Todo guidance, output-style handling, and the safety sections (`Executing actions with care`, sandbox, permission rules) byte for byte.

## Changes

- **Tool guidance (both calling conventions).** Trim the "Reserve shell" sub-line to the rule itself; the leading `Prefer Dedicated Tools` sentence already states when the shell must not be used. Condense the `Subagent Delegation` bullet to its three operative rules: delegate when the task matches the agent's description, never duplicate delegated work, and wait for the background notification instead of reading transcripts, predicting results, or relaunching. Condense the `Codebase Search` bullet the same way, keeping the direct-search default and the Explore threshold (insufficient directed search or clearly more than three queries).
- **Engineering workflow.** Merge `Verify (Tests)` and `Verify (Standards)` into one `Verify` bullet covering tests, build, lint, and type-check, keeping the rules to identify project-specific commands and to skip verification for read-only turns. Fold the "can't verify" escape hatch into `Report outcomes faithfully`. Drop the closing `Key Principle` paragraph, which restated `Adapt`.
- **Communication and tone.** Keep the pinned adaptive-detail sentence (`Final responses should be concise by default, but their shape and depth must match the request`) and the evidence list for substantial answers. Drop the second "use enough detail for clarity" phrasing from `Tone and Style` and the redundant "lead with the outcome" clause.
- **Git guidance.** Merge the two commit-message bullets into one (always propose a draft; why over what). Compress the three `Git as Source of Truth` bullets into one covering authoritative history (`git log` / `git blame` over memory or cached snapshots) and debugging provenance (the fix is in the code, the commit message has the context).

## Rationale and consumers

The entry point remains `getCoreSystemPrompt`; callers and the `/context` estimator are unchanged. Every line prefix in `TOOL_GUIDANCE_LINE_GATES` is preserved verbatim, so declared-tool filtering (`#12032`) behaves identically; the gating tests assert these prefixes. The pinned response-detail sentences asserted by `prompts.test.ts` (`adapts final response detail to the request`, from #7085) are kept verbatim. No bullet label or section heading is removed, renamed, or reordered.

## Validation and acceptance

- `packages/core` prompt tests (190, including 17 regenerated snapshots) and Arena worker tests pass; the snapshot diff contains only the intended text changes.
- `packages/cli` context-command and review base-tree tests pass.
- Build, typecheck, and changed-file Prettier/ESLint checks pass.
- All five model families (general, qwen-coder, qwen-vl, gemma4, plus CodeModeOnly) render across interactive, headless, and ACP modes.
- Before/after sizes measured on the rendered base prompt under identical inputs (interactive, Git enabled, no sandbox, no Todo/style/context) with `o200k_base` as a common text-size ruler; they are not provider billing counts.

## Risks and follow-up

Shorter deduplicated wording may still affect model behavior; structural tests do not establish unchanged task success. A paired real-model A/B evaluation (same task, same environment, only the prompt differs) remains the open verification gap, as does capability-aware assembly (omitting guidance for skills that are not loadable). The Todo guidance triplication and comment-rule compression from the original plan are deferred to a later pass.
