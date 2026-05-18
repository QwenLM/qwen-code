/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { type Server } from 'node:http';
import * as path from 'node:path';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import type { BridgeEvent } from './eventBus.js';
import { getDeviceFlowRegistry } from './auth/deviceFlow.js';
import { loadSettings, SettingScope } from '../config/settings.js';
import {
  canonicalizeWorkspace,
  createHttpAcpBridge,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import { createDaemonStatusProvider } from './daemonStatusProvider.js';
import { isLoopbackBind } from './loopbackBinds.js';
import { createDefaultFsAuditEmit, createServeApp } from './server.js';
import type { ServeOptions } from './types.js';
import {
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from './fs/index.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

/**
 * Wrap raw IPv6 literals in brackets so the printed URL is a valid RFC 3986
 * authority. `host:port` is ambiguous when host contains `:`, so the URL
 * form requires `[host]:port` for IPv6. Pass-through for IPv4 and DNS
 * names. Already-bracketed input is left alone.
 *
 * RFC 6874 also requires the `%` in an IPv6 zone identifier (e.g.
 * `fe80::1%lo0`) to be percent-encoded as `%25` so the printed URL is
 * copy-paste-valid. We do that on raw IPv6 only — already-bracketed
 * input is the operator's responsibility (don't double-encode if they
 * pre-formed the URL part themselves).
 */
function formatHostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  if (host.includes(':')) {
    const encoded = host.includes('%') ? host.replace(/%/g, '%25') : host;
    return `[${encoded}]`;
  }
  return host;
}

/**
 * #4282 fold-in 4 (qwen-latest C2). Per-workspace promise chain that
 * serializes settings read-modify-write cycles inside this process.
 *
 * Both `persistApprovalMode` and `persistDisabledTools` re-read
 * `tools.disabled` (or `tools.approvalMode`) from disk before writing
 * the merged result back, which is a textbook lost-update window if
 * two concurrent HTTP requests land at the same workspace. Threading
 * each call through this lock collapses the window: the first request
 * holds the chain until its `setValue` flush completes, and the second
 * sees the post-write state when it runs its own load.
 *
 * Scope is INTRA-process: a separate `qwen serve` invocation against
 * the same workspace would not share the Map, but per-workspace
 * single-daemon is the supported deployment shape (see #3803 §02).
 * The lock decays naturally — when no callers are queued, the chain
 * resolves and stays mounted in the Map; the per-workspace memory
 * cost is one settled Promise and one Map entry.
 *
 * Errors propagate to the caller; the chain advances to the next
 * waiter regardless via the `.then(fn, fn)` pattern, so a single
 * failed write doesn't permanently stall persistence.
 */
const settingsWriteLocks = new Map<string, Promise<unknown>>();
function withSettingsLock<T>(
  workspace: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = settingsWriteLocks.get(workspace) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  settingsWriteLocks.set(workspace, next);
  return next;
}

export interface RunHandle {
  server: Server;
  url: string;
  bridge: HttpAcpBridge;
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

export interface RunQwenServeDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
  /**
   * Workspace filesystem factory (#4175 PR 19). When omitted,
   * `runQwenServe` constructs one using `boundWorkspace`,
   * `trustedWorkspace`, and a default warning-emit hook. Tests
   * inject a real factory + custom emit to capture audit events,
   * or override `trustedWorkspace` to flip the trust snapshot
   * without re-routing through the OS-level trustedFolders config
   * file.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Trust snapshot for the bound workspace at boot. Drives the
   * `WorkspaceFileSystem`'s `assertTrustedForIntent` gate — read
   * intents always pass; mutating intents (`write`, `edit`) throw
   * `untrusted_workspace` when this is false. Defaults to true:
   * the daemon binds at boot to a workspace the operator
   * explicitly chose, and the trust dialog flow that ungates write
   * permissions in the interactive CLI is not yet replicated for
   * the daemon. Tests pin this to false to assert the gate is
   * actually wired through `runQwenServe → createServeApp →
   * fsFactory`.
   */
  trustedWorkspace?: boolean;
  /**
   * Audit-emit hook for `fs.access` / `fs.denied`. Defaults to a
   * stderr warning every 100 events so a regression that drops
   * audit emission stays visible in the operator log. PR 21's SSE
   * fan-out will replace the default with a workspace-scoped event
   * channel; for now tests inject a recording array to assert the
   * audit pipeline.
   */
  fsAuditEmit?: (event: BridgeEvent) => void;
}

/**
 * Validate options + start the listener. Resolves once the server is ready
 * to accept connections.
 *
 * Token resolution order:
 *   1. explicit `opts.token`
 *   2. `QWEN_SERVER_TOKEN` env var
 *
 * Boot refuses to start when bound beyond loopback without a token; this is a
 * hard rule, not a warning, per the threat model in the design issue.
 */
export async function runQwenServe(
  optsIn: Omit<ServeOptions, 'token'> & { token?: string },
  deps: RunQwenServeDeps = {},
): Promise<RunHandle> {
  // Trim both sources. Common gotcha: `export QWEN_SERVER_TOKEN=$(cat
  // token.txt)` keeps the file's trailing `\n` in the env value, so the
  // hashed-then-compared token never matches what well-behaved clients
  // send. Every request returns the generic 401 with no breadcrumb
  // pointing at the whitespace, and operators chase ghosts. Trim once
  // at boot so the comparison is over what humans intended to set.
  const rawToken = optsIn.token ?? process.env[QWEN_SERVER_TOKEN_ENV];
  const token =
    typeof rawToken === 'string' && rawToken.trim().length > 0
      ? rawToken.trim()
      : undefined;
  const opts: ServeOptions = { ...optsIn, token };

  // BU-sh: catch the `--hostname localhost:4170` / `127.0.0.1:4170`
  // typo BEFORE the loopback / token check so the operator sees a
  // useful "did you mean --port?" message instead of "Refusing to
  // bind localhost:4170:0 without a bearer token". Unbracketed input
  // with exactly one `:` is the unambiguous host:port shape — raw
  // IPv6 literals always have two-or-more `:` (the shortest is `::`),
  // and bracketed IPv6 is handled by its own form check below.
  if (!opts.hostname.startsWith('[') && opts.hostname.split(':').length === 2) {
    const [host, port] = opts.hostname.split(':');
    throw new Error(
      `Invalid --hostname "${opts.hostname}": looks like a "host:port" ` +
        `combination. Use --port for the port, e.g. ` +
        `"--hostname ${host} --port ${port}".`,
    );
  }

  if (!isLoopbackBind(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token. ` +
        `Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to loopback ` +
        `(127.0.0.1, localhost, ::1, or [::1]).`,
    );
  }
  // Issue #4175 PR 15. `--require-auth` extends the "must have a token"
  // rule to loopback as well. Boot-loud, like the non-loopback check
  // above: silently dropping the flag when no token is configured
  // would leave the operator believing the deployment is hardened
  // when it isn't. Mention both the env var and the flag so log
  // readers don't have to read the source to learn the fix.
  if (opts.requireAuth && !token) {
    throw new Error(
      `Refusing to start with --require-auth set but no bearer token ` +
        `configured. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or omit ` +
        `--require-auth to keep the loopback developer default.`,
    );
  }

  // Resolve the bound workspace per #3803 §02 (1 daemon = 1 workspace).
  // Explicit `--workspace` wins; otherwise default to process.cwd().
  // `POST /session` with a mismatched `cwd` is rejected by the bridge
  // with `WorkspaceMismatchError`. Multi-workspace deployments use
  // multiple daemon processes, not intra-daemon routing.
  //
  // Boot-loud validation: absolute path, exists, is a directory.
  // Without the stat() check, `canonicalizeWorkspace`'s ENOENT fallback
  // to `path.resolve` would let the daemon boot pointed at a
  // non-existent directory; every `POST /session` would then spawn a
  // `qwen --acp` child with that cwd and the agent would fail with an
  // opaque ENOENT — operator pain we can avoid by failing at boot.
  const rawWorkspace = opts.workspace ?? process.cwd();
  if (!path.isAbsolute(rawWorkspace)) {
    throw new Error(
      `Invalid --workspace "${rawWorkspace}": must be an absolute path.`,
    );
  }
  try {
    const stats = fs.statSync(rawWorkspace);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid --workspace "${rawWorkspace}": exists but is not a directory.`,
      );
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') {
        throw new Error(
          `Invalid --workspace "${rawWorkspace}": directory does not exist.`,
        );
      }
      // EACCES / EPERM: the path exists but the current user can't
      // stat it (typical for SIP-protected paths on macOS, root-owned
      // dirs the daemon's user can't traverse, etc.). The raw Node
      // SystemError has the path AND the syscall but no operator-
      // facing breadcrumb that this came from `--workspace`. Wrap
      // both codes so the boot failure points at the flag the
      // operator actually set.
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Invalid --workspace "${rawWorkspace}": permission denied ` +
            `(${String(code)}). The path exists but cannot be stat'd ` +
            `by the current user.`,
        );
      }
    }
    throw err;
  }
  // Canonicalize ONCE here so `/capabilities` and the POST /session
  // fallback (both via server.ts) AND the bridge agree on the same
  // path. Without this, server.ts and the bridge each compute
  // `boundWorkspace` independently; on symlinks or case-insensitive
  // filesystems the bridge's `realpathSync.native` form diverges from
  // server.ts's raw `opts.workspace` and clients see one path on
  // `/capabilities` but another on `POST /session` responses.
  const boundWorkspace = canonicalizeWorkspace(rawWorkspace);
  // Issue #4175 PR 14. The MCP client guardrails enforce in the ACP
  // child process (where `McpClientManager` lives), not the daemon.
  // Forward the budget config via env vars so the child's
  // `readBudgetFromEnv()` picks them up.
  //
  // PR 14 fix (review #4247 wenshao R5 line 216): use per-handle env
  // overrides via `BridgeOptions.childEnvOverrides` instead of
  // mutating global `process.env`. Pre-fix concurrent embedded
  // daemons (`runQwenServe()` × 2 in the same process) would race
  // on `process.env` — `defaultSpawnChannelFactory` snapshots
  // `process.env` AT SPAWN TIME, so the later daemon's env value
  // would silently win for the earlier daemon's subsequent ACP
  // child spawns. With per-handle overrides closed over inside
  // each bridge, each daemon's children inherit ONLY that
  // daemon's intended budget config, regardless of what other
  // daemons in the same process are doing.
  //
  // Also: `runQwenServe` is exported and other validations
  // (`requireAuth` no-token, `maxConnections` NaN, `--workspace`
  // checks) live here, so embedded callers expect boot-time
  // rejection of invalid inputs. The yargs CLI handler duplicates
  // these for fast-fail UX, but `runQwenServe` is the source of
  // truth.
  if (opts.mcpClientBudget !== undefined) {
    if (
      !Number.isFinite(opts.mcpClientBudget) ||
      !Number.isInteger(opts.mcpClientBudget) ||
      opts.mcpClientBudget <= 0
    ) {
      throw new TypeError(
        `Invalid mcpClientBudget: ${opts.mcpClientBudget}. Must be a positive integer.`,
      );
    }
  }
  if (opts.mcpBudgetMode === 'enforce' && opts.mcpClientBudget === undefined) {
    throw new Error(
      'mcpBudgetMode="enforce" requires a positive mcpClientBudget. ' +
        'Pass mcpClientBudget=N, or set mcpBudgetMode to "warn" or "off".',
    );
  }
  // Per-handle env overrides: `undefined` value means "scrub this
  // var from the child env" — important when a different daemon
  // in the same process set the var globally previously. Always
  // set both keys explicitly (to value or `undefined`) so each
  // child's MCP budget env is fully determined by this handle's
  // options, with no inheritance from process.env's current state.
  const childEnvOverrides: Record<string, string | undefined> = {
    QWEN_SERVE_MCP_CLIENT_BUDGET:
      opts.mcpClientBudget !== undefined
        ? String(opts.mcpClientBudget)
        : undefined,
    QWEN_SERVE_MCP_BUDGET_MODE: opts.mcpBudgetMode,
  };

  const bridge =
    deps.bridge ??
    createHttpAcpBridge({
      maxSessions: opts.maxSessions,
      ...(opts.eventRingSize !== undefined
        ? { eventRingSize: opts.eventRingSize }
        : {}),
      boundWorkspace,
      childEnvOverrides,
      // #4175 PR 22b/2: inject the daemon-host status provider so the
      // bridge can pull env / preflight cells through a typed seam
      // instead of importing daemon-host helpers directly. Production
      // implementation wraps `buildEnvStatusFromProcess` and the
      // (lifted) `buildDaemonPreflightCells` body.
      statusProvider: createDaemonStatusProvider(),
      // #4175 Wave 4 PR 17: `POST /session/:id/approval-mode` accepts
      // an opt-in `persist: true` flag. We re-load settings on each
      // persist call rather than caching a `LoadedSettings` handle —
      // another writer (CLI, another daemon, an editor) could have
      // touched the file between calls, so the freshest state wins
      // over a stale in-memory cache.
      //
      // #4282 fold-in 4 (qwen-latest C2): both persist callbacks run
      // through `withSettingsLock` — a per-workspace promise chain that
      // serializes the read-modify-write cycle. Without the lock, two
      // concurrent `POST /workspace/tools/:name/enable` requests could
      // both read the same pre-modification state and the second write
      // would silently overwrite the first toggle, leaving the disk
      // copy out of sync with the SDK reducer's view. The lock costs
      // one tick of latency per call but eliminates the lost-update
      // window for the entire process; cross-daemon races against the
      // same workspace file remain (rare; documented).
      persistApprovalMode: (workspace, mode) =>
        withSettingsLock(workspace, async () => {
          const fresh = loadSettings(workspace);
          fresh.setValue(SettingScope.Workspace, 'tools.approvalMode', mode);
        }),
      // #4175 Wave 4 PR 17: `POST /workspace/tools/:name/enable` writes
      // through this callback. Re-reads settings on each call (same
      // freshness rationale as `persistApprovalMode`) and merges into
      // the existing `tools.disabled` array — concurrent toggles from
      // other writers stay safe across the read/modify/write window.
      //
      // #4282 wenshao H2 fold-in: read from the WORKSPACE scope only.
      // Reading `fresh.merged.tools?.disabled` (the UNION across
      // System / SystemDefaults / User / Workspace) and writing the
      // result back into `SettingScope.Workspace` would copy entries
      // from higher scopes into the workspace file on the first
      // toggle. Subsequent removals at the originating scope (e.g.
      // User) would no longer take effect because the names have been
      // baked into the workspace file with no obvious source.
      persistDisabledTools: (workspace, toolName, enabled) =>
        withSettingsLock(workspace, async () => {
          const fresh = loadSettings(workspace);
          const wsScope = fresh.forScope(SettingScope.Workspace).settings;
          const wsDisabled = wsScope.tools?.disabled;
          const current = Array.isArray(wsDisabled)
            ? wsDisabled.filter((v): v is string => typeof v === 'string')
            : [];
          const next = new Set(current);
          if (enabled) next.delete(toolName);
          else next.add(toolName);
          fresh.setValue(
            SettingScope.Workspace,
            'tools.disabled',
            [...next].sort(),
          );
        }),
    });
  let actualPort = opts.port;
  // Pass the already-canonical `boundWorkspace` into `createServeApp`
  // via `deps.boundWorkspace`. That field is the pre-canonicalized
  // fast-path: createServeApp skips its own `canonicalizeWorkspace`
  // call (which would issue a redundant `realpathSync.native`
  // syscall — idempotent but unnecessary I/O at boot). Direct
  // callers of createServeApp (tests / embeds) omit it and the
  // server canonicalizes itself.
  //
  // PR 19 — wire up `fsFactory` so the new read routes
  // (`GET /file|/list|/glob|/stat`) consume a per-request boundary
  // built against THIS daemon's bound workspace. Trust snapshot
  // defaults to true; tests / future hardening flows pass an
  // explicit `trustedWorkspace` to flip the gate. The audit-emit
  // hook plugs into PR 21's SSE fan-out once that lands; until then
  // the warning-emit fallback in `createServeApp` makes any silent
  // drop visible in operator logs.
  const trustedWorkspace = deps.trustedWorkspace ?? true;
  // Reuse `createDefaultFsAuditEmit` so the throttle behavior here
  // matches what `createServeApp`'s built-in fallback would emit.
  // The earlier per-event `writeStderrLine` would print one line for
  // every `/file` / `/list` / `/glob` / `/stat` audit event under
  // normal traffic — a workspace scan can flood operator logs in
  // seconds. The shared helper warns once + every 100th drop and
  // includes payload context (errorKind / intent / pathHash), so a
  // genuine wiring regression still surfaces but routine audit
  // traffic stays quiet. Future PR 21 SSE fan-out replaces this
  // default with the workspace-scoped event channel; until then the
  // throttled stderr warning is the canonical "emit channel orphaned"
  // breadcrumb.
  const fsFactory =
    deps.fsFactory ??
    createWorkspaceFileSystemFactory({
      boundWorkspace,
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit ?? createDefaultFsAuditEmit(),
    });
  const app = createServeApp(opts, () => actualPort, {
    bridge,
    boundWorkspace,
    fsFactory,
  });
  // Issue #4175 PR 21 — `createServeApp` parks the device-flow registry
  // on `app.locals` when it constructs (or accepts) one. Pull it back
  // out so the close hook can dispose it before `bridge.shutdown()`,
  // ensuring polling timers + cancel controllers are torn down BEFORE
  // we tell agent children to exit (otherwise a stuck IdP fetch could
  // pin the drain). `unref()`'d timers mean the process WILL exit
  // either way; explicit dispose is for cleanliness + audit
  // visibility. Typed accessor (fold-in 4 review thread D) prevents
  // a key-name typo from silently nulling out the dispose path.
  const deviceFlowRegistry = getDeviceFlowRegistry(app);

  // Node's `app.listen()` wants the unbracketed IPv6 literal (`::1`) but
  // operators conventionally type `[::1]` (or copy/paste from URLs that
  // need the brackets to disambiguate the port). Strip brackets at
  // bind-time, keep them for the printed URL — without this fixup
  // `qwen serve --hostname [::1]` would pass the loopback/token check
  // and then fail to start with ENOTFOUND.
  //
  // Only accept *pure* bracketed forms: `[…]` with no trailing `:port`
  // suffix. `[2001:db8::1]:8080` is operator-error (port goes through
  // `--port`, not the hostname) — fail loudly with a useful error
  // instead of silently stripping to a malformed `2001:db8::1]:8080`.
  let listenHostname = opts.hostname;
  if (opts.hostname.startsWith('[')) {
    const inner = opts.hostname.slice(1, -1);
    if (
      !opts.hostname.endsWith(']') ||
      inner.length === 0 ||
      inner.includes(']')
    ) {
      throw new Error(
        `Invalid --hostname "${opts.hostname}": brackets indicate an ` +
          `IPv6 literal but the value isn't a clean [addr] form. Pass the ` +
          `address without a trailing :port (use --port for that), e.g. ` +
          `"--hostname [::1] --port 4170".`,
      );
    }
    // Empty brackets `[]` would have stripped to `''`, which Node treats
    // as "bind to all interfaces" — the operator's intent was specific,
    // not wildcard. The check above (`inner.length === 0`) rejects.
    listenHostname = inner;
  }

  // BUF9-: validate maxConnections BEFORE binding so a typo fails the
  // promise instead of escaping as an uncaught exception inside the
  // listen callback (which fires from the `listening` event after the
  // outer promise has already resolved). Silent fail-OPEN on NaN /
  // negative would weaken the DoS/FD-exhaustion guard the cap exists
  // for.
  if (opts.maxConnections !== undefined) {
    if (Number.isNaN(opts.maxConnections)) {
      throw new TypeError(
        'Invalid maxConnections: NaN. Must be >= 0 ' +
          '(0 / Infinity = unlimited).',
      );
    }
    if (opts.maxConnections < 0) {
      throw new TypeError(
        `Invalid maxConnections: ${opts.maxConnections}. Must be >= 0 ` +
          `(0 / Infinity = unlimited).`,
      );
    }
  }

  return await new Promise<RunHandle>((resolve, reject) => {
    const server = app.listen(opts.port, listenHostname, () => {
      // Listener-level connection cap, set inside the listen callback
      // because Node only exposes the underlying `Server` after
      // `app.listen()` returns. Each session's `EventBus` already
      // refuses to admit more than `DEFAULT_MAX_SUBSCRIBERS` (64), but
      // an attacker can still open *connections* that never finish
      // their headers, never reach the bus, and just sit consuming
      // socket descriptors. The default of 256 leaves room for many
      // sessions × many legitimate clients while keeping the FD count
      // bounded; operators with high-concurrency deployments raise it
      // via `--max-connections` (BRQQb).
      //
      // tanzhenxin issue 1: `0` and `Infinity` are operator-visible
      // "disable the cap" sentinels — but on Node 22 setting
      // `server.maxConnections = 0` causes the listener to refuse
      // EVERY connection (verified on v22.15.0: every fetch fails
      // with `SocketError: other side closed`). Treat 0 / Infinity
      // as "leave the property unset" so the documented disable
      // path actually disables instead of silently bricking the
      // daemon. NaN / negative are rejected upstream (BUF9-) so
      // they never reach here.
      const cap = opts.maxConnections ?? 256;
      if (cap > 0 && Number.isFinite(cap)) {
        server.maxConnections = cap;
      }
      // else: leave unset (Node's default = unlimited at this layer).
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      const url = `http://${formatHostForUrl(opts.hostname)}:${actualPort}`;
      writeStdoutLine(
        `qwen serve listening on ${url} (mode=${opts.mode}, ` +
          `workspace=${boundWorkspace})`,
      );
      // Operator log on stderr too (systemd/docker/k8s default
      // captures only stderr for service diagnostics, and the
      // workspace= breadcrumb is the single piece of information
      // operators need most when triaging §02 migration issues —
      // "did the daemon bind to the right workspace?"). The stdout
      // line above stays put so integration tests + scripts that
      // parse stdout for the listening URL keep working;
      // `JSON.stringify(boundWorkspace)` quotes the value
      // symmetrically with the workspace_mismatch log (defends
      // against control-char log injection if `boundWorkspace`
      // somehow contained one — operator-controlled today, but
      // cheap defense-in-depth).
      writeStderrLine(
        `qwen serve: bound to workspace ${JSON.stringify(boundWorkspace)}`,
      );
      if (!token) {
        writeStderrLine(
          `qwen serve: bearer auth disabled (loopback default). Set ${QWEN_SERVER_TOKEN_ENV} to enable.`,
        );
      } else if (opts.requireAuth) {
        // The boot check above guarantees `token` is set whenever
        // `--require-auth` is on, so this branch only fires alongside
        // a successfully-authenticated daemon. The log line lets
        // operators confirm the hardening is active without parsing
        // `/capabilities` (and is a useful breadcrumb when triaging
        // "why is loopback returning 401" tickets).
        writeStderrLine(
          'qwen serve: --require-auth enabled (bearer token mandatory ' +
            'on every route, including loopback /health).',
        );
      }

      let shuttingDown = false;
      let closePromise: Promise<void> | undefined;

      // Forward declaration so handle.close can detach the listener after
      // drain completes. The handler is registered just before `resolve()`.
      const onSignal = async (signal: NodeJS.Signals) => {
        if (shuttingDown) {
          // BSA0K: second signal forces exit. During drain (up to
          // ~15s for a stuck child + the 5s force-close timer) an
          // operator's reflexive `^C^C` would otherwise be dropped.
          // Match standard daemon behavior (nginx, redis, etc.):
          // first signal = graceful drain; second = hard exit.
          //
          // Bd1y6: synchronously SIGKILL every live `qwen --acp`
          // child BEFORE `process.exit(1)`. Otherwise the daemon
          // vanishes but its child processes keep running with
          // dangling stdin/stdout pipes — visible as orphan
          // `qwen` processes in the operator's `ps` output.
          writeStderrLine(
            `qwen serve: received ${signal} during drain — forcing exit`,
          );
          try {
            bridge.killAllSync();
          } catch (err) {
            writeStderrLine(
              `qwen serve: force-kill error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          process.exit(1);
          return;
        }
        writeStderrLine(`qwen serve: received ${signal}, draining...`);
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          writeStderrLine(`qwen serve: shutdown error: ${String(err)}`);
          process.exit(1);
        }
      };

      const handle: RunHandle = {
        server,
        url,
        bridge,
        close: () => {
          // Idempotent: cache the in-flight (or settled) close promise so
          // overlapping calls (e.g. test harness + signal handler firing
          // simultaneously) all observe the same drain cycle. Without this
          // each caller would arm its own force-close timer + invoke
          // bridge.shutdown / server.close redundantly.
          if (closePromise) return closePromise;
          closePromise = new Promise<void>((res, rej) => {
            shuttingDown = true;
            // NOTE: the SIGINT/SIGTERM handlers stay attached during the
            // drain. Their `if (shuttingDown) return` guard makes a second
            // signal a no-op. Detaching them up front would leave Node's
            // default signal behavior in charge — a second SIGTERM mid-drain
            // would terminate the process and orphan agent children. We
            // detach AFTER drain completes (`finish` below).

            // Two-phase shutdown:
            //   1. `bridge.shutdown()` — tears down agent children with
            //      its own internal `KILL_HARD_DEADLINE_MS` (10s) so
            //      a wedged child can't block forever. We wait
            //      unconditionally; the bridge bounds itself.
            //   2. `server.close()` — drains in-flight HTTP connections
            //      (long-lived SSE subscribers especially). This is
            //      what `SHUTDOWN_FORCE_CLOSE_MS` actually protects:
            //      a single hung SSE consumer would otherwise pin
            //      the listener open forever.
            //
            // Crucially, the force timer is armed AFTER bridge.shutdown
            // resolves, not at the start of the whole sequence. An
            // earlier version raced both phases against the same 5s
            // timer; if the bridge took 5–10s to kill its children
            // (e.g. SIGTERM grace period), the timer fired first,
            // resolved this promise, and `process.exit(0)` ran while
            // the bridge was still tearing children down — orphaning
            // any that hadn't yet hit `KILL_HARD_DEADLINE_MS`.
            let settled = false;
            // BV-qW: track bridge.shutdown failures so close()
            // doesn't silently report success when the bridge
            // teardown itself failed. The contract says "resolves
            // when the listener has fully closed and the bridge is
            // drained" — propagating the failure lets `onSignal`
            // exit 1 instead of 0, and lets embedders react.
            let bridgeShutdownError: Error | undefined;
            const finish = (err?: Error | null) => {
              if (settled) return;
              settled = true;
              // Drain finished (or timed out) — safe to detach now.
              process.removeListener('SIGINT', onSignal);
              process.removeListener('SIGTERM', onSignal);
              // Server.close error takes precedence (operator-visible
              // listener problem); fall back to the bridge error
              // captured during shutdown if any.
              const finalErr = err ?? bridgeShutdownError;
              if (finalErr) rej(finalErr);
              else res();
            };

            // PR 21: dispose the device-flow registry FIRST so any
            // in-flight IdP poll is cancelled and timers are cleared
            // before the bridge tear-down (which would otherwise race
            // with the still-polling registry on shared HTTP agents).
            if (deviceFlowRegistry) {
              try {
                deviceFlowRegistry.dispose();
              } catch (err) {
                writeStderrLine(
                  `qwen serve: device-flow registry dispose error: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            bridge
              .shutdown()
              .catch((err) => {
                writeStderrLine(
                  `qwen serve: bridge shutdown error: ${String(err)}`,
                );
                bridgeShutdownError =
                  err instanceof Error ? err : new Error(String(err));
              })
              .finally(() => {
                // Phase 2: arm the force timer NOW so it only races
                // server.close, not the bridge tear-down above.
                // BUb7h: `RunHandle.close()` contract says "fully
                // closed and bridge drained" — the previous code
                // resolved on a 100ms shortcut AFTER
                // `closeAllConnections()` without waiting for
                // `server.close`'s callback, so embedders/tests
                // could observe a "closed" handle while the server
                // was still finalizing. Now: force-close just
                // accelerates `server.close` by killing the
                // sockets, but we still wait for `server.close`'s
                // callback to fire. A secondary deadline catches
                // the pathological case where `server.close` never
                // resolves at all (kernel-stuck socket etc.) so
                // shutdown is still bounded.
                const SECONDARY_DEADLINE_MS = 2_000;
                let secondaryTimer: NodeJS.Timeout | undefined;
                const forceTimer = setTimeout(() => {
                  writeStderrLine(
                    `qwen serve: ${SHUTDOWN_FORCE_CLOSE_MS}ms listener-drain timeout reached; force-closing remaining connections`,
                  );
                  server.closeAllConnections();
                  // After force-close, server.close's callback
                  // SHOULD fire promptly. Give it `SECONDARY_DEADLINE_MS`
                  // before we resolve anyway with a warning — much
                  // longer than the previous 100ms shortcut, and
                  // logged so the operator knows the contract was
                  // bent.
                  secondaryTimer = setTimeout(() => {
                    writeStderrLine(
                      `qwen serve: server.close did not fire ${SECONDARY_DEADLINE_MS}ms after force-close; resolving anyway`,
                    );
                    finish();
                  }, SECONDARY_DEADLINE_MS);
                  secondaryTimer.unref();
                }, SHUTDOWN_FORCE_CLOSE_MS);
                forceTimer.unref();
                server.close((err) => {
                  clearTimeout(forceTimer);
                  if (secondaryTimer) clearTimeout(secondaryTimer);
                  finish(err);
                });
              });
          });
          return closePromise;
        },
      };

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      // BX9_i: swap the boot-error listener for a runtime-error one
      // before resolving. `server.once('error', reject)` at the
      // bottom only catches errors BEFORE listening; post-listen
      // errors (EMFILE after FD exhaustion, runtime errors on the
      // listener) would be unhandled and crash the daemon. Use a
      // persistent listener that logs to stderr instead.
      server.removeAllListeners('error');
      server.on('error', (err) => {
        writeStderrLine(
          `qwen serve: server error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      resolve(handle);
    });
    server.once('error', reject);
  });
}
