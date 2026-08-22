# Session Workflow Demo

## Purpose

This branch turns the collaboration-cockpit reference into a real Web Shell page without introducing another workflow engine. One Workflow view combines the existing execution graph with activity, deliverables, and items that need attention, all projected from the persisted session transcript and daemon task snapshot.

## Data and control flow

- A `todo_write` snapshot marked inside an enabled Plan/revision context supplies stable Todo IDs, status, content, and `blockedBy` dependencies. Ordinary Todo snapshots are ignored by Workflow.
- Agent calls are linked to a Todo through `todo_id`; daemon task snapshots supply live status, activity, usage, and persisted transcript/output paths.
- `exit_plan_mode` remains the execution gate. When the experimental Session Workflow setting is enabled, its revision-bound approval stays in the existing Chat approval flow.
- Approval uses the existing permission API. Workflow does not schedule, pause, or persist tasks itself.
- The shared Session header switches between Chat and Workflow. Workflow reuses the existing execution graph; Agent cards and activity rows open the existing transcript detail panel, and deliverables open the existing artifact panel.
- `?view=cockpit` makes the cockpit directly addressable and browser navigation returns to Chat.
- A completed Session restores its Workflow entry from the marked Todo snapshot when the Session is opened normally.

## Demo

From the repository root, start the daemon and Web Shell in separate terminals. Generate the daemon token in the first terminal and copy the printed value for the browser URL below:

Terminal 1:

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"
printf 'Demo token: %s\n' "$QWEN_SERVER_TOKEN"
npm run dev -- serve --port 4293 --workspace "$PWD" --no-web
```

Terminal 2:

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4293 npm run dev --workspace @qwen-code/web-shell -- --host 127.0.0.1 --port 5294
```

Enable **Experimental → Session Workflow Plan & Review**, enter Plan & Review mode, and send:

> Prepare a five-bullet repository orientation. Before doing any inspection, call todo_write with exactly these pending steps and dependency IDs: inspect-readme; inspect-package; compare-findings blocked by inspect-readme and inspect-package; write-summary blocked by compare-findings. Immediately call exit_plan_mode. After approval, launch exactly two Explore subagents in parallel: one reads only README.md and returns at most three bullets; the other reads only package.json and returns at most three bullets. Pass todo_id inspect-readme and inspect-package to the matching Agent calls. Do not run shell commands or edit files. Update the Todo statuses as each phase completes and return at most five bullets.

The cockpit is also directly addressable after the Session exists:

```text
http://127.0.0.1:5294/session/<session-id>?token=<copied-token>&view=cockpit
```

Expected flow:

1. The pending `exit_plan_mode` request shows the existing in-flow plan approval in Chat.
2. Approval starts execution; the user can open Workflow without interrupting the conversation.
3. Selecting a Todo shows its dependencies and linked Agent; selecting the Agent opens its persisted transcript.
4. The shared Session header switches between **Chat / Workflow** without leaving the Session.
5. Returning to Chat resumes the conversation. The header or `?view=cockpit` reopens the completed workflow later.

## Deliberate boundary

The reference design's synthetic organization-wide queues, policy engine, scheduler, Skill version catalog, and durable decision ledger are not reproduced. “待我处理” is derived from real failed/cancelled Agent tasks; permission requests remain in Chat, so the page does not claim data the daemon does not provide.
