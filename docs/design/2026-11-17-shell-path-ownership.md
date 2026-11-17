# Shell path and process ownership

[English](2026-11-17-shell-path-ownership.md) | [简体中文](2026-11-17-shell-path-ownership.zh-CN.md)

Status: implemented locally; packaged CLI validation is pending.

## Failure boundaries

An unresolved path must remain a human decision in AUTO mode, including when a permission rule already asks or a `PermissionRequest` hook answers `allow`. Returning an undecorated `safety_check` fallback lets the scheduler treat that hook response as approval.

The path extractor also needs to distinguish a word's decoded text from its shell role. A variable-only `find` starting point is not an omitted starting point. A quoted `time` is not the reserved word. A child process changing directory does not move its parent. Removing wrapper quotes does not undo an expansion the outer shell already performed.

## Shared analysis

`splitCompoundCommandSegments` remains the lexer owner. Its default mode preserves command-rule splitting. The path walker requests group delimiters and empty structural segments, while extended-glob parentheses remain part of their word.

The walker keeps mutable cwd state for foreground commands and brace groups. Subshells, background lists and pipeline elements use separate state. A final pipeline element can affect the parent under shell-specific behavior such as Bash `lastpipe`, so a directory change there leaves the subsequent cwd uncertain. Group redirections are resolved before the body changes directory. At 100 nested groups the walker retains file operations but marks their paths uncertain instead of recursing further.

`find` retains every starting-point word before its expression, including expansion marks and leading `-H`, `-L` or `-P`. The tokenizer preserves empty quotation for reserved-word recognition, so `ti''me` does not become a `time` prefix.

Wrapper quote removal returns the decoded script rather than keeping outer quotation that can hide all its operators. Its optional `expandedWords` collector records outer expansion spellings. The synchronous walker scopes those marks with `try/finally`; the path layer checks them before path normalization, including when inner quotes or a produced backslash would otherwise hide the expansion. Matching is conservative when the same expansion spelling occurs in different places. A literal dollar or a different variable name is not automatically an expansion.

Monitor retains both its normalized safety reading and the original wrapper when outer expansion is present. Alternative payloads with expansion retain a wrapper too. These are analysis inputs, not extra commands to spawn; `spawnCommand` is unchanged.

## Approval contract

The unresolved-path floor, including a relative operation whose cwd is unknown, runs before the generic ask-rule fallback. It sets `requiresHumanDecision: true` and a manual-approval message. The existing scheduler and ACP consumers already read those fields to prevent hook approval and hide persistent allow choices. No new approval policy or hook bypass is introduced.

## Validation and limits

Use the [E2E plan](../../.qwen/e2e-tests/shell-path-ownership.md). Source regressions cover the permission manager, AUTO evaluator and scheduler hook path, as well as parser and utility controls. Native Bash probes use a separate workspace and HOME, never the operator's settings or shell startup files.

The extractor is still best-effort shell analysis, not a complete shell interpreter. Literal-path precision, known deny rules, ANSI-C bytes, default command-rule splitting and budget fallback remain regression requirements. Source tests and native shell probes do not establish packaged CLI or ACP end-to-end coverage; those results must be reported separately.
