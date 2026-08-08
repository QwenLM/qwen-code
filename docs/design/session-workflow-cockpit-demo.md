# Session Workflow Cockpit Demo

## Purpose

This branch turns the collaboration-cockpit reference into a real Web Shell page without introducing another workflow engine. The cockpit and the technical Workflow page are two projections of the same persisted session transcript and daemon task snapshot.

## Data and control flow

- A `todo_write` snapshot marked inside an enabled Plan/revision context supplies stable Todo IDs, status, content, and `blockedBy` dependencies. Ordinary Todo snapshots are ignored by the cockpit.
- Agent calls are linked to a Todo through `todo_id`; daemon task snapshots supply live status, activity, usage, and persisted transcript/output paths.
- `exit_plan_mode` remains the execution gate. When the experimental Session Workflow setting is enabled, a revision-bound approval opens the cockpit's four-step plan review before execution.
- Approval uses the existing permission API. The cockpit does not schedule, pause, or persist tasks itself.
- The shared Session header switches between Chat, the operational cockpit, and the technical Workflow DAG. Agent cards and activity rows open the existing transcript detail panel; deliverables open the existing artifact panel.
- `?view=cockpit` makes the cockpit directly addressable and browser navigation returns to Chat.
- The Session row menu can load a completed Session directly into its cockpit while the experiment is enabled.

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

1. The pending `exit_plan_mode` request opens the cockpit plan review with four nodes and the two-way fan-in dependency.
2. Approval starts execution and keeps the cockpit open as the live dashboard.
3. Selecting a Todo shows its dependencies and linked Agent; selecting the Agent opens its persisted transcript.
4. The shared Session header switches between **Chat / 驾驶舱 / Workflow** without leaving the Session.
5. Returning to Chat resumes the conversation. The header or `?view=cockpit` reopens the completed workflow later.

## Deliberate boundary

The reference design's synthetic organization-wide queues, policy engine, scheduler, Skill version catalog, and durable decision ledger are not reproduced. “待我处理” is derived from real failed/cancelled Agent tasks and the current permission request, so the page does not claim data the daemon does not provide.
