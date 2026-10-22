# Durable Todo for Managed Workspace Sessions

[中文](2026-10-22-managed-workspace-fetch-and-todos.zh-CN.md) | English

## Problem and scope

[#15076](https://github.com/QwenLM/qwen-code/issues/15076) needs a durable task list across Turns and replacement Workers. A Worker-local file keyed by a runtime ID cannot provide that contract. Hosted Harness therefore owns Todo through the existing Session Store `todo_state` domain. This extends #15089 without changing the shared local CLI web-fetch behavior.

Native `web_fetch` is deferred by the [recorded issue decision](https://github.com/QwenLM/qwen-code/issues/15076#issuecomment-6321618001). An admitted Shell can use `run_shell_command` under its existing approval and deployment policy. File-only profiles do not gain network access. This change adds no network sandbox or outbound policy.

## Admission and ownership

- Only `hosted-workspace-files/3` and `hosted-workspace-shell/3` advertise `todo_write`. Earlier versions, team-lead and read-only child profiles retain their vocabulary. The saved profile is the enablement source; the Worker does not register `TodoWriteTool` or need a local Config flag.
- Stored Agent definitions may select `/3` when operators explicitly allow that profile. Public approval selection and the existing Plan admission gates recognize these profiles. Built-in defaults remain `/1`; no deployment setting is silently widened.
- The existing approval modes pre-approve Todo. Public Plan mode still refuses this writing tool. Recognition for approval does not promote `/3` into lifecycle, resident Workspace or SSH qualification.
- Harness validates the complete replacement list using core Todo validation, enforces a 16 KiB serialized-state ceiling, and refuses active/completed tasks whose dependencies are unfinished. Malformed calls produce correctable tool results before Runtime acquisition.
- Native fetch is excluded from declarations, input previews and Worker execution. Existing core web-fetch behavior is unchanged.

## Durable state and recovery

The tenant/workspace/session-scoped authority commits each full list with its existing writer lease, revision chain and resource store. A digest of the prompt ID and tool call ID identifies the command; the input digest detects conflicting retries. Replaying an earlier call returns that call's committed list without replacing a newer list.

State commits before its successful tool result, which includes structured `todos`. These are two ordered commits, not an atomic pair: a failure between them leaves durable state, and retrying the same command can recover its original result. This does not broaden recovery admission for interrupted tool batches. In particular, no new in-flight Shell recovery guarantee is claimed.

Each fresh model request receives the latest durable list in system context, including after reopening a Session or compacting conversation history. A frozen recovery request retains its original instructions until the next new request. Workspace recovery verifies Todo resource bodies and predecessor chains. Corrupt state fails rather than becoming an empty list. No SQL schema change is needed because the domain already exists.

## WebShell behavior

The Managed Session page reuses the existing Todo list. It shows the latest successful `todo_write` snapshot in loaded history; failed and pending calls do not overwrite it, and a successful empty list clears it. Refresh/reconnect rebuilds the projection from history. While history is loading the page shows loading state; when older pages remain it explicitly identifies the snapshot as coming from loaded records. This is not a separate server-side current-Todo query, and partial history must not be presented as a fully restored list.

Team `task_*` ownership is unchanged. This change injects current state; it does not force automatic continuation or promise that a model will complete every task.

## Acceptance and remaining qualification

1. `/3` advertises Todo without fetch; earlier profiles retain their tools. Java and Harness approval predicates agree for explicitly admitted `/3` definitions.
2. Valid Todo writes do not acquire or execute a Worker. Invalid lists and blocked-task transitions return correctable errors.
3. Reopening the same durable Session retains the latest list. Identical retries preserve it; changed input under the same command identity conflicts.
4. Fresh model requests receive current state; successful UI snapshots survive refresh and failed/pending calls do not replace them. Pagination limitations remain visible.
5. Fetch calls fail before dispatch and the Worker offers neither native fetch nor Todo.

Source regression cases cover these contracts where practical, but local tests, builds and UI/runtime verification were not run at the user's request. Java-to-Harness deployment, remote-store replay, fault recovery and visual qualification remain reviewer acceptance work. Keep #15076 open until that acceptance is complete; the proposal does not qualify new lifecycle, CSI, SSH or OS isolation support.
