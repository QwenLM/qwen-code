# Managed Workspace Todo tool slice

[中文](2026-10-22-managed-workspace-fetch-and-todos.zh-CN.md) | English

## Problem and scope

[#15076](https://github.com/QwenLM/qwen-code/issues/15076) requests a durable,
user-visible task list for Managed Sessions. This slice adds the TypeScript
`todo_write` declaration, argument admission and Worker execution. It does not
complete that user workflow or enable a new production profile.

Native `web_fetch` is deferred by the
[recorded issue decision](https://github.com/QwenLM/qwen-code/issues/15076#issuecomment-6321618001).
Sessions with an admitted Shell can use `run_shell_command` under its existing
approval and deployment policy. File-only profiles do not gain outbound fetch.
The shared core's local web-fetch behavior is unchanged.

## Profile and execution contract

- `hosted-workspace-files/3` adds only `todo_write` to the four file tools in
  `/2`; `hosted-workspace-shell/3` adds only `todo_write` to its `/2` vocabulary.
- Existing `/1`, `/2`, team-lead and read-only child profiles keep their saved
  vocabulary. A new profile avoids widening an existing Session definition.
- Malformed Todo arguments are refused before Runtime acquisition and returned
  as model-correctable tool results. Core retains its dependency validation.
- The Worker executes `TodoWriteTool`. Its file is resolved through
  `Storage.getRuntimeBaseDir()` under `todos/<runtime-session-id>.json`;
  this depends on the Worker's configured storage context, not its Workspace
  working directory. This change does not establish a per-tenant storage root
  or a cross-Runtime recovery contract.
- The successful tool result includes the updated list. There is no separate
  Hosted mechanism that restores the file or injects an unfinished-task
  reminder between model calls. Updating a Worker Config cannot update the
  Harness model's Config across the process boundary.
- Where the tool is admitted, `default`, `auto-edit` and `yolo` pre-approve it.
  Public Plan mode does not admit this writing tool. Java and TypeScript Action
  preview sets include Todo consistently; they do not include native fetch.
- Native `web_fetch` is neither declared nor executed by these profiles or the
  Managed Worker. Even a model-generated fetch call is refused before dispatch.

## Remaining work before user-facing delivery

1. Define one explicit Todo enablement source and carry it through declaration,
   admission and both Worker Configs. Core defaults `todoWriteEnabled` to false;
   unconditional Worker registration is not an implementation of that gate.
2. Wire `/3` into the applicable Java and Hosted public-profile predicates,
   approval selection and capability negotiation. The production allowed-profile
   configuration alone cannot supply that support. Decide lifecycle and Plan
   support explicitly rather than inheriting it by version number.
3. Choose the durable Session state source and recovery behavior. Existing tool
   receipts/history should be evaluated before introducing another state store.
   Same-directory file retention does not establish replacement-Worker recovery.
4. Project the current list into WebShell and restore it on refresh/reconnect.
   Team `task_*` tools are a different, team-owned workflow.
5. Validate the selected Java → Harness → Broker → Worker path, including
   recovery and the chosen UI behavior, before claiming the original issue done.

The original issue stays open until these requirements are delivered or
explicitly scoped differently. This slice should reference it without an
automatic closing keyword. No schema, deployment-default or network-policy
change is part of this scope reduction.

## Acceptance for this slice

1. `/3` declarations contain Todo and exclude fetch; earlier profiles exclude
   both names.
2. Fetch calls on either `/3` profile fail before Runtime acquisition, reservation
   or execution. The Worker tool set also excludes fetch.
3. Malformed Todo calls remain model-correctable without a Runtime round trip;
   the existing same-runtime Todo write and dependency checks remain intact.
4. Action previews retain Todo and remove fetch consistently in Java and TS.
5. Documentation and tool descriptions make no cross-Runtime persistence,
   user-visible task panel or automatic reminder claim for this slice.
