# WebShell footer agent counter (background subagents)

## Scenario

Open a Web Shell / Qwen Code Desktop session. Launch three background
subagents in one turn (Agent tool with `run_in_background: true`). Watch the
composer footer status-bar pill while they run, until all three finish.

## Checks

- While all three agents are running, the pill shows `3 local agents`.
- With one background shell command running alongside, the pill shows
  `1 shell, 3 local agents`.
- As each agent reaches a terminal state, the count decreases (3 → 2 → 1 →
  cleared) without a separate "done" line for agents.
- Foreground Agent calls never contribute to the count.
- With no background tasks at all, the pill is empty (no "0 local agents").
- The pill opens the Tasks panel on click, as before.

## Evidence

The label logic is covered by unit tests
(`packages/web-shell/client/components/StatusBar.test.tsx`, 9 cases including
the regression cases for the pre-existing shell/done labels):

```sh
cd packages/web-shell
pnpm exec vitest run --config vitest.config.ts components/StatusBar.test.tsx
```

The live Desktop scenario above is verified manually: launch three background
agents in one turn and observe the pill counting down as agents finish.

A baseline dry-run against the global `qwen` CLI is not applicable: the pill
is a Web Shell surface and the CLI TUI does not render it.
