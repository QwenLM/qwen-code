# Fleet Preview

Fleet Preview coordinates a bounded group of supervised Qwen Code teammate processes. Teammates share tasks, exchange messages, and stream live semantic transcripts into the terminal workspace. Investigation teammates run with a runtime-enforced read-only tool set.

## Enable Fleet Preview

Set `experimental.fleet` to `true` in Qwen Code settings and restart. Fleet automatically enables the underlying Agent Team collaboration tools; you do not need to enable `experimental.agentTeam` separately.

## Coordinate an investigation

Run the bundled workflow with a goal:

```text
/coordinate investigate the authentication regression and recommend the smallest fix
```

The leader creates up to three read-only teammates, assigns separate workstreams, reconciles their evidence, and returns a consolidated result. Read-only teammates can inspect files and use team coordination tools, but cannot execute shell commands, modify files, save memory, schedule work, or spawn agents. If code changes are required, the leader performs them after accepting the investigation results.

On a wide terminal, the leader and at least two teammate transcripts appear at the same time. Narrow terminals, screen readers, dialogs, and native scrollback use the existing single-view tabs.

Fleet panes show structured Qwen Code transcripts rather than raw PTY output. Persistent sessions, crash reattachment, external attach, and arbitrary shell/TUI hosting are not included yet.

Plan-required teammate approval is not available in this preview; use read-only teammates for investigation workflows.
