# WebShell composer task chips

Supersedes the footer pill checks in
`2026-10-12-webshell-footer-agent-counter.md`: the bottom status-bar task
pill is gone, and unfinished background work is shown as chips directly
above the composer.

## Scenario

Open a Web Shell / Qwen Code Desktop session. In one conversation start a
dynamic workflow, a background shell command (for example a dev server),
and a background subagent (Agent tool with `run_in_background: true`).
Keep chatting until the workflow's tool call has scrolled far above the
fold. Then watch the chip row above the composer while the work runs and
finishes.

## Checks

- With nothing running, there is no chip row. A finished workflow, shell,
  monitor, or agent never leaves a "done" chip behind.
- While the work runs, the row shows one chip per kind, for example
  `1 workflow`, `1 local agent`, `1 shell`. A paused workflow keeps its
  chip; a paused (parked) agent does not.
- Clicking `1 workflow` scrolls the transcript to the call that started
  the run, unfolds its step group, and opens the live execution graph,
  which stays open when the run or the tool call completes.
- With two workflows running, `2 workflows` opens a list above the row
  with each run's label and elapsed time; picking one locates it. A run
  that has no row in the loaded transcript (started from the Workflows
  page) opens the Background tasks dialog instead.
- Clicking `1 shell` or `1 monitor` opens its output in the right panel;
  clicking `1 local agent` opens the subagent detail panel.
- When the last task of a kind finishes, its chip disappears.
- Down Arrow from an empty composer focuses the first chip; Left/Right
  move between chips; Down Arrow or Esc returns to the composer, and
  typing a character returns to the composer with that character.
- In a headerless embed (no environment panel), background agents get no
  chip; shells, monitors, and workflows do.
- A host that supplies its own footer gets no chip row; its footer keeps
  receiving the task list.

## Evidence

- Grouping rules: `packages/web-shell/client/utils/composerTasks.test.ts`.
- Chip row behavior (labels, single vs. several tasks, list, outside
  click, keyboard): `packages/web-shell/client/components/ComposerTaskChips.test.tsx`.
- Reveal requests that wait for a virtualized row and survive its
  immediate remount: `packages/web-shell/client/toolRevealContext.test.tsx`
  and the reveal cases in `components/messages/ToolGroup.test.tsx`.
- App wiring (snapshot, agents per entry, host footer, workflow locate and
  fallback, shell/monitor/agent panels in both entries):
  `packages/web-shell/client/App.test.tsx`.
- Real browser against the mock daemon:
  `packages/web-shell/client/e2e/web-shell.composer-task-chips.spec.ts`
  (locate and open an off-screen run, the multi-run list with the
  dialog fallback, no chip for a finished run).

A baseline dry-run against the global `qwen` CLI is not applicable: the
chips are a Web Shell surface and the CLI TUI does not render them.
