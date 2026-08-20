# `qwen serve` Daemon File Logger — Design

- **Issue**: [QwenLM/qwen-code#4548](https://github.com/QwenLM/qwen-code/issues/4548)
- **Branch**: `feat/support_daemon_logger`
- **Status**: design approved, awaiting implementation plan
- **Date**: 2026-05-26

## 1. Problem

`qwen serve` emits daemon-level diagnostics (lifecycle, route errors, ACP child stderr) to `process.stderr`. That works under systemd/Docker but is fragile for SDK / Desktop / local daemon use: when a client sees `POST /session/:id/prompt` return HTTP 500, the route + session + stack context is gone unless the operator manually redirected stderr.

`createDebugLogger` (in `packages/core/src/utils/debugLogger.ts`) is session-scoped: it requires an active `DebugLogSession` and writes to `${runtimeBaseDir}/debug/<sessionId>.txt`. The serve daemon starts **before** any session exists, so daemon-level calls would silently no-op. It also can't be reused without changing the per-session `debug/latest` semantics.

This design adds a daemon-specific file sink, additive to existing stderr behavior, so daemon diagnostics survive without shell redirection.

## 2. Scope

### In scope

- A new logger initialized once per `runQwenServe` process.
- File at `${QWEN_RUNTIME_DIR or ~/.qwen}/debug/daemon/<daemon-id>.log`, append mode.
- Tee of:
  - `runQwenServe.ts` lifecycle / shutdown / signal messages
  - `sendBridgeError` (`server.ts`) route errors
  - `bridge.ts` `writeServeDebugLine` (when `QWEN_SERVE_DEBUG` is set)
  - `spawnChannel.ts` ACP child stderr forwarding
- Opt-out via `QWEN_DAEMON_LOG_FILE=0|false|off|no`.
- `latest` symlink in the daemon dir for `tail -f`.
- Documentation in serve CLI docs.

### Out of scope (non-goals from issue)

- Replacing OpenTelemetry or adding daemon tracing.
- Structured enterprise error log export (issue #2014).
- Rotation or deletion of existing session debug logs.
- Log rotation / size cap for the daemon log itself (deferred to a follow-up PR). A boot-time stderr warning is emitted if the existing file is unusually large; no automatic action.

## 3. Architecture

### 3.1 Module boundaries

| Layer                                                   | New / Changed | Responsibility                                                                                                                                |
| ------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/daemonLogger.ts`                | **new**       | Sink: init, format, append-to-file, tee-to-stderr, flush, latest-symlink                                                                      |
| `packages/cli/src/serve/runQwenServe.ts`                | changed       | Init logger at boot; replace lifecycle `writeStderrLine` with `daemonLog.*`; `await flush()` on shutdown; pass `onDiagnosticLine` into bridge |
| `packages/cli/src/serve/server.ts`                      | changed       | `sendBridgeError(...)` routes through `daemonLog.error(...)`                                                                                  |
| `packages/acp-bridge/src/types.ts` (`BridgeOptions`)    | changed       | Add optional `onDiagnosticLine?: (line: string, level?: 'info' \| 'warn' \| 'error') => void`                                                 |
| `packages/acp-bridge/src/bridge.ts:writeServeDebugLine` | changed       | If `onDiagnosticLine` injected, tee the same line                                                                                             |
| `packages/acp-bridge/src/spawnChannel.ts`               | changed       | Child stderr forwarder tees each prefixed line into `onDiagnosticLine`                                                                        |

**Design intent**: `daemonLogger.ts` is single-file, cli-local, no global singleton. `acp-bridge` stays ignorant of cli — it only sees a callback. Dependency graph unchanged.

### 3.2 No global singleton

Logger is created in `runQwenServe`, passed by closure to internal serve modules that need it (or by callback to `acp-bridge`). Rationale:

- Mirrors how `BridgeOptions` already injects dependencies.
- Avoids the cross-test state leaks `debugLogger` has hit historically (`resetDebugLoggingState()` exists for that reason).

## 4. Daemon ID & File Path

- Path: `Storage.getGlobalDebugDir() + '/daemon/<daemon-id>.log'`
  - Resolves to `${QWEN_RUNTIME_DIR or ~/.qwen}/debug/daemon/<daemon-id>.log`.
  - Reuses `Storage.getGlobalDebugDir()` so the runtime-dir override (env var, contextual) automatically applies.
- `daemon-id` = `serve-${pid}-${workspaceHash}`
  - `workspaceHash` = `crypto.createHash('sha256').update(boundWorkspace).digest('hex').slice(0, 8)`
  - `pid` disambiguates multiple daemons on the same workspace.
  - `workspaceHash` is fixed-length, filename-safe, and stable for the same workspace path.
- `latest` symlink: `~/.qwen/debug/daemon/latest` → current process's log file. Updated on init using the existing `updateSymlink` helper (`packages/core/src/utils/symlink.ts`). Symlink failure is logged and ignored — does not degrade primary writes. Distinct from `${runtimeBaseDir}/debug/latest` (session-scoped) per non-goal.
- File mode: `'a'` (append on `O_APPEND | O_CREAT`). Existing files survive restarts for forensics.

## 5. Public API

```ts
// packages/cli/src/serve/daemonLogger.ts

export interface DaemonLogContext {
  route?: string;
  sessionId?: string;
  clientId?: string;
  childPid?: number;
  channelId?: string;
  [key: string]: unknown;
}

export interface DaemonLogger {
  info(message: string, ctx?: DaemonLogContext): void;
  warn(message: string, ctx?: DaemonLogContext): void;
  /**
   * `err.stack` is appended as indented continuation lines after the message.
   * Both `err` and `ctx` are optional and independent.
   */
  error(message: string, err?: Error | null, ctx?: DaemonLogContext): void;
  /**
   * File-only tee for lines whose caller is already writing to stderr
   * (ACP child stderr forwarder, `writeServeDebugLine`). The line is
   * appended to the daemon log under the standard `<timestamp> [<LEVEL>] [DAEMON] `
   * prefix; it is NOT echoed to stderr (which would double the operator's output).
   */
  raw(line: string, level?: 'info' | 'warn' | 'error'): void;
  /** Absolute path to the daemon log file. */
  getLogPath(): string;
  /** `serve-<pid>-<workspaceHash>`. */
  getDaemonId(): string;
  /** Drain pending appends. Called from runQwenServe shutdown handler. */
  flush(): Promise<void>;
}

export interface InitDaemonLoggerOptions {
  boundWorkspace: string;
  pid?: number; // default process.pid
  now?: () => Date; // default () => new Date()
  stderr?: (line: string) => void; // default writeStderrLine
  baseDir?: string; // default Storage.getGlobalDebugDir()
}

export function initDaemonLogger(opts: InitDaemonLoggerOptions): DaemonLogger;
```

`initDaemonLogger` synchronously:

1. Computes `daemonId` + log path.
2. `mkdirSync(parentDir, { recursive: true })` — fail → return no-op logger, write one stderr warning. Boot continues.
3. `appendFileSync(path, '<first line>\n', { flag: 'a' })` — writes `daemon started pid=<pid> workspace=<boundWorkspace> version=<cli version>` synchronously. This doubles as a writability probe; on EACCES/ENOSPC, fail-mode = no-op logger + one stderr warning.
4. Updates `latest` symlink (best-effort, errors swallowed).
5. Returns logger; subsequent `info/warn/error/raw` calls enqueue async `fs.promises.appendFile`.

If `process.env['QWEN_DAEMON_LOG_FILE']` is one of `0|false|off|no`, `initDaemonLogger` short-circuits to a no-op logger before any filesystem call.

## 6. Log Line Format

Mirror `debugLogger.buildLogLine` for visual parity:

```
2026-05-26T03:14:15.926Z [ERROR] [DAEMON] [trace_id=... span_id=...] route=POST /session/:id/prompt sessionId=abc clientId=xyz daemon failed to ...
  at fn (file.ts:42:7)
  at ...
```

- Timestamp: ISO 8601, UTC.
- Level: `INFO` | `WARN` | `ERROR`. (No DEBUG initially — `QWEN_SERVE_DEBUG` flows in as `INFO` via `raw()`.)
- Tag: literal `DAEMON`.
- Trace context: `trace.getActiveSpan()` when available; same logic as `debugLogger.getActiveSpanTraceContext`. Helper extracted to a shared module (`packages/core/src/utils/traceContext.ts`?) or duplicated locally — leave to plan.
- Context fields: rendered as `key=value`, fixed order (`route`, `sessionId`, `clientId`, `childPid`, `channelId`), then any extra keys sorted lexicographically. Values containing whitespace or `=` are `JSON.stringify`-quoted.
- Error stack: appended as indented continuation lines after the message.
- `raw(line, level)` writes the line as-is after the standard prefix `<timestamp> [<LEVEL>] [DAEMON] `, no extra processing.

**Tee semantics (important):**

- `info` / `warn` / `error` write to **both** the daemon log file **and** stderr (via the injected `stderr` writer). Callers replacing a previous `writeStderrLine(...)` use these directly; no separate stderr call needed.
- `raw` writes to **file only**. Used by ACP child stderr forwarder and `writeServeDebugLine`, where the caller is already writing to stderr through its existing path. Doubling would flood operator output.

## 7. Boot / Shutdown Flow

```
runQwenServe(opts):
  ...
  daemonLog = initDaemonLogger({ boundWorkspace })
  writeStderrLine(`qwen serve: daemon log → ${daemonLog.getLogPath()}`)
  // boot banner is stderr-only to avoid the line referencing itself

  bridge = createHttpAcpBridge({
    ...,
    onDiagnosticLine: (line, level) => daemonLog.raw(line, level),
  })

  app = createServeApp({ ..., daemonLog })  // injected for sendBridgeError

  shutdownHandler(signal):
    daemonLog.warn(`shutdown signal=${signal}`)
    await drainBridge()
    await daemonLog.flush()
    process.exit(0)
```

- Boot banner is stderr-only (the path line about itself would be circular if logged).
- `initDaemonLogger` is synchronous so any failure is visible immediately at boot, not buried after the first error.
- Shutdown `flush()` is the last awaited step before `process.exit`. SIGKILL is unflushable by definition — we accept that.

## 8. Coverage Table

| Source                                                        | Today                                        | After                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `runQwenServe.ts` lifecycle / signals / config warnings       | `writeStderrLine(...)`                       | `daemonLog.info \| warn(...)` (stderr still happens — `daemonLog` tees)                          |
| `runQwenServe.ts` "listening on URL" (stdout)                 | `writeStdoutLine(...)`                       | unchanged — operator scripts parse stdout                                                        |
| `server.ts:sendBridgeError`                                   | `writeStderrLine(...)` with route/sessionId  | `daemonLog.error(msg, err, { route, sessionId, ... })` (stderr still emitted by daemonLog's tee) |
| `bridge.ts:writeServeDebugLine` (`QWEN_SERVE_DEBUG`)          | `writeStderrLine('qwen serve debug: ...')`   | tee to `onDiagnosticLine(line, 'info')`                                                          |
| `spawnChannel.ts` child stderr                                | `process.stderr.write(prefix + line + '\n')` | also `onDiagnosticLine(prefix + line, 'warn')`                                                   |
| `writeStdoutLine` callers                                     | unchanged                                    | unchanged                                                                                        |
| CLI usage / argparse errors (`runQwenServe` early validation) | `writeStderrLine(...)`                       | unchanged (logger may not exist yet)                                                             |

Every existing stderr write is preserved. Daemon log is **additive**, never substitutive.

## 9. Write Path & Flush

- Internal queue: a single `Promise<void>` chain (`this.pending = this.pending.then(() => fs.promises.appendFile(...))`).
- Each `info/warn/error/raw` call enqueues an append (file) and, for `info/warn/error`, also synchronously calls the injected `stderr` writer.
- Stderr write order is preserved (synchronous, before queuing the append). File appends are eventually consistent in enqueue order.
- Write failures set an internal `degraded` flag and emit a one-time stderr warning. Subsequent calls still attempt the write but the counter is not maintained.
- `flush()` returns the current tail promise.
- No buffering layer: each call = one `appendFile`. Volume is low (route errors + lifecycle); micro-batching is premature optimization.

## 10. Configuration

| Env var                                         | Behavior                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `QWEN_DAEMON_LOG_FILE=0\|false\|off\|no`        | `initDaemonLogger` returns no-op; tee is a no-op; stderr unchanged           |
| `QWEN_DAEMON_LOG_FILE=<anything else>` or unset | Enabled (default)                                                            |
| `QWEN_RUNTIME_DIR=<path>`                       | Relocates `~/.qwen` root, daemon log moves with it (existing semantics)      |
| `QWEN_SERVE_DEBUG=1`                            | Existing — `writeServeDebugLine` activates; lines now also tee to daemon log |

`QWEN_DAEMON_LOG_FILE` is intentionally separate from `QWEN_DEBUG_LOG_FILE` so disabling per-session debug logs doesn't take down the operator's daemon log (and vice versa).

## 11. Error Handling

- `initDaemonLogger` mkdir/open failure → no-op logger + one stderr warning. Daemon boot proceeds. Operator sees nothing in the file but still gets stderr.
- Per-append failures → flip degraded flag, emit one stderr warning, keep trying. Issue says nothing about a degraded-mode UI signal, so no public surface needed.
- `flush()` rejection → caught in shutdown handler, logged via `writeStderrLine`. Does not block exit.
- `latest` symlink failure → swallowed; primary writes unaffected.

## 12. Testing

### `daemonLogger.test.ts` (new)

- Sandboxed `baseDir`, mocked `now`, `pid`, `stderr`.
- Path & daemon-id derivation including the 8-char `workspaceHash` for known input.
- `latest` symlink created and updated on subsequent `initDaemonLogger` invocations in the same dir.
- Level formatting (INFO/WARN/ERROR), context field order, error stack continuation.
- Trace context injection when an active span exists.
- `raw(line, level)` writes the prefixed line verbatim.
- `flush()` resolves only after all enqueued writes hit the file.
- `QWEN_DAEMON_LOG_FILE=0` → no file created.
- `mkdir` failure → no-op logger, one stderr warning, subsequent calls don't throw.
- `appendFile` failure → degraded flag flipped, one stderr warning.

### `runQwenServe.test.ts` (extend)

- Boot writes `daemon started ...` line to the log.
- Shutdown handler awaits `daemonLog.flush()` before exit.
- Stderr boot banner contains the daemon log path.

### `server.test.ts` (extend)

- A route that throws routes the error through `daemonLog.error(...)` with the right `route` and `sessionId`.

### acp-bridge tests (extend)

- `onDiagnosticLine` callback invoked from `writeServeDebugLine` when `QWEN_SERVE_DEBUG=1` and from `spawnChannel` child stderr forwarder. Tests inject a capturing fake; no filesystem.

## 13. Documentation

- `docs/cli/serve.md` (or wherever serve is documented) gains a "Daemon log file" section covering: path, daemon-id format, `latest` symlink, `QWEN_DAEMON_LOG_FILE` opt-out, distinction from per-session `debug/<sessionId>.txt`.
- README under `packages/cli/src/serve/` if one exists.
- No CHANGELOG-style file in this repo; release notes are handled separately.

## 14. Rollback

- Pure-additive change. Rollback = revert the commit:
  - Delete `daemonLogger.ts` + its test.
  - Revert `runQwenServe.ts` lifecycle / sendBridgeError / bridge / spawnChannel changes.
  - Remove `onDiagnosticLine` from `BridgeOptions`.
- No on-disk state to clean up; existing daemon log files become orphaned but harmless.

## 15. Acceptance Criteria (from issue)

| Criterion                                                           | How met                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `qwen serve` creates / appends daemon log without shell redirection | `initDaemonLogger` opens the file at boot                                                         |
| HTTP 500 from `POST /session/:id/prompt` correlatable in daemon log | `sendBridgeError` writes `route=` + `sessionId=`                                                  |
| ACP child stderr lines also in daemon log                           | `spawnChannel` tees through `onDiagnosticLine`                                                    |
| Logging works before first session and after all sessions closed    | Not session-scoped; lives for daemon lifetime                                                     |
| Existing stderr behavior intact                                     | All writes are additive; no `writeStderrLine` call is removed without an equivalent left in place |
| Log path + opt-out documented                                       | Docs section in §13                                                                               |

## 16. Open Questions

None blocking. Possible follow-ups:

- Should `latest` symlink go in `~/.qwen/debug/daemon/latest` or `~/.qwen/debug/daemon-latest`? Spec picks the former for directory tidiness.
- Should we offer JSON-line output as a future flag (e.g., `QWEN_DAEMON_LOG_FORMAT=json`)? Out of scope for this PR; structured export is what #2014 owns.
