# Shell path and process ownership

[English](2026-11-17-shell-path-ownership.md) | [简体中文](2026-11-17-shell-path-ownership.zh-CN.md)

Status: implemented locally; packaged CLI validation is pending.

## Failure boundaries

An unresolved path must remain a human decision in AUTO mode, including when a permission rule already asks or a `PermissionRequest` hook answers `allow`. Returning an undecorated `safety_check` fallback lets the scheduler treat that hook response as approval.

The path extractor also needs to distinguish a word's decoded text from its shell role. A variable-only `find` starting point is not an omitted starting point. A quoted `time` is not the reserved word. A child process changing directory does not move its parent. Removing wrapper quotes does not undo an expansion the outer shell already performed.

## Shared analysis

`splitCompoundCommandSegments` remains the lexer owner. Its default mode preserves command-rule splitting. The path walker requests group delimiters and empty structural segments. Substitution, extended-glob and array-assignment parentheses stay inside their word, and empty function parameters stay with the definition header. Comment text does not open groups or quotation in this mode.

The walker keeps mutable cwd state for foreground commands and brace groups. Subshells, background lists and pipeline elements use separate state. Function definitions also have separate state: defining a body does not execute its cd in the parent, including with quoted or non-identifier function names. Matching group types prevents a case arm's closing parenthesis from closing a brace body. Unmodelled case control flow keeps subsequent relative paths uncertain. A final pipeline element can affect the parent under shell-specific behavior such as Bash `lastpipe`, so a directory change there leaves the subsequent cwd uncertain. Group redirections are resolved before the body changes directory. At 100 nested groups the walker retains file operations but marks their paths uncertain instead of recursing further.

`find` retains every starting-point word before its expression, including expansion marks and leading `-H`, `-L` or `-P`. The tokenizer preserves empty quotation for reserved-word recognition, so `ti''me` does not become a `time` prefix. The same distinction applies to time's `-p` option. Repeated time keywords and `time --` have different cwd behavior in Bash 3.2 and newer Bash; neither resulting cwd is certified. Assignment recognition requires a bare variable name and assignment operator, not a bare array subscript.

Short-option parsing stops when a value-taking option owns the rest of its cluster or the next argument. The four target-directory file commands use their own mandatory-value option tables, so suffix text is not reinterpreted as a target flag and boolean flags do not consume an operand. Optional long-option values remain attached with `=`.

Wrapper quote removal returns the decoded script rather than keeping outer quotation that can hide all its operators. Its optional `expandedWords` collector records quote-removed inner words containing outer expansion. Recording the complete word preserves text spliced onto an expansion by quote removal, instead of confusing that splice with a different variable name. The synchronous walker scopes those marks with `try/finally`; the path layer checks them before path normalization, including when inner quotes or a produced backslash would otherwise hide the expansion. Matching remains conservative when the same expanded word occurs in different places. A literal dollar or a different variable name is not automatically an expansion.

Monitor retains both its normalized safety reading and the original wrapper when outer expansion is present. Alternative payloads with expansion retain a wrapper too. These are analysis inputs, not extra commands to spawn; `spawnCommand` is unchanged.

## Approval contract

The unresolved-path floor, including a relative operation whose cwd is unknown, runs before the generic ask-rule fallback. It sets `requiresHumanDecision: true` and a manual-approval message. The existing scheduler and ACP consumers already read those fields to prevent hook approval and hide persistent allow choices. No new approval policy or hook bypass is introduced.

## Validation and limits

Use the [E2E plan](../../.qwen/e2e-tests/shell-path-ownership.md). Source regressions cover the permission manager, AUTO evaluator and scheduler hook path, as well as parser and utility controls. Native Bash probes use a separate workspace and HOME, never the operator's settings or shell startup files.

The extractor is still best-effort shell analysis, not a complete shell interpreter. The repository also has a Tree-sitter Bash parser, but its public API is asynchronous and needs runtime and grammar WASM initialization. The synchronous permission analysis cannot adopt it without changing scheduling and dependency boundaries. These changes preserve that existing interface rather than introduce a second asynchronous source of truth. Literal-path precision, known deny rules, ANSI-C bytes, default command-rule splitting and budget fallback remain regression requirements. Source tests and native shell probes do not establish packaged CLI or ACP end-to-end coverage; those results must be reported separately.
