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

On a wide terminal, the leader appears beside its teammate transcripts — one teammate is enough to get the side-by-side view. Narrow terminals, screen readers, dialogs, and native scrollback use the existing single-view tabs.

Fleet panes show structured Qwen Code transcripts rather than raw PTY output. Persistent sessions, crash reattachment, external attach, and arbitrary shell/TUI hosting are not included yet.

Plan-required teammate approval is not available in this preview; use read-only teammates for investigation workflows.

## Troubleshooting

Teammates and the supervisor are separate OS processes detached from your
terminal, so their output goes to log files rather than to the screen.

| What                                                | Where                                |
| --------------------------------------------------- | ------------------------------------ |
| One teammate's output                               | `~/.qwen/jobs/<agent-id>/worker.log` |
| Supervisor output                                   | `~/.qwen/daemon/supervisor.log`      |
| Leader-side Fleet tracing (`QWEN_FLEET_DEBUG` only) | `~/.qwen/daemon/fleet-debug.log`     |

Each teammate log is truncated when that teammate starts, so it always
describes the current run.

When a teammate fails to start, the leader reports the exit code and names the
log file. Read that log first — a teammate that dies during startup usually
died on authentication or configuration, and the reason is at the end of the
file:

```bash
tail -50 ~/.qwen/jobs/<agent-id>/worker.log
```

### Verbose tracing

Set `QWEN_FLEET_DEBUG=1` before launching Qwen Code to add lifecycle
breadcrumbs around the parts that run before a teammate can report anything
over the socket — spawn, config load, authentication, handshake:

```bash
QWEN_FLEET_DEBUG=1 qwen
```

Breadcrumbs from a teammate go to that teammate's `worker.log`; breadcrumbs
from the leader go to `~/.qwen/daemon/fleet-debug.log`, because the leader's
own stderr belongs to the terminal UI.

To watch a run as it happens:

```bash
tail -f ~/.qwen/daemon/fleet-debug.log ~/.qwen/jobs/*/worker.log
```

### Confirming teammates are real processes

```bash
pgrep -af internal-fleet-teammate
```

Each teammate is a separate `qwen --internal-fleet-teammate` process with its
own PID, supervised by a single `qwen --internal-agent-view-supervisor`
process.
