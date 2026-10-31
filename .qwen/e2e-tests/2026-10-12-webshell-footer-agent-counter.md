# WebShell footer agent counter (background subagents)

## Scenario

Open a Web Shell / Qwen Code Desktop session and start a conversation
(the chat must be non-empty: in the shipped entry the environment panel
replaces the footer task list while no background agent runs, so the
pill stays empty until the first agent starts). Launch three background
subagents in one turn (Agent tool with `run_in_background: true`). Watch
the composer footer status-bar pill while they run, until all three
finish.

## Checks

- Non-empty chat, no background agent: the pill is empty in the shipped
  entry — the environment panel owns the task list.
- While all three agents are running, the pill shows `3 local agents`.
- With one background shell command running alongside, the pill shows
  `1 shell, 3 local agents`.
- If an agent is parked by a session restart or resume while the others
  run (an approval prompt does NOT park it — that agent keeps running),
  the pill labels the parked one separately: `2 local agents, 1 local
  agent paused`. The paused label is visible only while at least one
  running agent keeps the pill open in the shipped entry.
- As each agent reaches a terminal state, the count decreases (3 → 2 →
  1 → cleared) without a separate "done" line for agents; once the last
  background agent finishes, the pill is suppressed again in the shipped
  entry.
- A paused agent alone (no running agent) does not re-open the pill in
  the shipped entry: parked work stays visible in the environment
  panel's subagents section.
- Foreground Agent calls never contribute to the count.
- The pill opens the Tasks panel on click, as before.

## Evidence

The label logic is covered by unit tests
(`packages/web-shell/client/components/StatusBar.test.tsx`, 12 cases
including the regression cases for the pre-existing shell/done labels).
The footer wiring is covered by App-level tests
(`packages/web-shell/client/App.test.tsx`): the pill receives the task
snapshot while a background agent runs, stays suppressed in the shipped
entry without one, and a host-provided footer receives agent tasks.

```sh
cd packages/web-shell
pnpm exec vitest run --config vitest.config.ts components/StatusBar.test.tsx client/App.test.tsx
```

A live Desktop observation of this countdown has not been recorded yet
(the PR's Risk & Scope lists "a live Desktop screenshot of the footer
pill" as not validated). The label logic and the App-level wiring are
unit-tested, and the scenario above is reproducible as written.

A baseline dry-run against the global `qwen` CLI is not applicable: the
pill is a Web Shell surface and the CLI TUI does not render it.
