# `/schedule` — Local Always-On Scheduled Tasks (Daemon) Design

**Status:** Design agreed (brainstorming). Ready for Phase 0 implementation planning.
**Date:** 2026-07-01

## Goal

Add a `/schedule` command and a companion `qwen schedule daemon` so users can define
tasks that run **on a cron schedule on the local machine, continuously, without an
interactive session open** — the local analogue of Claude Code's _Desktop scheduled
tasks_ (and of Anthropic's not-yet-shipped "Chyros" always-on daemon). Because we have
no centralized server, execution happens on the user's own machine.

This is distinct from `/loop`: `/loop` is session-scoped (must keep a session open, has a
7-day cap). `/schedule` tasks live in a global store and fire from a long-lived local
daemon, so they keep running after the terminal is closed.

## Background — what already exists (and what we reuse)

qwen-code already ships ~80% of the substrate. The gap is only the _always-on host_ plus
a first-class UX and result delivery.

Already present:

- **Cron tooling & math:** `CronCreate`/`CronList`/`CronDelete` tools, 5-field cron
  parsing/formatting (`packages/core/src/utils/cronParser.ts`,
  `packages/core/src/utils/cronDisplay.ts`).
- **Durable (file-backed) scheduler:** `packages/core/src/services/cronScheduler.ts`
  with a 1s tick, deterministic jitter, missed-fire catch-up, cross-session file
  locking (`cronTasksLock.ts`), and confirm-first delivery of missed one-shots
  (`buildMissedCronNotification`). Durable tasks persist to
  `~/.qwen/tmp/<project-hash>/scheduled_tasks.json` (`cronTasksFile.ts`).
- **Headless execution:** `qwen -p "<prompt>" --yolo --approval-mode <mode>
--max-wall-time <t> -o stream-json`, with exit codes and session resume
  (`packages/cli/src/nonInteractiveCli.ts`).
- **`qwen serve` daemon** (HTTP/web-shell/ACP) — a proven long-lived process shape
  (`packages/cli/src/commands/serve.ts`), though it does **not** currently host the
  scheduler.
- **Channels** (Telegram / Feishu / DingTalk / WeChat / QQ) — a ready-made result-push
  path (`packages/channels/*`), deferred to a later phase.

**The one real gap:** durable tasks only _fire_ while some qwen process is running and
holds the lock. With no session open they sit dormant until a session next starts (then
one-shots surface as "missed", overdue recurring get a catch-up). Nothing keeps the
scheduler alive on its own.

Reference implementation confirmed (Claude Code Desktop scheduled tasks):

- The host is the always-open desktop app; there is **no** launchd/OS-cron entry.
- A task = `~/.claude/scheduled-tasks/<taskId>/SKILL.md` (self-contained prompt).
- Each fire spawns a **fresh** session; results are delivered via notification + a
  "Scheduled" session in the sidebar.
- The always-on background daemon ("Chyros") is announced but **unshipped**.

## Design decisions (agreed)

| #   | Decision                                                                                                                                                                 | Rationale                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Dedicated `qwen schedule daemon`** is the execution host (not OS-cron, not `serve`, not a desktop shell).                                                              | Reuses the existing durable-cron math; cross-platform; works for pure-CLI users. Optional OS auto-start is layered on later as a _single_ supervisor entry.                                                                                        |
| D2  | **Each fire = a fresh `qwen -p` child process**, cwd = the task's cwd.                                                                                                   | Matches Claude ("each run starts fresh, no memory"); full isolation between tasks; daemon context never grows; reuses the headless path. The daemon is a thin schedule→spawn→collect shell.                                                        |
| D3  | **Task = self-contained `SKILL.md`** in a **global** store `~/.qwen/scheduled-tasks/<taskId>/`.                                                                          | Parity with Claude, but more self-contained: schedule/cwd/model live in frontmatter, so a task is portable, reviewable, and git-manageable.                                                                                                        |
| D4  | **Definition (`SKILL.md`) and runtime state (`state.json`) are separate files.**                                                                                         | The daemon writes `lastFiredAt`/`nextRunAt` without ever touching the user's `SKILL.md`; definitions stay clean.                                                                                                                                   |
| D5  | **No 7-day expiry for daemon tasks.**                                                                                                                                    | The 7-day cap is a `/loop` session guardrail; routines are meant to run indefinitely.                                                                                                                                                              |
| D6  | **Delivery (MVP) reuses the missed/completed-notification pipeline** + a per-run record. Channels push deferred.                                                         | Zero new dependencies; on next interactive startup the user gets "N scheduled runs completed + summaries" (confirm-first, like `buildMissedCronNotification`).                                                                                     |
| D7  | **Per-task permission = existing `ApprovalMode`** (`plan`/`default`/`auto-edit`/`auto`/`yolo`), passed through as `--approval-mode`. No bespoke `allowDestructive` flag. | Reuses `packages/core/src/config/config.ts` `ApprovalMode`. Unattended, a blocked tool is **denied and recorded in the run summary** (no human to prompt). Recommended default: `auto` (classifier auto-approves safe actions, blocks risky ones). |
| D8  | **`/schedule` and `/loop` stay separate**, sharing only the cron math.                                                                                                   | No risk to existing `/loop` behavior; the new global SKILL.md store is additive.                                                                                                                                                                   |

## Architecture

```
/schedule (slash command)          manage: create / list / update / run / delete / logs
        │  read/write
   Task store  ~/.qwen/scheduled-tasks/<taskId>/
        │      ├─ SKILL.md          definition (frontmatter + self-contained prompt)
        │      ├─ state.json        runtime: lastFiredAt / nextRunAt / lastRunId / enabled-override
        │      └─ runs/<runId>.jsonl + summary.md
        │  load + watch
  qwen schedule daemon              single-owner lock + 1s tick + dir watch
        │  due
   spawn `qwen -p <prompt> --approval-mode <m> --model <m> -o stream-json`  (cwd = task.cwd)
        │  finished
   write runs/<runId> + summary
        │  next interactive startup
   "N scheduled runs completed + summaries"   (reuse missed-notification delivery)
```

Components:

1. **Task store** — global, one directory per task. Definition vs. runtime state split (D4).
2. **Scheduler engine (reused math)** — `cronParser` + the tick/jitter/catch-up/missed
   logic from `cronScheduler.ts`. Implementation choice deferred: generalize
   `CronScheduler` to accept a pluggable task source + fire action, **or** build a slim
   `ScheduleDaemon` that reuses only the pure helpers. Decide when we touch the code;
   whichever keeps `/loop`'s durable path untouched wins.
3. **The daemon** — `qwen schedule daemon`: single-owner lock
   (`~/.qwen/scheduled-tasks/daemon.lock`), 1s tick, watches the store dir for hot
   reload, spawns a child per due task, collects the transcript. Drops the 7-day expiry.
4. **Fire = fresh child** (D2) — writes `runs/<runId>.jsonl` + `summary.md`.
5. **Delivery** — reuse `buildMissedCronNotification`-style confirm-first surfacing on the
   next interactive startup (D6).

## Data model

`~/.qwen/scheduled-tasks/<taskId>/SKILL.md`:

```markdown
---
name: daily-pr-review
description: Review the day's new PRs each weekday morning
schedule:
  cron: '0 9 * * 1-5' # OR fireAt: "2026-07-02T15:00:00+08:00" (one-shot, auto-disables)
  enabled: true
cwd: /Users/dragon/Documents/qwen-code # where it runs; defaults to cwd at creation
model: claude-opus-4-8 # per-task model selection
approvalMode: auto # plan | default | auto-edit | auto | yolo
notify: next-session # phase 2: + channel:feishu
sandbox: false # optional, orthogonal
---

You are the PR reviewer for this repo. Each run: cd into the cwd, use `gh` to list PRs
opened in the last 24h, review each, leave inline comments, and give a one-line verdict.
Be fully self-contained — assume no memory of any prior conversation.
```

`state.json` (daemon-owned, never in the user's `SKILL.md`):

```json
{ "lastFiredAt": 1751... , "nextRunAt": 1751..., "lastRunId": "ab12cd34", "enabledOverride": null }
```

- Cron is evaluated in **local time**. Schedule is `cron` XOR `fireAt` (or neither = ad-hoc,
  manual-only), mirroring the reference tool.
- Deterministic jitter carries over from the existing scheduler (spread API load).

## Command surface

Built with the existing `SlashCommand.subCommands` pattern
(`packages/cli/src/ui/commands/`).

- `/schedule <natural language>` — e.g. `/schedule review new PRs at 9am on weekdays`.
  The model resolves it to cron + prompt + cwd + model and **confirms before writing**
  the `SKILL.md` (parity with `create_scheduled_task`'s "approval is the confirmation").
- `/schedule list` — id / schedule / enabled / nextRun / lastRun / cwd.
- `/schedule update <id>` — change schedule / prompt / model / approvalMode / enabled.
- `/schedule run <id>` — fire once immediately.
- `/schedule delete <id>` — remove.
- `/schedule logs <id>` — show recent run records.
- `/schedule daemon status | start | stop` — manage the host.

## Daemon lifecycle

- **Auto-spawn:** creating the first enabled task checks whether the daemon is alive
  (lock/pid); if not, `/schedule` spawns a **detached** background `qwen schedule daemon`.
  Transparent to the user.
- **Keep-alive:** detached, survives terminal close; the lock file prevents multiple
  instances; a crash is recovered on the next `/schedule` operation.
- **Reboot auto-start (Phase 2, optional):** `qwen schedule daemon install` writes **one**
  OS-level supervisor entry (macOS launchd LaunchAgent / Linux systemd user unit /
  Windows Task Scheduler) whose sole job is to (re)start the single daemon after a
  reboot/crash — one entry total, not one-per-task. This is what delivers true
  "runs after reboot", and is the part Claude's Chyros hasn't shipped.

## Execution & delivery flow

1. Tick finds a due task; daemon marks it firing (in-memory + `state.json`).
2. Spawn `qwen -p <prompt> --approval-mode <mode> --model <model> -o stream-json`
   (cwd = task.cwd; add `--sandbox` if set; add a `--max-wall-time` safety cap).
3. Stream the transcript to `runs/<runId>.jsonl`; write a short `summary.md`.
4. Update `state.json` (`lastFiredAt`, `nextRunAt`, `lastRunId`).
5. On the next interactive qwen startup, surface a confirm-first
   "N scheduled runs completed since you were away — summaries: …" notification,
   reusing the missed-fire delivery pipeline.

## Permissions (D7)

Per-task `approvalMode` from the existing enum, passed through to the child. Because no
human is present, a mode that would prompt instead **denies and records** the action in
the run summary — no stalling. Recommended default `auto`. `yolo` for full autonomy;
`auto-edit`/`default`/`plan` available but progressively more restricted in an unattended
context.

## Scope: reuse / drop / defer

- **Reuse:** cron parse/format, tick/jitter/catch-up/missed math, file-lock pattern,
  headless run path, `SlashCommand` subcommands, `ApprovalMode`, missed-notification
  delivery.
- **Drop for daemon tasks:** the 7-day recurring expiry (D5).
- **Defer:** channels push, one-shot `fireAt` reminders polish, OS reboot auto-start,
  forced sandbox, event triggers (local GitHub-webhook forwarding).

## Reuse map (concrete files)

- Scheduling math: `packages/core/src/services/cronScheduler.ts`,
  `packages/core/src/utils/cronParser.ts`, `cronDisplay.ts`.
- File lock pattern: `packages/core/src/services/cronTasksLock.ts`,
  `cronTasksFile.ts`.
- Headless host template: `packages/cli/src/nonInteractiveCli.ts` (cron hold-open,
  `enableDurable`, `setSkipDurableFire`).
- Daemon process shape: `packages/cli/src/commands/serve.ts`, `packages/cli/src/serve/`.
- Command wiring: `packages/cli/src/ui/commands/`,
  `packages/cli/src/services/BuiltinCommandLoader.ts`, `ui/commands/types.ts`.
- Approval modes: `packages/core/src/config/config.ts` (`ApprovalMode`).

## Rollout phases

- **Phase 0 (MVP):** SKILL.md store; `qwen schedule daemon` (foreground OK); `/schedule`
  create/list/delete/run; fresh-child firing; run records; next-session catch-up
  delivery. Daemon started manually.
- **Phase 1:** daemon auto-spawn/keep-alive; `update`/`logs`; NL-create polish;
  summarize actions blocked by `auto` mode.
- **Phase 2:** reboot auto-start `install`; channels push; one-shot `fireAt` reminders;
  optional forced sandbox.
- **Phase 3 (optional):** event triggers (local webhook forwarding), moving toward the
  multi-trigger shape of cloud routines.

## Open questions / risks

- **Engine reuse vs. fork** — generalize `CronScheduler` or extract pure helpers into a
  slim `ScheduleDaemon`. Resolve at implementation; must not regress `/loop`'s durable
  path.
- **Daemon ↔ interactive coexistence** — the global daemon store is separate from the
  per-project durable-cron store, so double-firing is avoided by construction; still add a
  single-owner lock for the daemon itself.
- **cwd trust** — a task's cwd may be an untrusted folder; respect the existing
  folder-trust gate before granting privileged approval modes.
- **Runaway/cost control** — enforce a per-task `--max-wall-time` (and consider a
  max-concurrent-fires cap in the daemon).
- **Secrets in prompts** — `SKILL.md` is git-manageable; document that secrets belong in
  env/connectors, not the prompt body.

## Testing

- Unit: cron matching/jitter/catch-up reuse tests; SKILL.md parse/serialize; state.json
  read-modify-write; daemon single-owner lock.
- Integration: create a task with a near-future `fireAt`, run the daemon, assert a child
  spawns in the right cwd with the right `--approval-mode`, a run record is written, and
  the next interactive startup surfaces the completion notice.
