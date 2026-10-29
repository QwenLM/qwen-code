# Project Hooks Approval Gate

[English](2026-10-19-project-hooks-approval-gate.md) | [简体中文](2026-10-19-project-hooks-approval-gate.zh-CN.md)

Status: implemented, 2026-10-19.

## Problem

`security.folderTrust.enabled` defaults to `false`, and a disabled feature treats every folder as trusted. The workspace `.qwen/settings.json` is therefore merged in full, including its `hooks` block, and `Config.getProjectHooks()` only checks `isTrustedFolder()`. A freshly cloned repository can ship a `SessionStart` command hook that runs the moment `qwen` starts in it, with no prompt. Project MCP servers from the same file already have a hash-bound approval gate (issue #4615); project hooks have none.

## Goals

- A repository's hooks never run before the user has reviewed them.
- Existing users keep their project hooks after a one-time approval; no change to the folder-trust default.
- The gate mirrors the MCP one: user-local, per project, bound to the reviewed configuration, re-asked on change, never re-asked for a settled rejection.

## Non-goals

- Changing the default of `security.folderTrust.enabled`.
- An ACP request for approving project hooks (ACP sessions simply do not load unapproved project hooks).
- The LSP `.lsp.json` command path, which has the same shape of problem and is tracked separately.

## Design

### Approval store

`packages/cli/src/config/hook-approvals.ts` persists `~/.qwen/hookApprovals.json` (`QWEN_CODE_HOOK_APPROVALS_PATH` overrides it) with one record per project root: `{ hash, status }`, `status` being `approved` or `rejected`. `hash` is a SHA-256 of the project `hooks` object as written in the file, before `${VAR}` resolution (startup resolves before the project `.env` loads, `/hooks` after, so a resolved block would hash differently on the two paths), together with the current value of every `$VAR`/`${VAR}` the block names (except the ones the hook runner sets itself, such as `QWEN_PROJECT_DIR`, and keys of the hook's own `env`), serialised with sorted keys (null-prototype objects, so an own `__proto__` key is hashed too), so key order in the file does not matter but any behavioural edit, including one made only through the project `.env`, changes it. Both paths read those values from `process.env` after the project `.env` has loaded, so they agree. A record whose hash does not match the live hooks, or whose status is neither value, counts as `pending`. Callers hand the Config a copy of the resolved block, because the hook registry tags loaded definitions in place and an ACP daemon reuses one settings instance across sessions. The project root is the folder holding the `.qwen/settings.json` the hooks came from, not the session's working directory, so `/cd` and `--worktree` do not move the key; it is normalised as in `mcpApprovals.json`. The file is written `0600` (an existing looser mode is tightened), and `QWEN_CODE_HOOK_APPROVALS_PATH` is excluded from project `.env` files like the sibling store paths and forwarded into a sandbox container. The file is read fresh on every check, so a long-lived ACP daemon sees decisions made elsewhere; a save re-reads it and replaces only its own project's record, and fails (leaving the hooks withheld) rather than overwrite a file it cannot read.

`isProjectHooksPendingApproval(projectHooks, projectRoot)` is `true` when the block declares at least one hook the registry would run (a known event, and a `command`, `http` or `prompt` hook with its command, URL or prompt) and its state is not `approved` (pending or rejected). An absent, `null` or empty block, or one with nothing runnable, is never gated.

### Core

`ConfigParameters.projectHooksPendingApproval` records the startup decision; `undefined` means the session does not gate project hooks at all. While it is `true`, `getProjectHooks()` returns `undefined` after the existing trust check, and so does the legacy merged-`hooks` fallback in `getUserHooks()`, which can carry the same workspace block when no scopes were separated. `setProjectHooksPendingApproval()` lets the CLI clear the gate mid-session; the next `HookSystem.reload()` then registers them. `getWithheldProjectHooks()` returns the withheld block for display only, and the hooks listing behind the OpenTUI `/hooks` browser shows it with the reason `pendingApproval`, or `rejected` when the CLI recorded a rejection (`projectHooksRejected`). The ACP status reports it only as `enabled: false`, without the reason.

### CLI startup

`loadCliConfig` computes the flag from the unresolved project block and root the caller supplies (or the merged `hooks` when it supplies no scopes). It leaves the flag `undefined` under `--bare`, `--safe-mode` and `disableAllHooks`, where no hooks load. Under a YOLO approval mode asked for on the command line (`--yolo`, `--approval-mode yolo`) it sets the flag `false` with `projectHooksYoloExempt`, so the gate stays off only while the session is in YOLO: once the user leaves it, a `/hooks` reload gates the block again. A YOLO mode that comes from settings does not exempt the hooks, because the workspace's own `tools.approvalMode` can set it.

### Interactive approval

`useProjectHooksApproval` (ink and OpenTUI share it) shows a dialog listing every hook as `Event  target [details]` when the state is strictly `pending`, from the unresolved block: the command with its `env` as `KEY=value`, `shell`, `async` and the current value of each variable it references, so the effective command is visible; the URL with its header names and `allowedEnvVars`; the prompt text and any `model` override; the matcher comes last, so it cannot push the target off the row. Every repo-supplied string is reduced to one row with escapes, bidi and other format characters removed; a value over 200 code points is cut with a marker giving its length, so an elided tail is never silent. Each hook takes one row, cut to the dialog's text width with a `… [+N chars]` marker, and the list is capped to the rows the wrapped header leaves at that width (the finite list-dialog budget, in both renderers), down to just the "… and N more" row, so the options stay visible. Approve persists `approved`, clears the gate on the live `Config` and reloads the hook system; Reject persists `rejected` and leaves the hooks unloaded; Esc closes the dialog without storing anything and adds a transcript line saying the hooks were not loaded; the same block is not offered again this session, so `/hooks` can show it, and the next start (or an edit) asks again. A save that fails leaves the hooks withheld and says so. The dialog ranks after the MCP approval dialog. The ink `/hooks` browser marks withheld project hooks as not approved, or as rejected.

### `/hooks` reload

In a gated session the reload recomputes the gate from the freshly read workspace hooks before `HookSystem.reload()`, so a decision edited by hand applies without a restart and an edited block stays out of the registry. It emits `AppEvent.ProjectHooksPendingApprovalChanged` when the block is `pending` so the dialog asks again. An ungated session is left alone.

### Headless runs

A non-interactive session cannot prompt. Unapproved project hooks stay unloaded and `qwen -p` prints one stderr line saying so: for a pending block it points at an interactive run, for a rejected one it names the approvals file instead.

## Decisions

- **Gate regardless of folder trust.** A trusted folder means its settings are read, not that every command in them was reviewed; this matches the MCP gate and keeps the folder-trust dialog unchanged.
- **One decision per project, not per hook.** Hooks are reviewed as the block the file declares; a per-hook queue would add UI for no extra safety.
- **Only a command-line YOLO skips the gate.** The user chose to approve everything; a settings value could have been chosen by the repository.
- **Rejection is remembered** so a rejected repository does not nag on every start, but any edit re-asks. Esc is not a rejection, so a dialog that is closed in passing is offered again on the next start.
- **Referenced variables are part of what is approved.** The shell expands them at run time, so a project `.env` could otherwise change an approved command without touching the file. Rotating such a value asks again.
- **The hash covers the `hooks` block only.** Other hook settings a project can set, such as `stopHookBlockingCap` (clamped to 100), tune how approved hooks run but run nothing themselves; folding them in would re-prompt every approved project for no new command.

## Validation

- Unit tests: store semantics and hash binding (`hook-approvals.test.ts`), startup gate conditions (`config.test.ts` in both packages), the dialog hook (`use-project-hooks-approval.test.ts`), and the `/hooks` reload (`hooksCommand.test.ts`).
- Manual: `qwen -p` in a cloned repository that declares a `SessionStart` hook no longer runs it and warns on stderr; an interactive start shows the dialog, approving runs the hooks on the next event, and `~/.qwen/hookApprovals.json` holds the decision.

## Acceptance criteria

- With default settings, a repository hook never runs before the dialog is answered.
- Approving once is enough until the project hooks change.
- Rejecting keeps the hooks unloaded and does not re-prompt until they change.
- User, system and extension hooks are unaffected.

## Follow-up

- ACP: a request to list and approve pending project hooks, mirroring the MCP one, and the withheld reason in the hooks status.
- LSP: gate the workspace `.lsp.json` commands the same way.
- Project skill and subagent frontmatter hooks: they still need only folder trust.
- A non-interactive way to approve project hooks (for CI), mirroring `qwen mcp approve`.
