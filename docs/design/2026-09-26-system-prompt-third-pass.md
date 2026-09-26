# System prompt simplification, third pass

[English](2026-09-26-system-prompt-third-pass.md) | [简体中文](2026-09-26-system-prompt-third-pass.zh-CN.md)

## Problem and scope

After the second pass (#12546), two duplications that pass deliberately deferred remain:

1. **Todo guidance is stated three times.** When `todoWriteEnabled`, the `Plan` bullet in `## Software Engineering Tasks`, the `Task Management` bullet in `## Using Your Tools` (both calling conventions), and the `# Task Management` section each restate the same when-to-use ("complex, ambiguous, or multi-step"), when-not-to-use ("simple or single-step work unless explicitly requested"), and list-quality ("short, outcome-oriented, current") rules. Only the section carries unique operational rules (one `in_progress`, `todo_id` delegation, no prose repetition of the list, batched status updates).
2. **The `Comments` mandate over-specifies.** "Do not narrate what the code does" restates the consequence of "Default to none" plus the why-only criterion, and "NEVER talk to the user or describe your changes through comments" overlaps `Tools vs. Text` ("text output _only_ for communication. Do not add explanatory comments within tool calls or code blocks").

This pass only edits prompt text and its tests. The public API, model-family routing, declared-tool gating (every line prefix in `TOOL_GUIDANCE_LINE_GATES`, every section heading, and the `# Task Management` section text pinned by tests stay verbatim), both calling conventions, and all safety sections are unchanged.

## Changes

- **Plan bullet (Todo variant).** Shrinks to naming the tool and the skip rule: "Track complex, ambiguous, or multi-step work with `todo_write`; skip it for simple tasks unless the user explicitly requests a plan." The when/how list rules live solely in `# Task Management`.
- **Adapt bullet.** Drops "If a todo list exists, keep it current as the scope or approach changes." — the section already requires "Keep the list current … revise it when the scope or approach changes."
- **Task Management bullet (both calling conventions).** Shrinks to a pointer: "Use `todo_write` to keep user-visible progress on multi-step work; `# Task Management` governs its use." The gated line prefix `- **Task Management:**` is unchanged, so declared-tool gating behaves identically.
- **Comments mandate.** Compressed to: "Default to none. Add one only when the _why_ cannot be conveyed through naming or code structure — a hidden constraint, a subtle invariant, or a workaround for a specific bug. Do not edit comments that are separate from the code you are changing."

This pass is **not behavior-policy-neutral**, same disclosure as the second pass: "Do not narrate what the code does" and the explicit "NEVER talk to the user or describe your changes through comments" are intentionally removed from the `Comments` bullet on the strength of the `Tools vs. Text` bullet, not relocated elsewhere in the prompt.

## Rationale and consumers

The entry point remains `getCoreSystemPrompt`; callers (main session client, Arena worker) and `/context` accounting are unchanged. The Todo savings apply only to sessions with `todoWriteEnabled` (not the default), so the expected reduction is concentrated in the `+ todo` measurement rows; the `Comments` compression applies to every variant.

## Verification and acceptance

- `packages/core`: prompts tests with regenerated snapshots (only the intended text differs), plus the prompt-tool-examples, client, and Arena suites.
- `packages/cli`: context command tests.
- Build, typecheck, Prettier/ESLint on changed files.
- All five model families render across interactive, headless, and ACP modes, plus CodeModeOnly.
- Before/after sizes measured on the rendered base prompt under identical inputs (interactive, Git enabled, no sandbox, no style/context) with `o200k_base` as a common text-size ruler; not provider billing counts, and not evidence of changed task success.

## Risks and follow-ups

Compressed wording can still shift model behavior; structural tests cannot prove unchanged task success. The external paired evaluation that covered the first two passes did not include this text; if it flags a regression the pointers are the first candidates to restore. Remaining known items outside this pass: capability-aware assembly (do not inject guidance for skills/tools the session lacks), and the tool-description block tracked in #12054.
