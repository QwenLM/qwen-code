/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `BridgeOptions` and the daemon-host injection seam (`DaemonStatusProvider`)
 * for the ACP bridge factory. Lifted to `@qwen-code/acp-bridge` so the
 * bridge package owns the construction contract independently of
 * `cli/src/serve/`.
 */

import type {
  ApprovalMode,
  DaemonBridgeTelemetryMetrics,
} from '@qwen-code/qwen-code-core';
import { MAX_SUB_SESSION_PROMPT_CHARS } from '@qwen-code/qwen-code-core/subSessionConstants';
import type { ChannelFactory } from './channel.js';
import type { BridgeEvent } from './eventBus.js';
import type { PermissionPolicy } from './permission.js';
import type { PermissionAuditPublisher } from './permissionMediator.js';
import type { ServePreflightCell, ServeWorkspaceEnvStatus } from './status.js';
import type { BridgeFileSystem } from './bridgeFileSystem.js';
import type { JournalGrowthSessionLimit } from './replayWindowLimits.js';
import type { PromptLedgerRecord } from './prompt-ledger.js';

/**
 * Sink for serve-level diagnostic lines (set by the cli daemon logger).
 * When provided, the bridge tees `writeServeDebugLine` output through
 * this callback alongside the existing stderr write — used by
 * runQwenServe to capture them in the daemon log file. The bridge
 * does not own a file logger itself; this is a pure pass-through hook.
 */
export type DiagnosticLineSink = (
  line: string,
  level?: 'info' | 'warn' | 'error',
) => void;

/**
 * Append-only sink for the per-session prompt terminal ledger. The bridge
 * owns only the writes (best-effort, synchronous so the daemon-shutdown
 * flush lands before process exit); path resolution, reads, and cold-load
 * reconciliation live in the serve layer, which knows the session storage
 * layout. Keeping this a bare callable seam means the bridge needs no
 * filesystem layout knowledge and no core dependency for ledger paths.
 */
export interface PromptLedgerSink {
  appendSync(sessionId: string, record: PromptLedgerRecord): void;
  /**
   * Uuid of the transcript's last record right now, or `undefined` when
   * there is no transcript evidence (fresh session, unreadable file). The
   * bridge stamps it into the `in_flight` record at admission as the
   * dispatch marker; best-effort — a failure or absence only degrades
   * cold-load reconciliation back to its marker-less evidence chain.
   */
  transcriptTailUuid?(sessionId: string): string | undefined;
}

export interface BridgeFreshSessionAdmissionContext {
  readonly operation: 'spawn' | 'load' | 'resume' | 'branch';
  readonly workspaceCwd: string;
  readonly sessionId?: string;
  readonly sourceSessionId?: string;
}

export interface BridgeFreshSessionReservation {
  release(): void;
}

export type BridgeFreshSessionAdmission = (
  context: BridgeFreshSessionAdmissionContext,
) => BridgeFreshSessionReservation | undefined;

export type BridgeSessionLifecycleEvent =
  | {
      readonly type: 'registered';
      readonly sessionId: string;
      readonly workspaceCwd: string;
      readonly reason: string;
    }
  | {
      readonly type: 'removed';
      readonly sessionId: string;
      readonly workspaceCwd: string;
      readonly reason: string;
    };

export type BridgeSessionLifecycle = (
  event: BridgeSessionLifecycleEvent,
) => void;

/**
 * Trusted child-to-daemon request made immediately before a tool executor.
 * `sessionId` and `promptId` are revalidated by BridgeClient against its
 * runtime-owned active entry before this reaches the host handler.
 */
export interface ExternalToolGuardPrepareRequest {
  readonly sessionId: string;
  /**
   * Runtime-owned active-prompt binding. Absent for context-less shell
   * checks: subagent reasoning loops, cron turns, background notifications,
   * and resumed background agents run without an invocation context by
   * design. A host policy that requires a live prompt must fail closed when
   * the binding is missing.
   */
  readonly promptId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Daemon-owned current session working directory. */
  readonly effectiveCwd?: string;
  /**
   * Directory the child will actually run the tool in, when it differs from
   * the session's own. Untrusted: the host validates it against state it
   * owns before using it as a containment basis.
   */
  readonly invocationCwd?: string;
}

export type ExternalToolGuardPrepareResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason?: string };

export type ExternalToolGuardHandler = (
  request: ExternalToolGuardPrepareRequest,
) => Promise<ExternalToolGuardPrepareResult>;

/**
 * Optional injection seam for daemon-host-specific status cells —
 * `process.env` snapshots and the daemon-side preflight checks
 * (Node version, CLI entry path, ripgrep, git, npm, workspace dir).
 *
 * The bridge is intentionally agnostic about how its host computes
 * these cells; production `qwen serve` provides
 * `cli/src/serve/daemon-status-provider.ts` which wraps
 * `buildEnvStatusFromProcess` + `buildDaemonPreflightCells`. Future
 * Mode A / in-process consumers may omit the provider entirely; the
 * bridge falls back to idle placeholders so `getWorkspaceEnvStatus`
 * and the daemon half of `getWorkspacePreflightStatus` stay
 * queryable without coupling the bridge to `process.*` state.
 *
 * Scope is intentionally narrow — strictly the two daemon-host
 * cells the bridge currently delegates. NOT a generic logger /
 * metrics seam; new injection needs should go through their own
 * typed interfaces.
 */
export interface DaemonStatusProvider {
  /**
   * Snapshot of the daemon-host process environment for the bound
   * workspace. Reads `process.versions`, runtime / sandbox / proxy
   * state, and presence-only env-var checks. Returns a full
   * `ServeWorkspaceEnvStatus` envelope so the bridge can pass it
   * through to the route handler verbatim — the wire shape is
   * unchanged from pre-injection behavior.
   *
   * @param boundWorkspace canonicalized workspace path the daemon
   *   is bound to (the same value as `BridgeOptions.boundWorkspace`).
   * @param acpChannelLive whether an ACP child is currently up.
   *   Drives the `acpChannelLive` field on the returned envelope so
   *   SDK consumers can render a clear "daemon up but child not
   *   spawned yet" state. The bridge owns this state and passes it
   *   in; the provider does not need to introspect bridge internals.
   */
  getEnvStatus(
    boundWorkspace: string,
    acpChannelLive: boolean,
  ): Promise<ServeWorkspaceEnvStatus>;

  /**
   * Daemon-host preflight cells: Node version, CLI entry path,
   * workspace directory existence, ripgrep / git / npm
   * availability. The implementation typically runs each cell via
   * `Promise.allSettled` so a single failing check doesn't poison
   * the whole result.
   *
   * Returns ONLY the daemon-host cells; the ACP-level cells (auth,
   * mcp_discovery, skills, providers, tool_registry, egress) are
   * fetched separately by the bridge through the ACP child's
   * extMethod RPC. The bridge stitches the two halves together for
   * `getWorkspacePreflightStatus`.
   *
   * @param boundWorkspace canonicalized workspace path; cells like
   *   `workspace_dir` stat this path to check existence.
   */
  getDaemonPreflightCells(
    boundWorkspace: string,
  ): Promise<ServePreflightCell[]>;
}

export type BridgeTelemetryAttributes = Record<
  string,
  string | number | boolean
>;

export type BridgeTelemetryMetrics = DaemonBridgeTelemetryMetrics;

export interface BridgeTelemetry {
  captureContext(): unknown;
  runWithContext<T>(captured: unknown, fn: () => Promise<T>): Promise<T>;
  withSpan<T>(
    operation: string,
    attributes: BridgeTelemetryAttributes,
    fn: () => Promise<T>,
  ): Promise<T>;
  setActiveSpanAttributes?(attributes: BridgeTelemetryAttributes): void;
  event(name: string, attributes: BridgeTelemetryAttributes): void;
  injectPromptContext<T extends object>(request: T): T;
  metrics?: BridgeTelemetryMetrics;
}

/**
 * Construction options for `createAcpSessionBridge`. Most fields are
 * tuning knobs with sensible defaults; `boundWorkspace` is the only
 * strictly-required field. See per-field JSDoc for caller contract.
 */
export interface BridgeOptions {
  /**
   * Process-wide event fan-out supplied by multi-workspace daemon hosts.
   * The bridge uses this only for user-scoped settings, whose persisted value
   * is shared by every workspace. Embedded and single-workspace callers may
   * omit it and retain bridge-local delivery.
   */
  publishGlobalWorkspaceEvent?: (event: Omit<BridgeEvent, 'id' | 'v'>) => void;
  /**
   * Runtime-owned directory for persistent session attachment bytes. Daemon
   * callers provide a workspace-scoped directory under the Qwen runtime temp
   * root. Direct embedded callers may omit it for process-local storage.
   */
  sessionAttachmentsRoot?: string;
  /**
   * `single` shares one session per workspace across HTTP
   * clients (live-collaboration default); `thread` gives each `spawnOrAttach`
   * call its own session for strict isolation.
   *
   * Daemon-wide default. Per-request callers can override via
   * `BridgeSpawnRequest.sessionScope` — the override wins and the
   * daemon-wide value acts only as the fallback when the request
   * omits the field. See the `session_scope_override` capability on
   * `/capabilities.features` for negotiation.
   * Reference:
   * https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644
   */
  sessionScope?: 'single' | 'thread';
  /** Channel factory; defaults to spawning `qwen --acp` as a child process. */
  channelFactory?: ChannelFactory;
  /** How long to wait for the child's `initialize` reply before giving up. */
  initializeTimeoutMs?: number;
  /**
   * How long to wait for `session/load` and `session/resume`. Defaults to
   * 60 seconds; an explicitly configured `initializeTimeoutMs` can raise it,
   * but never lower it.
   */
  sessionRestoreTimeoutMs?: number;
  /**
   * Cap on concurrent live sessions. `spawnOrAttach` calls that would
   * cross this throw `SessionLimitExceededError`; attaches to an
   * existing session (same workspace under `single` scope) are not
   * counted. `0` / `Infinity` disable the cap. Defaults to 32 — see
   * `ServeOptions.maxSessions` for the rationale.
   */
  maxSessions?: number;
  /**
   * Host-level admission hook for fresh session creation across runtimes.
   * Must be synchronous so callers can reserve before any async child or ACP
   * side effect starts. Attaches bypass this hook.
   */
  freshSessionAdmission?: BridgeFreshSessionAdmission;
  /**
   * Host-level live session owner callback. The bridge emits registration
   * only after a live entry is installed, and removal when that live entry is
   * removed. Callback failures are diagnostic only and do not fail session
   * lifecycle operations.
   */
  sessionLifecycle?: BridgeSessionLifecycle;
  /**
   * Per-session SSE replay ring depth. Sets `ringSize` on every
   * `new EventBus(...)` the bridge constructs (both fresh sessions
   * and restored sessions). Defaults to `DEFAULT_RING_SIZE` (8000,
   * the daemon design target). Must be a positive finite integer; `0` /
   * `NaN` / negative throw at boot (fail-CLOSED — same posture as
   * `maxSessions`, where silently disabling a backpressure knob on a
   * config typo is worse than failing to start).
   *
   * Operators tune via `qwen serve --event-ring-size <n>`. Cost
   * scales linearly with `ringSize`; each retained `BridgeEvent` is
   * an object reference plus its serialized payload (text chunks /
   * tool-call args / etc.), so the per-session memory ceiling is
   * `ringSize × average-event-size` held until the session ends.
   */
  eventRingSize?: number;
  /**
   * Per-session cap, in serialized bytes, for the in-memory compacted replay
   * snapshot returned by `session/load` late attach. This bounds daemon heap
   * retained for historical replay; the current unfinished live turn remains in
   * `liveJournal` until its turn boundary. Defaults to 4 MiB. Must be a
   * positive safe integer; there is no unlimited sentinel.
   */
  compactedReplayMaxBytes?: number;
  /**
   * Per-session cap on replay entries retained in the in-flight live journal
   * (the current unfinished turn). Consecutive compatible text/thought chunks
   * share bounded entries. When exceeded, the oldest journal entries are
   * dropped. Defaults to 10 000. Must be a positive safe integer.
   */
  maxJournalEvents?: number;
  /**
   * Per-session source-event byte cap on the in-flight live journal (the
   * current unfinished turn) — accounted from serialized source events even
   * when compatible chunks share a replay entry. When exceeded, the oldest
   * journal entries are dropped whole (at least one entry is always kept),
   * so the retained tail can be much smaller than the cap. Defaults to
   * 8 MiB. Must be a positive safe integer.
   */
  maxJournalBytes?: number;
  /**
   * Pool, in bytes, that per-session live-journal caps may grow into when
   * an in-flight turn outgrows `maxJournalEvents` / `maxJournalBytes`
   * (adaptive growth). The bridge doubles a breaching session's caps —
   * never past a per-session hard cap of 256 MiB — while the growth
   * granted across every live session sharing the pool stays within it.
   * The pool is a DAEMON-WIDE ceiling: `runQwenServe` derives one from the
   * memory budget and hands the same value plus a shared session-limits
   * provider (see `journalGrowthSessionLimits`) to every bridge it
   * constructs, so concurrent growth across workspaces is accounted
   * against one aggregate, not one pool per bridge. `undefined` (the
   * default) disables growth: fixed-cap eviction, exactly the pre-growth
   * behavior. `runQwenServe` skips the pool when the operator pinned the
   * journal flags or the budget resolution leaves no usable headroom. Must
   * be a positive safe integer when provided.
   */
  journalGrowthPoolBytes?: number;
  /**
   * Current journal byte caps of EVERY live session sharing this bridge's
   * growth pool, including this bridge's own, each with the baseline cap
   * that session started at (bridges sharing a pool may run different
   * baselines). `runQwenServe` wires an aggregator over all of its
   * bridges so the daemon-wide pool is accounted once; a standalone
   * bridge leaves it unset and the advisor accounts only this bridge's
   * sessions. Ignored without `journalGrowthPoolBytes`.
   */
  journalGrowthSessionLimits?: () => readonly JournalGrowthSessionLimit[];
  /**
   * Registers this bridge's own live-session journal-cap enumerator with
   * the shared pool (called once at construction when growth is enabled)
   * and receives the unregister hook, invoked on bridge shutdown. Wired by
   * `runQwenServe` alongside `journalGrowthSessionLimits`; ignored without
   * `journalGrowthPoolBytes`.
   */
  registerJournalGrowthSessionLimits?: (
    provider: () => readonly JournalGrowthSessionLimit[],
  ) => () => void;
  /**
   * Per-`requestPermission` wall clock. After this many ms with no client
   * vote, the agent's permission promise resolves as cancelled. Defaults to
   * disabled so human permissions and questions wait for an explicit decision
   * or session lifecycle cancellation.
   * `0` / `Infinity` / non-finite disable the timeout.
   */
  permissionResponseTimeoutMs?: number;
  /**
   * When true, load/resume re-hangs a trailing unanswered ask_user_question
   * via a tracked restore prompt. Default false. Must match the ACP child
   * `--restore-ask-user-question` extraArg.
   */
  restoreAskUserQuestion?: boolean;
  /**
   * Enables direct daemon shell execution through session shell APIs.
   * Defaults to false. Callers should turn this on only after the daemon has
   * bearer auth configured and route layers require a session-bound client id.
   */
  sessionShellCommandEnabled?: boolean;
  /**
   * Per-session cap on pending permissions in flight. New
   * `requestPermission` calls past this cap resolve as cancelled with
   * a stderr warning. Defaults to 64. `0` / `Infinity` disable the
   * cap.
   */
  maxPendingPermissionsPerSession?: number;
  /**
   * Per-session cap on accepted prompts that have not settled yet,
   * including the currently running prompt and queued prompts behind it.
   * Defaults to 5. `0` / `Infinity` disable the cap.
   */
  maxPendingPromptsPerSession?: number;
  /**
   * Absolute, **already-canonical** path this bridge/runtime is bound to.
   * `spawnOrAttach` calls whose
   * `workspaceCwd` doesn't canonicalize to this same value throw
   * `WorkspaceMismatchError` (route → 400 with code `workspace_mismatch`).
   *
   * **Caller contract**: pass the result of
   * `canonicalizeWorkspace(path)`. `runQwenServe` does this at boot
   * and threads the same canonical value into the bridge AND
   * `createServeApp` (via `deps.boundWorkspace`) so all three —
   * `/capabilities.workspaceCwd`, the `POST /session` cwd fallback,
   * and this bridge's mismatch check — share one canonical form. The
   * constructor only checks `path.isAbsolute`; it does NOT
   * re-canonicalize (a redundant `realpathSync.native` could
   * theoretically diverge from the runQwenServe canonicalize on
   * NFS-transient / mid-rename filesystems, landing the bridge with
   * one canonical form while `/capabilities` advertises another).
   * Direct embeds / tests calling `createAcpSessionBridge` themselves
   * MUST canonicalize before passing.
   */
  boundWorkspace: string;
  /**
   * Per-handle env overrides forwarded to `defaultSpawnChannelFactory`
   * at spawn time. Concurrent embedded daemons in the same process
   * use this to avoid cross-contaminating each other's MCP budget /
   * mode env (the `defaultSpawnChannelFactory` snapshots
   * `process.env` AT SPAWN TIME, not at `runQwenServe()` call
   * time — so the last `runQwenServe()` to set the global env
   * would win for all subsequent spawns across all daemon
   * handles, breaking the documented per-daemon policy).
   *
   * Shape: `Record<string, string | undefined>`. A `string` value
   * sets the env var for the child; `undefined` explicitly
   * REMOVES the var from the child env (useful for "this daemon
   * has no MCP budget" embedded callers that need to scrub a
   * stale global). Keys NOT present in this record are inherited
   * from `process.env` as before.
   *
   * Custom `channelFactory` callers receive this through the
   * factory's second arg and decide what to do with it (tests
   * typically ignore it; the production factory merges it).
   */
  childEnvOverrides?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional managed-ACP tool guard. When present, the private ACP child may
   * request one pre-execution decision through the authenticated channel.
   * BridgeClient validates session ownership and the active prompt before
   * invoking this handler. Omitted callers retain the existing behavior and
   * the child-to-parent method is unavailable.
   */
  externalToolGuard?: ExternalToolGuardHandler;
  /**
   * -- optional callback for persisting `tools.
   * approvalMode` to the workspace settings file. Invoked by
   * `setSessionApprovalMode` ONLY when the route caller passes
   * `{persist: true}`. The default `runQwenServe` wires this to
   * `loadSettings(boundWorkspace).setValue(SettingScope.Workspace,
   * 'tools.approvalMode', mode)`. Bridge tests and embedded callers
   * may omit it; when omitted, `setSessionApprovalMode` still applies
   * the in-process change and returns `persisted: false` regardless
   * of the request flag.
   */
  persistApprovalMode?: (
    boundWorkspace: string,
    mode: ApprovalMode,
  ) => Promise<void>;
  /**
   * #4175 Wave 5 PR 22b/2 — optional injection seam for daemon-host
   * status cells (env snapshot, daemon preflight). Production
   * `qwen serve` provides
   * `createDaemonStatusProvider()` from
   * `cli/src/serve/daemon-status-provider.ts`.
   *
   * **When omitted**: the bridge returns idle placeholders for
   * `getWorkspaceEnvStatus` (full envelope with empty `cells: []`
   * and `acpChannelLive` from bridge state) and an empty array for
   * the daemon half of `getWorkspacePreflightStatus` (the ACP-level
   * cells are still fetched normally when a child is live). This
   * matches the "idle status is queryable" pattern previous work
   * established for diagnostic routes — direct embeds and tests
   * that don't need daemon-host cells can omit the provider
   * without crashing those routes.
   *
   * Mode A in-process consumers (`qwen --serve`, future) typically
   * omit this provider — they don't run a separate daemon process
   * so daemon-host environment cells are not meaningful. They can
   * still query the routes; they'll see empty/idle cells.
   */
  statusProvider?: DaemonStatusProvider;
  /** Optional daemon telemetry seam. Omitted callers get no-op spans/logs. */
  telemetry?: BridgeTelemetry;
  /**
   * Optional prompt terminal ledger sink. When provided, the bridge appends
   * an `in_flight` record when a prompt is admitted and a terminal record at
   * the single `publishPromptTerminal` exit (including the close/kill/
   * channel-crash/daemon-shutdown flushes), so a restarted daemon can
   * reconcile dangling prompts on cold session load. Writes are best-effort:
   * failures are logged to stderr and never block prompt execution or
   * teardown. Omitted callers keep the pre-existing behavior (no
   * persistence, cold loads answer "unknown" for pre-restart prompts).
   */
  promptLedger?: PromptLedgerSink;

  /**
   * Whether ACP text reads are delegated to the client filesystem service.
   * Defaults to true for generic ACP, IDE, remote, and virtual-filesystem
   * compatibility. Same-host runtimes may set false so the child uses its
   * regular CLI filesystem service for every `FileSystemService.readTextFile`
   * consumer. Final ACP text writes remain delegated independently.
   */
  delegateReadTextFileToClient?: boolean;

  /**
   * Optional fs injection seam. When provided, the enabled
   * `BridgeClient.readTextFile` / `BridgeClient.writeTextFile` callbacks
   * delegate ACP fs calls to this implementation instead of using
   * BridgeClient's inline `fs.realpath` / `fs.writeFile` / `fs.readFile`
   * proxy.
   *
   * Production `qwen serve` injects a `WorkspaceFileSystem` adapter for final
   * text writes and for defensive handling of unexpected delegated reads.
   *
   * When omitted (tests, Mode A in-process consumers, channels /
   * IDE companion using the bridge directly), BridgeClient's inline
   * proxy is used — preserves the pre-F1 behavior verbatim so
   * existing test fixtures don't need updating and channels /
   * IDE keep working without depending on `cli/src/serve/fs/`.
   */
  fileSystem?: BridgeFileSystem;
  /**
   * -- active permission mediation policy for the
   * `MultiClientPermissionMediator`. When omitted, defaults to
   * `'first-responder'` (the pre-F3 behavior — any validated voter
   * wins immediately). The bridge captures this once at construction
   * time; `runQwenServe` reads it from `settings.policy.
   * permissionStrategy` and the mediator snapshots it onto every
   * pending entry at issue time so live-reload of settings does not
   * change the rules under in-flight requests.
   */
  permissionPolicy?: PermissionPolicy;
  /**
   * -- optional fixed quorum for `consensus` policy.
   * MUST be a positive integer if provided; the F3 settings layer
   * validates this and fails startup on non-integer / non-positive
   * values. Capped at `M = votersAtIssue.size` at request time to
   * prevent unreachable quorum. Unset → `floor(M/2) + 1` (default
   * majority).
   */
  permissionConsensusQuorum?: number;
  /**
   * -- injection seam for the permission audit
   * publisher.
   *
   * **When omitted**: the bridge falls back to
   * `createNoOpPermissionAuditPublisher` so embedded callers (and
   * the bridge unit-test suite) can run the mediator without an
   * audit consumer.
   *
   * **In production** (`qwen serve`), `run-qwen-serve.ts` allocates a
   * `PermissionAuditRing` (default capacity 512), wraps it with
   * `createPermissionAuditPublisher`, and passes the result here.
   * The ring stays alive for the lifetime of the daemon so a future
   * `GET /workspace/permission/audit` route (out of F3 v1 scope)
   * can lift it out for query.
   *
   * Permission timeouts also produce a stderr breadcrumb directly
   * from the mediator's timer callback (independent of this
   * publisher) so operators tailing daemon stderr always see
   * timeouts even when the audit publisher is the no-op fallback.
   */
  permissionAudit?: PermissionAuditPublisher;
  /**
   * Optional: tee `writeServeDebugLine` output. See {@link DiagnosticLineSink}.
   * No-op when omitted. Set by cli `runQwenServe` from the daemon logger.
   */
  onDiagnosticLine?: DiagnosticLineSink;
  /**
   * Milliseconds to keep the ACP child alive after the last session
   * closes. When a new session arrives during the idle window, the
   * warm channel is reused without a cold start. `0` (default) kills
   * the channel immediately (current behavior). The timer is `.unref()`'d
   * so it does not prevent daemon exit.
   */
  channelIdleTimeoutMs?: number;
  /**
   * How often the session reaper scans for idle sessions, in
   * milliseconds. Default: 60_000 (1 minute). `0` or `Infinity`
   * disables the reaper entirely. The timer is `.unref()`'d.
   */
  sessionReapIntervalMs?: number;
  /**
   * A session with zero SSE subscribers and no active prompt that has
   * not received a heartbeat for this many milliseconds is reaped.
   * Note: `clientIds.size` is intentionally NOT checked — the reaper
   * covers the crash path where clients never sent a detach request.
   * Default: 1_800_000 (30 minutes). `0` or `Infinity` disables.
   */
  sessionIdleTimeoutMs?: number;
  /**
   * Reverse tool channel (issue #5626, Phase 2). Looks up the
   * `sendSdkMcpMessage`-shaped sender for a client-hosted MCP server by its
   * advertised `server` name, returning `undefined` when no client currently
   * hosts it.
   *
   * The `qwen --acp` child binds its session `McpClientManager`'s
   * `sendSdkMcpMessage` to a `qwen/control/client_mcp/message` ext-method
   * (child → parent). `BridgeClient.extMethod` answers that method by calling
   * THIS lookup to reach the per-WS-connection `ClientMcpRegistrar` that
   * carries the JSON-RPC frame down the daemon WS to the extension and returns
   * the correlated response.
   *
   * Backed by a process-scoped registry the serve layer populates on
   * `mcp_register` and clears on `mcp_unregister` / WS close (see
   * `cli/src/serve/acp-http/client-mcp-sender-registry.ts`). When omitted
   * (tests, Mode A consumers, channels / IDE companion), the child never
   * receives an SDK MCP runtime server, so the method is never called.
   */
  clientMcpSender?: ClientMcpMessageSender;
  /**
   * Daemon-host seam for the `create_sub_session` tool. When a tool running
   * inside a child's agent turn asks (over `extMethod`) to spawn a fresh
   * top-level sub-session and run a prompt in it, the bridge's `extMethod`
   * dispatch forwards it here. It RETURNS A PROMISE so the `'first-turn'` completion
   * mode can wait for the sub-session's first turn and return its result to the
   * caller. Omitted by tests / Mode A / non-daemon embeds — the tool then
   * reports itself unavailable (daemon-only).
   */
  onCreateSubSession?: CreateSubSessionHandler;
  /** Handles one child-initiated Channel delivery attempt. The bridge
   * authenticates the session and publishes the sanitized result event. */
  onChannelDelivery?: ChannelDeliveryHandler;
}

/**
 * Looks up the JSON-RPC sender for a client-hosted MCP server by name. Returns
 * `undefined` when no client currently advertises `serverName`. The returned
 * callback delivers `payload` to the client-hosted server and resolves with the
 * correlated JSON-RPC response. `payload` is typed `unknown` to keep this
 * package free of an MCP-SDK dependency; the serve layer passes a
 * `JSONRPCMessage`.
 */
export interface ClientMcpMessageContext {
  sessionId?: string;
}

export type ClientMcpMessageSender = (
  serverName: string,
) =>
  | ((payload: unknown, context?: ClientMcpMessageContext) => Promise<unknown>)
  | undefined;

/** Ceiling on a sub-session prompt arriving over `extMethod`. The child is a
 * separate process, so this trust boundary keeps its own enforcement. */
export { MAX_SUB_SESSION_PROMPT_CHARS };

/** Ceiling on the sub-session display name. It is a label — the launcher
 * truncates it to 60 chars for display anyway. */
export const MAX_SUB_SESSION_NAME_CHARS = 200;

/**
 * Payload the bridge forwards to {@link BridgeOptions.onCreateSubSession} when
 * the `create_sub_session` tool requests a sub-session.
 */
export interface CreateSubSessionInfo {
  /** Prompt to run in the freshly-spawned sub-session. */
  prompt: string;
  /** When the request resolves: `'sent'` = as soon as the prompt is dispatched;
   * `'first-turn'` = after the sub-session's first turn completes (result
   * returned). Extensible — more criteria may be added later. */
  completion: 'sent' | 'first-turn';
  /** Optional model service id for the sub-session (falls back to default). */
  model?: string;
  /** Optional display name for the sub-session in the session list. */
  name?: string;
  /**
   * The calling session's id. REQUIRED, and authenticated against the
   * connection's owned sessions before it reaches the host — it keys the
   * per-caller concurrency bucket and the depth-1 nesting gate, so a caller
   * that could omit it would face neither.
   */
  callerSessionId: string;
}

/** Result the daemon host returns for a create-sub-session request. `result`
 * (the sub-session's first-turn output) is present only for `'first-turn'`. */
export interface CreateSubSessionResult {
  sessionId: string;
  result?: string;
  stopReason?: string;
  /** Whether the parent lineage was durably written to the sub-session's
   * transcript. `false` = live-only (gone from the persisted list after a
   * daemon restart). Absent when the spawn carried no parent. */
  parentSessionPersisted?: boolean;
}

/** Daemon-host callback that spawns a sub-session and (for `'first-turn'`) waits
 * for its first turn. Returns a Promise so the tool can block on the result. */
export type CreateSubSessionHandler = (
  info: CreateSubSessionInfo,
) => Promise<CreateSubSessionResult>;

export const MAX_LIVE_SCREEN_CONTEXT_TEXT_CHARS = 32_000;

export interface LiveScreenContextCaptureInfo {
  callerSessionId: string;
}

export interface LiveScreenContextCaptureResult {
  appName: string;
  windowTitle?: string;
  accessibilityText: string;
  screenshotPath: string;
}

export type LiveScreenContextCaptureHandler = (
  info: LiveScreenContextCaptureInfo,
) => Promise<LiveScreenContextCaptureResult>;

export const LIVE_TASK_TOOL_NAMES = [
  'list_threads',
  'read_thread',
  'wait_threads',
  'send_message_to_thread',
  'create_thread',
] as const;

export type LiveTaskToolName = (typeof LIVE_TASK_TOOL_NAMES)[number];

export interface LiveTaskToolRequestInfo {
  callerSessionId: string;
  name: LiveTaskToolName;
  arguments: Record<string, unknown>;
}

export type LiveTaskToolRequestHandler = (
  info: LiveTaskToolRequestInfo,
) => Promise<Record<string, unknown>>;

export const MAX_LIVE_SPEAK_TO_USER_MESSAGE_CHARS = 32_000;

export interface LiveSpeakToUserInfo {
  callerSessionId: string;
  message: string;
}

export type LiveSpeakToUserHandler = (
  info: LiveSpeakToUserInfo,
) => Promise<void>;

// Canonical set — cli channel-delivery-ipc.ts and bridgeClient.ts import this;
// sdk-typescript events.ts carries an independent copy with a cross-check test.
export type ChannelDeliveryErrorCode =
  | 'channel_worker_unavailable'
  | 'channel_delivery_timeout'
  | 'channel_delivery_invalid'
  | 'channel_delivery_rejected'
  | 'channel_delivery_queue_full'
  | 'channel_delivery_failed';

export const CHANNEL_DELIVERY_ERROR_CODES: ReadonlySet<string> = new Set([
  'channel_worker_unavailable',
  'channel_delivery_timeout',
  'channel_delivery_invalid',
  'channel_delivery_rejected',
  'channel_delivery_queue_full',
  'channel_delivery_failed',
]);

export interface ChannelDeliveryInfo {
  sessionId: string;
  deliveryId: string;
  source: 'prompt' | 'scheduled';
  target: {
    channelName: string;
    type: 'user' | 'chat';
    id: string;
  };
  text: string;
  promptId?: string;
  taskId?: string;
  firedAt?: number;
}

export type ChannelDeliveryHostResult =
  | { status: 'delivered' }
  | { status: 'skipped' }
  | {
      status: 'failed';
      code: ChannelDeliveryErrorCode;
      error: string;
    };

export type ChannelDeliveryHandler = (
  info: ChannelDeliveryInfo,
) => Promise<ChannelDeliveryHostResult>;
