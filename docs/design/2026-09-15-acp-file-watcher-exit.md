# ACP file watcher cleanup during process exit

[English](2026-09-15-acp-file-watcher-exit.md) |
[简体中文](2026-09-15-acp-file-watcher-exit.zh-CN.md)

## Problem and evidence

On macOS, shutting down an ACP process with 32 user skills can block inside
`fs.FSWatcher.close()`. libuv synchronously waits for FSEvents to rebuild its
remaining watch stream. The parent kills the child after its existing five-second
TERM grace, and the daemon exits 1 although the HTTP/SSE session flow succeeded.
Two runs of the installed CLI reproduced this, including one without diagnostic
instrumentation. A native stack and watcher trace identify the workspace watcher
close during Config shutdown. This evidence does not attribute all earlier
intermittent failures to the same operation.

A diagnostic probe preserved normal watcher closes before SIGTERM, then left
native handles for process exit. With 73 native watches, both ordinary session
closes completed and all 71 remaining handles were reclaimed on a successful
process exit. This establishes that Node can exit without explicitly closing
these watchers. The original reproduction now passes with the production fix;
full shutdown acceptance remains open as recorded below.

## Decision and scope

Keep native watching and ordinary watcher cleanup unchanged. Only when the ACP
CLI process is committed to exiting, stop forwarding watch events on macOS and
let the operating system reclaim its watch handles at process exit. This avoids
blocking subsequent writer, lock, hook, tool and subprocess cleanup. It does not
skip those cleanups, change their failure reporting, extend the parent deadline,
or enable polling.

This is a separate behavioral fix from the no-behavior-change bridge extraction
in #11866. Slow watcher closure while the process remains alive is outside this
fix. Windows and Linux still explicitly close watchers during exit.

## Ownership and implementation

`prepareFileWatchersForProcessExit()` sets process-local terminal state. It has
three call sites: the ACP signal handler before shutdown begins, ACP connection
EOF before cleanup, and the CLI's ACP finally block before exit cleanup (including
setup failure). The only production caller of `runAcpAgent` is the CLI entry,
which exits after this cleanup; signal handlers also explicitly exit. This
terminal state must never be set for individual session closes or by an embedded
runtime that will continue serving. It is intentionally irreversible.

`closeFileWatcher()` preserves synchronous close invocation, thrown errors and
the original close promise during normal operation. In terminal macOS cleanup it
detaches `all` (Chokidar) and `change` (native) listeners. Existing error listeners
remain attached so a late native error cannot become an unhandled EventEmitter
error. Handles remain open only until the already-planned process exit.

All consumers are explicit:

| Consumer             | Watched data                                  | Normal cleanup                    |
| -------------------- | --------------------------------------------- | --------------------------------- |
| SettingsWatcher      | User/workspace settings directories and files | Replacement and stop              |
| SkillManager         | User/project skill directories                | Removed watch targets and stop    |
| ExtensionFileWatcher | Extension roots and bootstrap directory       | Bootstrap promotion and stop      |
| LspConfigWatcher     | Workspace LSP configuration                   | Stop                              |
| CronScheduler        | Durable task directory                        | Stop and relinquish participation |

Each retains its own timer, generation, subscription and lock cleanup. No Config
option, ACP wire field, parent process state or session ownership rule is added.

## Verification and acceptance

- Unit coverage: normal close invocation/promise/errors; macOS terminal event
  suppression without native close; retained error handling; Linux/Windows close.
- CLI coverage: no terminal state before shutdown, state set before writer or
  resource cleanup on signals and EOF, and setup-failure cleanup. Existing managed
  writer failure and pending-initialization tests must still pass.
- Existing watcher and cron tests must continue proving ordinary stop/restart and
  lock behavior. Build, typecheck and affected package tests are required.
- Re-run the 32-skill public daemon scenario with the local bundle, native watching,
  no polling or preload. Require actual daemon exit 0, no forced child shutdown,
  and no leftover process or listener. Also cover EOF and live-session shutdown.
- Audit the complete fix and independently review terminal-state ownership and
  every watcher consumer. Do not claim a permanent fix until verification passes.

## Observed verification results before the process-query follow-up

On this macOS host, the local bundle with native watching and no diagnostic
preload or polling override passed the original 32-skill daemon scenario,
direct ACP EOF, and shutdown with two live sessions. The latter sealed both
writer records with matching transcript lengths and hashes. Independent checks
found no persistent process or listening port. EOF briefly retained a `ps`
descendant at 54 ms; it was gone by 215 ms.

Full acceptance remains open: an earlier live-session sample exited 1 because
the process-tree query had no parseable rows. The raw query output was not
captured, so this does not establish that stdout was empty or identify the
cause. A bounded diagnostic rerun captured 714 valid rows and exited 0; it did
not reproduce or explain that failure. Strict shutdown error reporting remains
unchanged. Successful samples do not invalidate the failed one.

Build, typecheck, bundle and targeted lint passed. The first affected test run
passed all 1,145 tests. An independent core rerun failed a 600 ms native-watcher
assertion and a cleanup-hook timeout; a targeted comparison using exact HEAD
scheduler source failed the same watcher assertion on both versions. The hook
timeout did not recur and remains unexplained. Five selected managed-shutdown
tests still reject failures and retain exit code 1. Two self-audit passes and an
independent review found no source defect. These results do not establish that
all tests are consistently green or that #11866 is complete.

The subsequent [process-query output fix](2026-09-15-acp-process-query-output.md)
reproduces and repairs a controlled timeout-related output-loss mechanism.
Native-watching 32-skill and active-writer shutdown checks also pass with that
fix. It does not retrospectively attribute the untraced query failure above.
A later EOF test captured a truncated notification; one bounded rerun passed,
leaving that observation unresolved. See the linked design for current evidence
and the limits of the scoped query-fix conclusion.

## Combined verification after the EOF fix

The later [EOF output fix](2026-09-15-acp-eof-output.md) establishes a controlled
truncation reproduction and verifies complete accepted frames before successful
exit. It does not assign a cause or exit code to earlier incomplete observations.
The final combined bundle again passed the native-watching 32-skill public flow
and shutdown with two active writers. Both daemons exited 0, both active records
were sealed with matching transcript lengths and hashes, and independent checks
found no owned process or listener remaining. Direct ACP EOF cases separately
recorded actual ACP exit 0; child absence in a daemon case is not a measured
child exit code.

After the installed Ink patch was restored and the bundle rebuilt, these same
native-watching and active-writer scenarios passed again, with actual daemon
exit 0 and matching sealed transcript lengths and hashes. All eight combined
E2E checks met their acceptance conditions with the new 1,079-file artifact
unchanged and no owned process or listener remaining.

Normal session DELETE requests still showed multi-second stalls
within the existing E2E deadline. No latency equivalence or new cause is claimed;
ordinary watcher-close performance remains outside this terminal-exit fix. The
untraced historical query failure and the earlier cron timing observations remain
recorded. Repository-wide results are maintained in the
[completion design](2026-09-15-acp-bridge-completion.md).
