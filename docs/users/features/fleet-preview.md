# Fleet Preview

Fleet Preview coordinates a bounded group of Qwen Code teammates inside the leader process. Teammates share tasks, exchange messages, and appear in the existing Agent View tabs. Investigation teammates run with a runtime-enforced read-only tool set.

## Enable Fleet Preview

Set `experimental.fleet` to `true` in Qwen Code settings and restart. Fleet automatically enables the underlying Agent Team collaboration tools; you do not need to enable `experimental.agentTeam` separately.

## Coordinate an investigation

Run the bundled workflow with a goal:

```text
/coordinate investigate the authentication regression and recommend the smallest fix
```

The leader creates up to three read-only teammates, assigns separate workstreams, reconciles their evidence, and returns a consolidated result. Read-only teammates can inspect files and use team coordination tools, but cannot execute shell commands, modify files, save memory, schedule work, or spawn agents. If code changes are required, the leader performs them after accepting the investigation results.

This preview is intentionally in-process. Independent subprocess teammates, supervisor transport, persistence, recovery, and terminal attach are not included yet.
