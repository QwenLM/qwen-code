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

`packages/cli/src/config/hook-approvals.ts` persists `~/.qwen/hookApprovals.json` (`QWEN_CODE_HOOK_APPROVALS_PATH` overrides it) with one record per project root: `{ hash, status }`, `status` being `approved` or `rejected`. `hash` is a SHA-256 of the project `hooks` object serialised with sorted keys, so key order in the file does not matter but any behavioural edit changes it. A record whose hash does not match the live hooks counts as `pending`. Project roots are normalised the same way as in `mcpApprovals.json`.

`isProjectHooksPendingApproval(projectHooks, projectRoot)` is `true` when the workspace declares a non-empty `hooks` block whose state is not `approved` (pending or rejected). An empty or absent block is never gated.

### Core

`ConfigParameters.projectHooksPendingApproval` records the startup decision. While it is `true`, `getProjectHooks()` returns `undefined` after the existing trust check, so `HookRegistry` registers no project hooks. `setProjectHooksPendingApproval()` lets the CLI clear the gate mid-session; the next `HookSystem.reload()` then registers them.

### CLI startup

`loadCliConfig` computes the flag from the separated `projectHooks`, in the same conditions as the MCP gate: not in `--bare`, not in `--safe-mode`, and not in `--yolo`, which treats the hooks as approved.

### Interactive approval

`useProjectHooksApproval` (ink and OpenTUI share it) shows a dialog listing every hook as `Event[matcher]  command` when the state is strictly `pending`. Approve persists `approved`, clears the gate on the live `Config` and reloads the hook system; reject persists `rejected` and leaves the hooks unloaded. The dialog ranks after the MCP approval dialog and takes the same escape-to-reject convention.

### `/hooks` reload

The reload recomputes the gate from the freshly read workspace hooks before `HookSystem.reload()`, so an edited block stays out of the registry, and emits `AppEvent.ProjectHooksPendingApprovalChanged` when the block is `pending` so the dialog asks again.

### Headless runs

A non-interactive session cannot prompt. Unapproved project hooks stay unloaded and `qwen -p` prints one stderr line saying so.

## Decisions

- **Gate regardless of folder trust.** A trusted folder means its settings are read, not that every command in them was reviewed; this matches the MCP gate and keeps the folder-trust dialog unchanged.
- **One decision per project, not per hook.** Hooks are reviewed as the block the file declares; a per-hook queue would add UI for no extra safety.
- **`--yolo` skips the gate**, as it does for MCP servers, since the user already chose to approve everything.
- **Rejection is remembered** so a rejected repository does not nag on every start, but any edit re-asks.

## Validation

- Unit tests: store semantics and hash binding (`hook-approvals.test.ts`), startup gate conditions (`config.test.ts` in both packages), the dialog hook (`use-project-hooks-approval.test.ts`), and the `/hooks` reload (`hooksCommand.test.ts`).
- Manual: `qwen -p` in a cloned repository that declares a `SessionStart` hook no longer runs it and warns on stderr; an interactive start shows the dialog, approving runs the hooks on the next event, and `~/.qwen/hookApprovals.json` holds the decision.

## Acceptance criteria

- With default settings, a repository hook never runs before the dialog is answered.
- Approving once is enough until the project hooks change.
- Rejecting keeps the hooks unloaded and does not re-prompt until they change.
- User, system and extension hooks are unaffected.

## Follow-up

- ACP: a request to list and approve pending project hooks, mirroring the MCP one.
- LSP: gate the workspace `.lsp.json` commands the same way.
