/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  CancelNotification,
  PromptRequest,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type { ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  TrustGateError,
  getCurrentGeminiMdFilename,
  ShellExecutionService,
  type ShellOutputEvent,
} from '@qwen-code/qwen-code-core';
import type { ShellCommandResult } from './bridgeTypes.js';
import type { AcpChannel } from './channel.js';
import { EventBus, DEFAULT_RING_SIZE, type BridgeEvent } from './eventBus.js';
import { TurnBoundaryCompactionEngine } from './compactionEngine.js';
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  createIdleAcpPreflightCells,
  createIdleEnvStatus,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceSkillsStatus,
  mapDomainErrorToErrorKind,
  type ServePreflightCell,
  type ServeSessionTasksStatus,
  type ServeStatusCell,
} from './status.js';
import {
  SessionNotFoundError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  // Mediator's `vote()` validates `optionId ∈ allowedOptionIds`,
  // but the bridge ALSO throws `InvalidPermissionOptionError`
  // pre-mediator when a wire client tries to inject the cancel
  // sentinel via a `selected` outcome (wenshao review #4335 /
  // 3271185588 — without this guard, a wire-supplied
  // `optionId === CANCEL_VOTE_SENTINEL` would short-circuit all
  // policy dispatch).
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  isNotCurrentlyGeneratingCancelError,
} from './bridgeErrors.js';
import { canonicalizeWorkspace } from './workspacePaths.js';
import type {
  BridgeSession,
  BridgeRestoreSessionRequest,
  BridgeSessionState,
  BridgeRestoredSession,
  BridgeSessionSummary,
  HttpAcpBridge,
} from './bridgeTypes.js';
import type { BridgeOptions, BridgeTelemetry } from './bridgeOptions.js';
import { MCP_RESTART_SERVER_DEADLINE_MS } from './mcpTimeouts.js';
import { defaultSpawnChannelFactory } from './spawnChannel.js';
import { writeStderrLine } from './internal/stderrLine.js';
import { BridgeClient } from './bridgeClient.js';
import {
  CANCEL_VOTE_SENTINEL,
  createNoOpPermissionAuditPublisher,
  MultiClientPermissionMediator,
  type PermissionAuditPublisher,
} from './permissionMediator.js';
import { PermissionForbiddenError } from './bridgeErrors.js';

const NOOP_BRIDGE_TELEMETRY: BridgeTelemetry = {
  captureContext: () => undefined,
  runWithContext(_captured, fn) {
    return fn();
  },
  withSpan(_operation, _attributes, fn) {
    return fn();
  },
  event() {},
  injectPromptContext(request) {
    const meta = (request as { _meta?: unknown })._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return request;
    }
    const record = meta as Record<string, unknown>;
    if (
      !(DAEMON_TRACEPARENT_META_KEY in record) &&
      !(DAEMON_TRACESTATE_META_KEY in record)
    ) {
      return request;
    }
    const nextMeta = { ...record };
    delete nextMeta[DAEMON_TRACEPARENT_META_KEY];
    delete nextMeta[DAEMON_TRACESTATE_META_KEY];
    return { ...request, _meta: nextMeta };
  },
};

/**
 * Stage 1 HTTP→ACP bridge factory + supporting helpers, lifted from
 * `cli/src/serve/httpAcpBridge.ts` to `@qwen-code/acp-bridge/bridge`
 * in #4175 PR F1 (step 3) so the bridge core can be consumed by
 * `channels/base/AcpBridge.ts` and the VSCode IDE companion without
 * reaching into the cli package.
 *
 * Per #3803 §02 (architectural revision) and design §08 (Roadmap, Stage 1):
 *   - **1 daemon = 1 workspace**: every bridge instance is bound to a
 *     single canonical workspace path at construction
 *     (`BridgeOptions.boundWorkspace`). All `spawnOrAttach` calls must
 *     target that workspace; cross-workspace requests throw
 *     `WorkspaceMismatchError`. Multi-workspace deployments use multiple
 *     daemon processes (one per workspace, supervised externally).
 *   - One `qwen --acp` child total; multiple sessions multiplex onto it
 *     via `connection.newSession()` (the agent's native
 *     `sessions: Map<string, Session>` — see `acp-integration/acpAgent.ts:194`).
 *     Sessions share the child's process / OAuth state / `FileReadCache` /
 *     hierarchy-memory parse.
 *   - HTTP request bodies are forwarded as ACP NDJSON over the child's stdin.
 *   - Child stdout NDJSON notifications publish onto each session's
 *     `EventBus`; HTTP SSE subscribers (`GET /session/:id/events`) drain
 *     it. Cross-client fan-out + `Last-Event-ID` reconnect supported.
 *   - Multi-client requests against the same session serialize through this
 *     bridge (FIFO; honors ACP's "one active prompt per session" invariant).
 *     Different sessions on the same channel can prompt concurrently —
 *     the ACP layer demultiplexes by sessionId.
 *
 * Stage 2 replaces the spawn step with an in-process call into core's
 * ACP-equivalent API. The `HttpAcpBridge` interface stays the same so HTTP
 * route handlers don't need to change.
 */

interface ChannelInfo {
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Shared BridgeClient — its methods route ACP params by sessionId. */
  client: BridgeClient;
  // Note: pre-§02 a `workspaceCwd: string` field lived here so the
  // `byWorkspaceChannel.get(entry.workspaceCwd)` lookup could route
  // multi-workspace requests. Under "1 daemon = 1 workspace" the
  // module-scope `boundWorkspace` is the single source of truth and
  // every channel inherits it. Per-channel storage would suggest
  // variance the model doesn't allow; dropping it makes the
  // single-workspace invariant visible at the type level.
  /**
   * Live session ids multiplexed on this channel. Updated when
   * `doSpawn` registers a new session and when `killSession` /
   * `channel.exited` removes one. When the set drops to empty under
   * `killSession`, the channel is marked `isDying = true` and its
   * `channel.kill()` is awaited; `channelInfo` itself is left
   * pointing at the dying channel until `channel.exited` fires (see
   * BkUyD invariant on `isDying` below).
   */
  sessionIds: Set<string>;
  /**
   * Restore calls currently executing on this channel but not yet registered
   * in `sessionIds`. Used to avoid killing the shared channel when one pending
   * restore fails while another is still healthy.
   */
  pendingRestoreIds: Set<string>;
  /**
   * Cached channel-close race for workspace-scoped status requests. Workspace
   * status can be polled frequently by dashboards, so keep one promise per
   * channel instead of attaching a new `.then()` to `channel.exited` per poll.
   */
  statusClosedReject?: Promise<never>;
  /**
   * MUST be set to `true` synchronously by any teardown path BEFORE
   * awaiting `channel.kill()`. `ensureChannel` treats a dying channel
   * as absent and spawns a fresh one — without this flag a concurrent
   * `spawnOrAttach` arriving during the SIGTERM grace window (up to
   * 10s) would attach to a transport about to close, landing the
   * caller with a sessionId that 404s on every follow-up request.
   *
   * **Set-sites (5)** — any new teardown path MUST call into one of
   * these or replicate the pattern:
   *
   *   1. `ensureChannel`: `initialize`-failure catch.
   *   2. `ensureChannel`: late-shutdown re-check (shuttingDown flipped
   *      during handshake).
   *   3. `doSpawn`: newSession-failure on an empty channel
   *      (sessionIds.size === 0).
   *   4. `killSession`: last session leaving (sessionIds.size === 0
   *      after the delete).
   *   5. `shutdown`: bulk-mark every entry in `aliveChannels`.
   *
   * **BkUyD invariant (why we don't clear `channelInfo` here)**:
   * `killAllSync` must still find the channel during the SIGTERM
   * grace window to fire SIGKILL on `process.exit(1)`. `aliveChannels`
   * holds the dying entry until `channel.exited` fires (OS-level
   * reap); `isDying` is the "available-for-new-spawns" half of the
   * two-bit (alive, dying) state.
   */
  isDying: boolean;
}

interface SessionEntry {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  displayName?: string;
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Per-session event bus drives `GET /session/:id/events`. */
  events: EventBus;
  /**
   * Tail of the per-session prompt queue. Each new prompt chains off the
   * resolved (or rejected) state of this promise so prompts run one at a
   * time in arrival order. Always resolves — failures are swallowed at the
   * tail so a prior failure doesn't block subsequent prompts; the original
   * caller still observes the rejection on its own returned promise.
   */
  promptQueue: Promise<void>;
  /**
   * Per-session model-change FIFO. Prevents two concurrent
   * `applyModelServiceId` calls (e.g. simultaneous attach-with-different-
   * model requests) from racing into `unstable_setSessionModel` and
   * leaving the agent in non-deterministic state. Always resolves —
   * failures swallowed at the tail like `promptQueue`.
   */
  modelChangeQueue: Promise<void>;
  /**
   * A1 (#4511): true while the bridge is driving a model roundtrip
   * (`setSessionModel` / `applyModelServiceId`) for this session. The
   * `current_model_update` extNotification demux in `BridgeClient` reads this
   * to SUPPRESS promotion of the agent's notification during a bridge-driven
   * change — the bridge publishes the authoritative `model_switched` itself,
   * so promoting the notification too would double-publish. In-session
   * `/model` (no bridge roundtrip) sees this false and IS promoted.
   */
  modelRoundtripInFlight?: boolean;
  /**
   * Per-session approval-mode FIFO (doudouOUC #4484 post-merge review,
   * A3). Mirrors `modelChangeQueue`: serializes concurrent
   * `setSessionApprovalMode` calls so two `POST /session/:id/approval-mode`
   * can't race their ACP roundtrip + persist and publish an
   * `approval_mode_changed` event whose `next` mode disagrees with the
   * mode the ACP child actually settled on. Always resolves — failures
   * swallowed at the tail like `modelChangeQueue`.
   */
  approvalModeQueue: Promise<void>;
  /**
   * Cached "transport closed" promise. The first `sendPrompt` on a
   * session lazy-builds this from `channel.exited.then(throw)`; every
   * subsequent prompt's race uses the SAME promise so the listener
   * count on `channel.exited` stays at one regardless of how many
   * prompts run on the session over its lifetime.
   */
  transportClosedReject?: Promise<never>;
  /**
   * Permission requestIds belonging to this session, kept so cancelSession
   * + shutdown can resolve them as `cancelled` per ACP requirement
   * (cancelled prompt MUST resolve outstanding requestPermission with
   * outcome.cancelled).
   */
  pendingPermissionIds: Set<string>;
  /**
   * Daemon-issued client ids currently known for this live session. HTTP
   * clients may echo one through `X-Qwen-Client-Id`; the bridge only treats
   * it as trusted originator metadata if it appears in this set.
   */
  clientIds: Map<string, number>;
  /**
   * Originator for the prompt currently running on this session. ACP enforces
   * one active prompt per session, and this bridge FIFO-serializes prompts, so
   * inline session updates / permission requests can safely inherit this id.
   */
  activePromptOriginatorClientId?: string;
  /**
   * Per-prompt "already broadcast `prompt_cancelled`" latch (doudouOUC
   * #4484 post-merge review, D2). The explicit `cancelSession` route and
   * the `sendPrompt` abort path (originator SSE drop) can both fire for
   * the same active prompt — e.g. a client POSTs /cancel then immediately
   * closes its socket. Without dedup, peers receive two `prompt_cancelled`
   * frames for one turn. Reset to `false` when the **next prompt starts**
   * (the latch is per-prompt); set `true` on the first broadcast. A cancel
   * against an already-settled / idle session may be suppressed until the
   * next prompt starts — acceptable since an idle-session cancel is a
   * harmless no-op (see `cancelSession`).
   */
  cancelBroadcast?: boolean;
  /**
   * Count of times `spawnOrAttach` has returned `attached: true` for
   * this entry — i.e. a second-or-subsequent client claimed this
   * session under `sessionScope: 'single'`. Used by the disconnect-
   * reaper in `server.ts`: if the spawn-owner client disconnected
   * during the spawn handshake but another client has already
   * attached, the reaper must NOT tear the session down (option 1
   * from PR #3889 review BQ9tV — "track an attached-after-spawn
   * counter and skip kill if any other client attached"). The
   * increment + the killSession-skip-check both happen in the
   * synchronous portion of their respective async functions, so the
   * counter is observed atomically across the awaiting boundary.
   */
  attachCount: number;
  /**
   * BkwQP: tombstone for the spawn-owner-disconnect path. When the
   * spawn owner's HTTP response can't be written and they call
   * `killSession({ requireZeroAttaches: true })` but the bail
   * triggers (because some other client already bumped
   * `attachCount`), set this flag — it remembers the spawn owner
   * wanted the session reaped. A later `detachClient()` that brings
   * `attachCount` back to 0 then completes the deferred reap. Stays
   * `false` for sessions the spawn owner never tried to kill, so
   * `detachClient` of a transient attach doesn't reap a still-valid
   * session.
   */
  spawnOwnerWantedKill: boolean;
  /**
   * ACP state captured at `session/load` / `session/resume` time so
   * late attachers (existing-byId early-return + coalesced restore
   * waiters) get the same payload the original restore caller did.
   * `undefined` for sessions created via `doSpawn` — those have never
   * had an ACP load/resume response, so attaches return `state: {}`.
   */
  restoreState?: BridgeSessionState;
  /**
   * Most recent heartbeat across any client on this session (Date.now()
   * epoch ms). Set on every `recordHeartbeat` call regardless of whether
   * the caller identified themselves; consumed by future diagnostics
   * (PR 12) and revocation policy (PR 24). Undefined until the first
   * heartbeat lands.
   */
  sessionLastSeenAt?: number;
  /**
   * Per-`clientId` last heartbeat (Date.now() epoch ms). Only populated
   * when the heartbeat carried a trusted `X-Qwen-Client-Id`. Entries are
   * dropped together with the parent session — there's no per-client
   * eviction in this PR; revocation policy (PR 24) will own that.
   */
  clientLastSeenAt: Map<string, number>;
}

function isServeDebugLoggingEnabled(): boolean {
  const value = process.env['QWEN_SERVE_DEBUG'];
  if (!value) return false;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function writeServeDebugLine(message: string): void {
  if (!isServeDebugLoggingEnabled()) return;
  writeStderrLine(`qwen serve debug: ${message}`);
}

const MAX_DISPLAY_NAME_LENGTH = 256;

/**
 * Upper bound on how many prompt content blocks the bridge echoes per
 * prompt. A programmatically-generated prompt with thousands of small
 * blocks would otherwise trigger thousands of synchronous `publish()`
 * fan-outs (each up to the per-bus subscriber cap) and flood the
 * replay ring, evicting real history for every SSE subscriber. 256 is
 * far above any human-authored prompt's block count.
 */
const MAX_ECHO_CONTENT_BLOCKS = 256;

function extractPermissionResponseMetadata(
  response: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  // Keep this extension deliberately narrow. Today the only non-ACP field
  // expected by the agent is AskUserQuestion's `answers` payload.
  const answers = (response as { readonly answers?: unknown }).answers;
  if (
    answers !== null &&
    typeof answers === 'object' &&
    !Array.isArray(answers)
  ) {
    const entries = Object.entries(answers as Record<string, unknown>);
    if (entries.every(([, v]) => typeof v === 'string')) {
      return { answers };
    }
  }
  return undefined;
}

/**
 * Echo a user prompt to the session bus so multi-client SSE subscribers
 * see the input alongside the agent response. Iterates content blocks
 * and emits one `user_message_chunk` per block, mirroring the shape the
 * agent itself emits in the cron path (`Session.ts` cron handler) and
 * the history-replay path (`HistoryReplayer`). The regular interactive
 * `Session#executePrompt` was the historical outlier — it forwarded
 * the prompt straight to the LLM without going through the session bus.
 *
 * Originator dedup: SDK consumers using `normalizeDaemonEvent` with
 * `suppressOwnUserEcho: true` skip the echo for the originator (the
 * envelope-level `originatorClientId` matches their own clientId).
 *
 * Anonymous-prompt caveat (D2-review D5): a stable `X-Qwen-Client-Id` is a
 * PRECONDITION for that dedup. A prompt with no clientId (curl smoke /
 * pre-registration script) produces an envelope without
 * `originatorClientId`, so `suppressOwnUserEcho` has nothing to match and
 * the originating connection sees its own input echoed back. This is an
 * accepted edge for headless/anonymous callers; interactive multi-client
 * UIs always carry a clientId and are unaffected.
 *
 * Source marker: `_meta.source: 'bridge-echo'` lets downstream tooling
 * distinguish bridge-synthesized echoes from agent-emitted content if
 * needed (e.g., for replay-deduplication when the agent later catches
 * up and emits the same chunk through `HistoryReplayer`).
 */
function echoPromptToSessionBus(
  entry: SessionEntry,
  req: PromptRequest,
  originatorClientId: string | undefined,
): void {
  // `PromptRequest.prompt` is a non-optional `ContentBlock[]` per the
  // ACP type contract — read it directly so a future SDK bump that
  // makes it optional surfaces as a TypeScript error rather than being
  // silently swallowed by an `unknown` cast.
  // `PromptRequest.prompt` is typed as a non-optional `ContentBlock[]`, so
  // TS guarantees the shape. The runtime `Array.isArray` guard (D6) is pure
  // defense-in-depth for a malformed HTTP body that slips past the type
  // contract — cheaper than a thrown `TypeError` mid-echo.
  const prompt = req.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return;
  const serverTimestamp = Date.now();
  const blockCount = Math.min(prompt.length, MAX_ECHO_CONTENT_BLOCKS);
  for (let i = 0; i < blockCount; i += 1) {
    const part = prompt[i];
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    // Every `ContentBlock` variant (text, image, audio, resource) is
    // published to the bus verbatim. The SDK's `normalizeDaemonEvent`
    // accepts any `content` shape; rich rendering of non-text blocks is
    // the consumer's responsibility. (Core's first-class multimodal
    // user-content emit is tracked separately in PR #4353 §D — that
    // affects the agent-side replay path, not this bridge echo.)
    try {
      entry.events.publish({
        type: 'session_update',
        data: {
          sessionId: req.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: part,
            // D3 (doudouOUC #4484 post-merge review): `_meta` lives inside
            // the `update` object rather than at envelope level. Kept here
            // deliberately — `_meta` is a standard JSON-RPC/MCP extension
            // field permitted alongside spec fields, the SDK normalizer
            // reads it from `update._meta`/`data._meta`, and every other
            // agent-emitted session_update carries `_meta` the same way.
            // Relocating to the envelope would be a coordinated wire change
            // across all emitters + the SDK for no functional gain.
            _meta: { serverTimestamp, source: 'bridge-echo' },
          },
        },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    } catch {
      // bus may be closed (session being torn down); ignore — the
      // prompt forward still proceeds.
    }
  }
}

/**
 * Publish a `prompt_cancelled` event to the session bus so peer SSE
 * subscribers observe the cancel as a first-class event instead of
 * inferring it from the absence of further `agent_message_chunk`
 * frames.
 *
 * Semantic: this signals **cancel REQUESTED**, not **cancel
 * confirmed** — it's published before the ACP `cancel` notification is
 * forwarded/awaited (so peers learn promptly even if the agent is slow
 * to wind down or the channel is dead). If a consumer needs hard
 * confirmation it should observe the subsequent terminal
 * `tool_call_update` / `agent_message_chunk` quiescence.
 *
 * `originatorClientId` identifies the cancelling client. Used by both
 * the explicit `cancelSession` route and the `sendPrompt` abort path
 * (originator SSE disconnect) so neither cancel route is a silent gap.
 */
function broadcastPromptCancelled(
  entry: SessionEntry,
  sessionId: string,
  originatorClientId: string | undefined,
  reason?: 'forward_failed',
): void {
  try {
    entry.events.publish({
      type: 'prompt_cancelled',
      data: { sessionId, ...(reason ? { reason } : {}) },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
  } catch {
    /* bus closed */
  }
}

/**
 * D2 dedup wrapper around {@link broadcastPromptCancelled}. Broadcasts at
 * most once per active prompt by latching `entry.cancelBroadcast`, so the
 * `cancelSession` route and the `sendPrompt` abort path can't both emit a
 * `prompt_cancelled` for a single turn (POST /cancel then socket close).
 * The latch is reset when the next prompt starts.
 */
function broadcastPromptCancelledOnce(
  entry: SessionEntry,
  sessionId: string,
  originatorClientId: string | undefined,
  reason?: 'forward_failed',
): void {
  if (entry.cancelBroadcast) {
    writeStderrLine(
      `broadcastPromptCancelledOnce: suppressed duplicate cancel for session ${sessionId} (latch already set)`,
    );
    return;
  }
  entry.cancelBroadcast = true;
  broadcastPromptCancelled(entry, sessionId, originatorClientId, reason);
}

function broadcastTurnComplete(
  entry: SessionEntry,
  sessionId: string,
  promptResult: { stopReason?: string; [k: string]: unknown },
  promptId: string | undefined,
  originatorClientId: string | undefined,
): void {
  entry.events.publish({
    type: 'turn_complete',
    data: {
      sessionId,
      stopReason: promptResult.stopReason ?? 'end_turn',
      ...(promptId ? { promptId } : {}),
    },
    ...(originatorClientId ? { originatorClientId } : {}),
  });
}

function broadcastTurnError(
  entry: SessionEntry,
  sessionId: string,
  err: unknown,
  promptId: string | undefined,
  originatorClientId: string | undefined,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error &&
    'code' in err &&
    typeof (err as Error & { code?: unknown }).code === 'string'
      ? (err as Error & { code: string }).code
      : undefined;
  entry.events.publish({
    type: 'turn_error',
    data: {
      sessionId,
      message,
      ...(code ? { code } : {}),
      ...(promptId ? { promptId } : {}),
    },
    ...(originatorClientId ? { originatorClientId } : {}),
  });
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const PERSIST_TIMEOUT_MS = 5_000;
/**
 * Backstop timeout for `qwen/control/session/recap`. The underlying
 * side-query is single-attempt with `maxOutputTokens: 300`, so a
 * healthy call finishes in 1–5 seconds; we cap at 60s to absorb model-
 * provider hiccups without inheriting the 10s `initTimeoutMs` default
 * (which would false-fire on any GPT-style slow start). The race is a
 * safety net against a wedged ACP channel — there is no HTTP-side
 * disconnect cancellation in v1 (see server.ts route comment).
 */
const SESSION_RECAP_TIMEOUT_MS = 60_000;
const SESSION_BTW_TIMEOUT_MS = 60_000;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const MAX_SHELL_OUTPUT_FOR_HISTORY = 10_000;
const DEFAULT_MAX_SESSIONS = 20;
/**
 * Soft upper bound on `BridgeOptions.eventRingSize` to catch operator
 * typos before they OOM the daemon. At ~500 B per `BridgeEvent` an
 * 1 000 000-frame ring already pins ~500 MB per session — well past
 * any realistic workload. Not a security boundary (the flag is
 * operator-controlled), just typo defense.
 */
const MAX_EVENT_RING_SIZE = 1_000_000;
// Bd1yh: per-permission-request wall clock. Without this, an agent
// calling `requestPermission` while no SSE subscriber is connected
// would hang the per-session FIFO promptQueue forever (the prompt
// can't complete, every subsequent prompt is blocked behind it).
// 5 minutes is generous for "human reads UI, decides, clicks
// approve" while still bounded enough to recover from a wedged
// state. Configurable via `BridgeOptions.permissionResponseTimeoutMs`.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
// Bd1z5: per-session cap on pending permissions in flight. A chatty
// agent making rapid `requestPermission` calls would otherwise grow
// `pendingPermissions` unboundedly — each entry is a UUID + closure
// + bus event. 64 mirrors `DEFAULT_MAX_SUBSCRIBERS` (one pending
// per subscriber feels like a reasonable headroom). Excess requests
// resolve as cancelled and emit a stderr warning so operators see
// the limit being hit. Configurable via
// `BridgeOptions.maxPendingPermissionsPerSession`.
const DEFAULT_MAX_PENDING_PER_SESSION = 64;

export function createHttpAcpBridge(opts: BridgeOptions): HttpAcpBridge {
  const defaultSessionScope = opts.sessionScope ?? 'single';
  // `undefined` → default 20 (intentionally tight per #3803 N≈50 cliff).
  // `0` → explicitly unlimited (operator opt-out).
  // `Infinity` → unlimited (programmatic opt-out — accepted as a
  //              long-standing alias since the cap check is `>= max`).
  // `NaN` / negative → throw. A typo / parse error in CLI/config
  //                    silently disabling the daemon's only resource
  //                    guard is fail-OPEN behavior; gpt-5.5 flagged
  //                    this as critical (BRApy) — we'd rather fail
  //                    boot than serve unbounded.
  let maxSessions: number;
  if (opts.maxSessions === undefined) {
    maxSessions = DEFAULT_MAX_SESSIONS;
  } else if (Number.isNaN(opts.maxSessions)) {
    throw new TypeError(
      `Invalid maxSessions: NaN. Must be a number >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions < 0) {
    throw new TypeError(
      `Invalid maxSessions: ${opts.maxSessions}. Must be >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions === 0 || opts.maxSessions === Infinity) {
    maxSessions = Infinity;
  } else {
    maxSessions = opts.maxSessions;
  }
  if (defaultSessionScope !== 'single' && defaultSessionScope !== 'thread') {
    throw new TypeError(
      `Invalid sessionScope: ${JSON.stringify(defaultSessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
  }
  // `eventRingSize` follows the same fail-CLOSED posture as
  // `maxSessions`: silently disabling SSE backpressure on a config
  // typo is worse than failing to start. Unlike `maxSessions` there
  // is NO unlimited sentinel — an unbounded ring would grow forever.
  // Soft upper bound MAX_EVENT_RING_SIZE catches operator typos
  // (`--event-ring-size 80000000` instead of `8000000`); at 1M
  // frames × ~500 B/frame the per-session ceiling is already
  // ~500 MB, well past any legitimate use.
  const eventRingSize = opts.eventRingSize ?? DEFAULT_RING_SIZE;
  // `Number.isInteger` already rejects NaN / Infinity / non-finite
  // — no separate `Number.isFinite` guard needed.
  if (
    !Number.isInteger(eventRingSize) ||
    eventRingSize < 1 ||
    eventRingSize > MAX_EVENT_RING_SIZE
  ) {
    throw new TypeError(
      `Invalid eventRingSize: ${opts.eventRingSize}. ` +
        `Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`,
    );
  }
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  // PR 14 fix (review #4247 wenshao R5 runQwenServe.ts:216): close over
  // a per-handle env-override snapshot. Calls to `channelFactory` at
  // spawn time receive this as the 2nd arg, so the default factory
  // can merge into the child env without consulting any global state
  // that another concurrent `runQwenServe()` handle might have
  // mutated. Frozen to make accidental mutation throw rather than
  // silently corrupt later spawns.
  const childEnvOverrides: Readonly<Record<string, string | undefined>> =
    opts.childEnvOverrides
      ? Object.freeze({ ...opts.childEnvOverrides })
      : Object.freeze({});
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (initTimeoutMs <= 0) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must be > 0.`,
    );
  }
  // Bd1yh + Bd1z5: per-permission deadline + per-session pending cap.
  // 0 / Infinity / non-finite (NaN, -1) all disable — same sentinel
  // convention as maxSessions / maxConnections.
  const permissionTimeoutRaw =
    opts.permissionResponseTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const permissionTimeoutMs =
    permissionTimeoutRaw > 0 && Number.isFinite(permissionTimeoutRaw)
      ? permissionTimeoutRaw
      : 0; // 0 = disabled
  const maxPendingRaw =
    opts.maxPendingPermissionsPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
  const maxPendingPerSession =
    maxPendingRaw > 0 && Number.isFinite(maxPendingRaw)
      ? maxPendingRaw
      : Infinity;
  // #3803 §02: the bound path is the canonical form `spawnOrAttach`
  // compares incoming `workspaceCwd` against. The caller MUST pass an
  // already-canonical value (via `canonicalizeWorkspace`). `runQwenServe`
  // does this at boot and threads the same value into both
  // `createHttpAcpBridge` and `createServeApp` (via
  // `deps.boundWorkspace`); direct embeds / tests that construct the
  // bridge themselves must call `canonicalizeWorkspace` first.
  //
  // Pre-fix the bridge re-canonicalized defensively here. The fix
  // (deepseek-v4-pro review) drops the redundant `realpathSync.native`:
  // (a) on case-insensitive / symlinked filesystems two independent
  // `realpathSync.native` calls could theoretically disagree if the FS
  // mutates between them (NFS transient, operator rename), landing
  // the bridge with one canonical form while `runQwenServe` advertises
  // another and `/capabilities` clients see `workspace_mismatch` on
  // every POST; (b) it's a syscall removed from the boot path. The
  // `path.isAbsolute` guard stays — it's a structural input check, not
  // a syscall.
  if (!path.isAbsolute(opts.boundWorkspace)) {
    throw new TypeError(
      `Invalid boundWorkspace: "${opts.boundWorkspace}". Must be an ` +
        `absolute path.`,
    );
  }
  const boundWorkspace = opts.boundWorkspace;
  // #4282 fold-in 5 (Codex P2-1). Snapshot the configured context
  // filename at construction time. The daemon parent never updates
  // the process-global through `loadCliConfig`, so `runQwenServe`
  // reads the workspace's merged settings and forwards the value
  // here. Falling back to `getCurrentGeminiMdFilename()` keeps
  // bridge tests + embedded callers working without explicit setup.
  const contextFilename = opts.contextFilename ?? getCurrentGeminiMdFilename();
  const persistApprovalMode = opts.persistApprovalMode;
  const persistDisabledTools = opts.persistDisabledTools;
  const telemetry = opts.telemetry ?? NOOP_BRIDGE_TELEMETRY;

  // #3803 §02 single-workspace model: the bridge hosts AT MOST one
  // ATTACH-AVAILABLE channel and one default attach-target entry.
  // Multi-session multiplexing happens through `channelInfo.sessionIds`;
  // the `defaultEntry` slot is the FIRST session created (the one a
  // same-workspace attach under `single` scope reuses). Thread-scope
  // sessions add to `byId` but don't displace `defaultEntry`.
  let defaultEntry: SessionEntry | undefined;
  // `channelInfo` is the SINGLE attach-available channel. Cleared
  // ONLY by the `channel.exited` handler (see below) when the OS
  // reaps the underlying child process. Teardown initiators
  // (`killSession` last-session-leaving, `doSpawn`-newSession-failure
  // on an empty channel, `ensureChannel` init-failure /
  // late-shutdown, `shutdown`) set `isDying = true` but LEAVE
  // `channelInfo` pointing at the dying channel until OS reap — that
  // asymmetry IS the BkUyD invariant. It lets `killAllSync` reach a
  // mid-SIGTERM-grace channel through `aliveChannels` while a
  // concurrent `spawnOrAttach` can already start spawning a fresh
  // replacement (which overwrites `channelInfo` when its
  // handshake completes). Race-aware code paths (`ensureChannel`,
  // `killAllSync`) gate on `isDying` rather than presence; see
  // `ChannelInfo.isDying` for the per-set-site rationale.
  let channelInfo: ChannelInfo | undefined;
  // tanzhenxin BkUyD: superset of `channelInfo` covering channels
  // that are dying but not yet OS-reaped. `killSession` /
  // `doSpawn`-newSession-failure / `shutdown` mark a channel as
  // `isDying` and start its async kill; meanwhile a concurrent
  // `spawnOrAttach` can spawn a FRESH channel and reassign
  // `channelInfo`. Without this set, the dying channel becomes
  // unreachable — a double-Ctrl+C arriving mid-grace would call
  // `killAllSync()`, find only the fresh channel in `channelInfo`,
  // force-kill it, and `process.exit(1)` would orphan the dying one
  // whose SIGTERM hadn't yet completed. The set is the OS-level
  // "still alive" source of truth: entries are added when a channel
  // is created and removed when its `channel.exited` resolves.
  // `killAllSync` iterates THIS set to fire SIGKILL on every alive
  // child regardless of whether it's still the attach target.
  const aliveChannels = new Set<ChannelInfo>();
  // Coalesces a concurrent second `ensureChannel()` call onto the
  // first one's spawn so we never create two children for the same
  // daemon. Cleared in the `finally` of the creator.
  let inFlightChannelSpawn: Promise<ChannelInfo> | undefined;
  const byId = new Map<string, SessionEntry>();
  // F3 Commit 3 — pending + resolved permission state lifted to
  // `MultiClientPermissionMediator` (constructed below). The bridge
  // keeps `entry.pendingPermissionIds: Set<string>` on each
  // SessionEntry as a fast cap-check index; the mediator is the
  // single source of truth for the actual pending registry and the
  // duplicate-vote LRU.

  // Validate the optional consensus quorum override defensively at
  // construction. The settings layer (Commit 5) is the primary
  // enforcement point, but the bridge also rejects malformed values
  // here so a buggy host wiring path can't NaN-poison the mediator.
  const permissionConsensusQuorum = opts.permissionConsensusQuorum;
  if (
    permissionConsensusQuorum !== undefined &&
    (!Number.isInteger(permissionConsensusQuorum) ||
      permissionConsensusQuorum < 1)
  ) {
    throw new Error(
      `BridgeOptions.permissionConsensusQuorum must be a positive integer; ` +
        `got ${String(permissionConsensusQuorum)}`,
    );
  }

  // Build the mediator before the BridgeClient so the agent's
  // `requestPermission` callback can hand the record straight in.
  // Audit publisher fallback: when the host doesn't supply one
  // (cli/serve/runQwenServe.ts wraps a real `PermissionAuditRing`
  // backed publisher in production), we use the canonical no-op
  // fallback so the mediator can still run for embedded callers /
  // tests without an audit consumer.
  const permissionAudit: PermissionAuditPublisher =
    opts.permissionAudit ?? createNoOpPermissionAuditPublisher();
  const permissionMediator = new MultiClientPermissionMediator(
    opts.permissionPolicy ?? 'first-responder',
    {
      emit: (sessionId, event) => {
        const sessionEntry = byId.get(sessionId);
        sessionEntry?.events.publish(event);
      },
      audit: permissionAudit,
      ...(permissionConsensusQuorum !== undefined
        ? { consensusQuorum: permissionConsensusQuorum }
        : {}),
      now: () => Date.now(),
      votersForSession: (sessionId) => {
        const sessionEntry = byId.get(sessionId);
        if (!sessionEntry) return new Set<string>();
        return new Set(sessionEntry.clientIds.keys());
      },
    },
  );
  // Set by `shutdown()` so any in-flight `spawnOrAttach` that was
  // dispatched on an existing connection AFTER the shutdown snapshot
  // taken in `shutdown()` fails fast instead of creating a child the
  // shutdown path has no more visibility into. Without this, the
  // server.listen → bridge.shutdown ordering in `runQwenServe` leaves
  // a window between (a) shutdown snapshotting `byId` for kills and
  // (b) `server.close` rejecting new connections, during which a
  // late-arriving `POST /session` slips a fresh child past cleanup.
  let shuttingDown = false;

  // Tee writeServeDebugLine through the optional onDiagnosticLine callback.
  // The module-level writeServeDebugLine is left intact for other entry points;
  // inside createHttpAcpBridge we use this wrapper exclusively.
  const teeServeDebugLine = (message: string): void => {
    writeServeDebugLine(message);
    if (opts.onDiagnosticLine && isServeDebugLoggingEnabled()) {
      opts.onDiagnosticLine(`qwen serve debug: ${message}`, 'info');
    }
  };

  // Coalesces concurrent `spawnOrAttach` calls under single-scope and
  // tracks in-progress thread-scope spawns for shutdown to await.
  // Single-scope uses the workspaceKey as the dedup key (at most one
  // entry; concurrent callers pass the `defaultEntry` check together
  // and coalesce here). Thread-scope uses `workspaceKey#uuid` so
  // simultaneous calls don't collide while still being awaitable from
  // `shutdown()`.
  const inFlightSpawns = new Map<string, Promise<BridgeSession>>();

  interface InFlightRestore {
    action: 'load' | 'resume';
    promise: Promise<BridgeRestoredSession>;
    /**
     * Synchronous reservation slot for callers that coalesce onto this
     * restore. Coalescers do `count++` BEFORE awaiting `promise` so the
     * spawn-owner's disconnect-reaper (`killSession({ requireZeroAttaches:
     * true })`) sees a non-zero `attachCount` on the freshly registered
     * entry and skips the kill. The IIFE folds this counter into
     * `entry.attachCount` when it calls `createSessionEntry`. BQ9tV
     * race-guard equivalent for coalesced restore waiters.
     */
    coalesceState: { count: number };
  }

  // Coalesces concurrent explicit restore calls for the same session id.
  // `session/load` replays history through SSE and `session/resume` restores
  // context; running either twice for the same id at the same time can
  // duplicate history frames or race two entries into `byId`.
  const inFlightRestores = new Map<string, InFlightRestore>();
  // `session/load` emits history replay as session_update notifications before
  // the ACP request returns. Keep a temporary bus so those replay frames land in
  // the ring, then promote the same bus into the registered SessionEntry.
  const pendingRestoreEvents = new Map<string, EventBus>();

  const createClientId = (): string => `client_${randomUUID()}`;

  const registerClient = (
    entry: SessionEntry,
    requestedClientId?: string,
  ): string => {
    if (requestedClientId && entry.clientIds.has(requestedClientId)) {
      entry.clientIds.set(
        requestedClientId,
        (entry.clientIds.get(requestedClientId) ?? 0) + 1,
      );
      return requestedClientId;
    }
    const clientId = createClientId();
    entry.clientIds.set(clientId, 1);
    return clientId;
  };

  const unregisterClient = (entry: SessionEntry, clientId?: string): void => {
    if (clientId === undefined) return;
    const count = entry.clientIds.get(clientId);
    if (count === undefined) return;
    if (count <= 1) {
      entry.clientIds.delete(clientId);
      // Drop the last-seen entry alongside the registration ref.
      // Otherwise a long-lived daemon servicing a churn of disconnect/
      // reconnect clients (each picking a fresh `clientId`) would
      // accumulate stale heartbeat timestamps for clients that no
      // longer exist — the very leak revocation policy (PR 24) is
      // meant to plug.
      entry.clientLastSeenAt.delete(clientId);
    } else {
      entry.clientIds.set(clientId, count - 1);
    }
  };

  const resolveTrustedClientId = (
    entry: SessionEntry,
    clientId?: string,
  ): string | undefined => {
    if (clientId === undefined) return undefined;
    if (!entry.clientIds.has(clientId)) {
      throw new InvalidClientIdError(entry.sessionId, clientId);
    }
    return clientId;
  };

  // Wenshao review #4335 / 3272493777 — `resolveAnyTrustedClientId`
  // helper removed alongside its sole call site in
  // `respondToPermission`. The function ranged across all live
  // sessions to validate a clientId, which created a cross-session
  // client-registration oracle when used in the unknown-requestId
  // path. The session-scoped `resolveTrustedClientId` (defined
  // above) is the correct primitive — it scopes to a single
  // session and is never called on the unknown-requestId path
  // after Round 7+8.

  // F3 Commit 3 — `registerPending` / `rollbackPending` /
  // `rememberResolvedPermission` / `publishPermissionAlreadyResolved`
  // / `resolvePending` were lifted into
  // `MultiClientPermissionMediator`. The mediator owns the pending
  // registry, the resolved-LRU, the per-session timer, and the
  // wire-event emit fan-out. The bridge talks to it through three
  // narrow surfaces: `mediator.request` (issue), `mediator.vote`
  // (resolve from a route), and `mediator.forgetSession` (cleanup
  // on session teardown).
  //
  /**
   * Get-or-create the daemon's single `qwen --acp` channel (#3803 §02).
   * N sessions multiplex onto it via `connection.newSession()`.
   * Concurrent callers coalesce through `inFlightChannelSpawn` so we
   * never spawn two children. The returned `ChannelInfo` is shared —
   * the caller adds their session id to `sessionIds` and uses
   * `info.connection.newSession()`.
   *
   * Wires up the one-and-only `channel.exited` cleanup on first
   * creation so the late-arriving event tears down ALL multiplexed
   * sessions.
   */
  async function ensureChannel(): Promise<ChannelInfo> {
    // Skip a channel that's marked dying — its underlying transport is
    // mid-SIGTERM-or-already-dead and `connection.newSession()` on it
    // would either hang or land the caller with a sessionId that
    // immediately 404s on every follow-up.
    if (channelInfo && !channelInfo.isDying) return channelInfo;
    if (inFlightChannelSpawn) return await inFlightChannelSpawn;

    const promise = (async () => {
      const channel = await telemetry.withSpan(
        'channel.spawn',
        {
          'qwen-code.daemon.bridge.operation': 'channel.spawn',
          'qwen-code.daemon.channel.reused': false,
        },
        async () => await channelFactory(boundWorkspace, childEnvOverrides),
      );
      const client = new BridgeClient(
        // BfFut: ACP today carries a sessionId on every per-session
        // notification / request, so the no-sessionId branch is
        // technically unreachable. But the channel is multi-session
        // (Stage 1.5 multiplex), so if ACP ever grows a no-sessionId
        // call we'd silently drop it on a multi-session channel
        // instead of throwing. Surface that ambiguity loudly.
        (sessionId) => {
          if (sessionId) return byId.get(sessionId);
          if (channelInfo && channelInfo.sessionIds.size > 1) {
            throw new Error(
              'BridgeClient: ACP call without sessionId on a ' +
                'multi-session channel cannot be routed — workspace=' +
                boundWorkspace,
            );
          }
          return undefined;
        },
        (sessionId) =>
          sessionId ? pendingRestoreEvents.get(sessionId) : undefined,
        permissionMediator,
        permissionTimeoutMs,
        maxPendingPerSession,
        // #4175 PR F1 step 5: forward the optional `BridgeFileSystem`
        // injection so production `qwen serve` can wire PR 18's
        // `WorkspaceFileSystem` adapter into BridgeClient's fs proxy
        // methods. Tests + Mode A consumers + channels / IDE companion
        // omit it; BridgeClient falls back to its inline fs proxy.
        opts.fileSystem,
      );
      const connection = new ClientSideConnection(() => client, channel.stream);

      // Add to `aliveChannels` + register the `channel.exited` handler
      // BEFORE the `initialize` handshake (tanzhenxin cold-spawn-window
      // finding): the agent child exists from the moment
      // `channelFactory(boundWorkspace)` returns, so a `killAllSync()`
      // during the handshake window (up to `initTimeoutMs`, default
      // 10s) must find it to avoid orphaning on `process.exit(1)`.
      // Init-failure / child-crash / late-shutdown all converge on
      // the same cleanup path via the handler below.
      // `channelInfo` (the attach target) is assigned only AFTER
      // initialize succeeds so callers don't attach to a still-
      // handshaking channel.
      const info: ChannelInfo = {
        channel,
        connection,
        client,
        sessionIds: new Set(),
        pendingRestoreIds: new Set(),
        isDying: false,
      };
      aliveChannels.add(info);
      // Belt-and-suspenders leak detection. The set is intentionally
      // multi-entry to cover the `killSession`-then-`spawnOrAttach`
      // overlap window (size 2 is legitimate: one dying + one fresh
      // attach-target). Anything higher implies a `channel.exited`
      // handler never fired for some prior channel — a real leak we'd
      // otherwise notice only as gradually-growing RSS over hours.
      // The warning surfaces it the moment it happens. Threshold is
      // 2 because that's the design ceiling; bumping it requires
      // updating both this guard and the comments around
      // `aliveChannels` declaration.
      if (aliveChannels.size > 2) {
        writeStderrLine(
          `qwen serve: WARNING aliveChannels.size=${aliveChannels.size} ` +
            `(expected 1, max 2 during killSession-then-spawnOrAttach ` +
            `overlap) — possible channel leak; check that prior channels' ` +
            `channel.exited fired and the handler ran cleanup.`,
        );
      }

      // One-time channel.exited cleanup. The child dying takes ALL
      // multiplexed sessions with it — iterate `sessionIds` (snapshot
      // first to be safe against concurrent killSession during
      // iteration), publish `session_died` on each session's bus,
      // remove from byId / defaultEntry / pending tables.
      //
      // Registered BEFORE the `initialize` await (tanzhenxin
      // cold-spawn-window fix above) so init-failure / child-crash /
      // late-shutdown all converge here. During handshake
      // `sessionIds` is empty — the loop below no-ops, the stderr
      // line still fires to tell operators "agent process gone
      // during init", and `aliveChannels.delete(info)` clears the
      // entry through the normal exit path.
      //
      // tanzhenxin BkUyD: drop from `aliveChannels` ONLY when the OS
      // process is actually gone. Async kill paths (`killSession`
      // reap, `shutdown()` await, `doSpawn`'s newSession-failure
      // tear-down) mark `isDying = true` but leave the entry in
      // `aliveChannels` until this handler fires, so the double-Ctrl+C
      // `killAllSync` force-kill path still has a reference to fire
      // SIGKILL against during the SIGTERM grace window — even if a
      // concurrent `spawnOrAttach` has already reassigned
      // `channelInfo` to a fresh channel.
      void channel.exited.then((exitInfo) => {
        aliveChannels.delete(info);
        if (channelInfo === info) channelInfo = undefined;
        const sessions = Array.from(info.sessionIds);
        info.sessionIds.clear();
        // Operator breadcrumb for UNEXPECTED channel exits. Without
        // this an agent crash (OOM / segfault) is invisible from the
        // daemon log: each affected SSE subscriber sees a
        // `session_died` frame and disconnects, the daemon's
        // child-stderr forwarder emits whatever the child wrote before
        // dying (often nothing on a SIGKILL / segfault), and operators
        // can't tell from `qwen serve`'s own output that the agent
        // process is gone.
        //
        // Suppressed during `shuttingDown` because the operator
        // already saw "received SIGINT, draining..." from
        // `runQwenServe`'s signal handler. The standalone
        // killSession case (last session leaves, channel torn down
        // but daemon stays up) still logs — there's no upstream
        // context line in that flow, and the message confirms the
        // cleanup actually ran.
        if (!shuttingDown) {
          telemetry.event('channel.exited', {
            'qwen-code.daemon.channel.exit_code': exitInfo?.exitCode ?? -1,
            'qwen-code.daemon.channel.session_count': sessions.length,
            ...(exitInfo?.signalCode
              ? { 'qwen-code.daemon.channel.signal': exitInfo.signalCode }
              : {}),
          });
          writeStderrLine(
            `qwen serve: channel exited (code=${exitInfo?.exitCode ?? 'none'}, signal=${exitInfo?.signalCode ?? 'none'}, ${sessions.length} session(s) torn down)`,
          );
        }
        for (const sid of sessions) {
          const sessEntry = byId.get(sid);
          if (!sessEntry) continue;
          cancelPendingForSession(sid);
          try {
            sessEntry.events.publish({
              type: 'session_died',
              data: {
                sessionId: sid,
                reason: 'channel_closed',
                // BX9_P: thread exitCode/signalCode through.
                exitCode: exitInfo?.exitCode ?? null,
                signalCode: exitInfo?.signalCode ?? null,
              },
            });
          } catch {
            /* bus already closed */
          }
          byId.delete(sid);
          // PR 14b fix (codex round 5): tombstone the id so any
          // late `extNotification` from the dying child can't leak
          // into the early-event buffer for a future load/resume of
          // the same persisted session id.
          info.client.markSessionClosed(sid);
          if (defaultEntry === sessEntry) defaultEntry = undefined;
          sessEntry.events.close();
        }
      });

      // Initialize handshake. The channel is already in
      // `aliveChannels` and the `channel.exited` handler above is
      // registered, so failure paths (init throw, timeout, late
      // shutdown) only need to mark dying + kill — the handler does
      // the alive-set cleanup when the OS reaps the child.
      try {
        await telemetry.withSpan(
          'channel.initialize',
          {
            'qwen-code.daemon.bridge.operation': 'channel.initialize',
          },
          async () =>
            await withTimeout(
              connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                  fs: { readTextFile: true, writeTextFile: true },
                },
                clientInfo: { name: 'qwen-serve-bridge', version: '0' },
              }),
              initTimeoutMs,
              'initialize',
            ),
        );
      } catch (err) {
        // Mark the half-initialized channel as dying/unavailable, then
        // kill it. Coalesced callers (`inFlightChannelSpawn` branch in
        // `ensureChannel`) observe the same rejection on this promise
        // and propagate it to their callers; the `inFlightSpawns`
        // tracker is cleared in `spawnOrAttach`'s finally so a follow-
        // up call retries cleanly. The `channel.exited` handler
        // registered earlier removes `info` from `aliveChannels` once
        // the OS reaps the child. `isDying` here is the cross-path
        // invariant marker (matches `killSession` / `doSpawn`-
        // newSession-failure / `shutdown`): "any channel in
        // `aliveChannels` with `isDying === true` is mid-teardown."
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw err;
      }

      // Late-shutdown re-check: if shutdown flipped during the
      // handshake, tear this channel down rather than leak past
      // `process.exit(0)`. Same cleanup pattern as the init-failure
      // path: mark dying + kill, let the exited handler reap.
      if (shuttingDown) {
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw new Error('HttpAcpBridge is shutting down');
      }

      // Handshake succeeded — now publish the channel as the
      // attach-available slot. `channelInfo` is assigned LAST so
      // `ensureChannel`'s fast-path (`if (channelInfo && !.isDying)`)
      // never returns a still-handshaking channel to a concurrent
      // caller.
      channelInfo = info;
      return info;
    })();

    inFlightChannelSpawn = promise;
    try {
      return await promise;
    } finally {
      inFlightChannelSpawn = undefined;
    }
  }

  async function doSpawn(
    modelServiceId: string | undefined,
    effectiveScope: 'single' | 'thread',
    requestedClientId?: string,
  ): Promise<BridgeSession> {
    // #3803 §02: get-or-create the daemon's single channel, then call
    // `connection.newSession()` on it. Sessions share the child's
    // process / OAuth / file-cache / hierarchy-memory parse via the
    // agent's `sessions: Map<string, Session>` (see
    // `acp-integration/acpAgent.ts:194`).
    //
    // newSession on an established channel can fail (auth, config,
    // etc.) without the channel dying. We DON'T kill the channel on
    // newSession failure when OTHER sessions are still using it —
    // they'd lose their work for a problem orthogonal to them.
    //
    // BkwQA: when the failed newSession was the channel's ONLY
    // attempt (sessionIds.size === 0), the empty channel must NOT
    // linger — it would stay set as `channelInfo` invisible to
    // `sessionCount` / `maxSessions` (both backed by `byId`), and
    // repeated failing creates would still find this channel via
    // `ensureChannel`, never spawning a fresh one. Tear down the
    // empty channel so the next attempt gets a clean spawn.
    const ci = await ensureChannel();
    let newSessionResp: { sessionId: string };
    try {
      newSessionResp = await telemetry.withSpan(
        'session.new',
        {
          'qwen-code.daemon.bridge.operation': 'session.new',
          'qwen-code.daemon.session_scope': effectiveScope,
        },
        async () =>
          await withTimeout(
            ci.connection.newSession({
              cwd: boundWorkspace,
              mcpServers: [],
            }),
            initTimeoutMs,
            'newSession',
          ),
      );
    } catch (err) {
      // Only reap when this newSession was the channel's first/only
      // attempt — a populated channel keeps running for its other
      // live sessions.
      if (ci.sessionIds.size === 0) {
        // Mark dying SYNCHRONOUSLY so a concurrent `spawnOrAttach`
        // calling `ensureChannel()` between this point and the
        // `channel.exited` cleanup spawns a fresh channel instead of
        // attaching to the one we're about to tear down. `channelInfo`
        // stays set until OS reap so `killAllSync` mid-SIGTERM still
        // finds a target (tanzhenxin BkUyD invariant).
        ci.isDying = true;
        await ci.channel.kill().catch(() => {
          /* best-effort — channel.exited handler still runs */
        });
      }
      throw err;
    }

    // Late-shutdown re-check (BUy4U): shutdown() may have flipped
    // while we were in `connection.newSession` (~1s on cold start).
    if (shuttingDown) {
      // Don't kill the channel — see comment above. Just throw.
      throw new Error('HttpAcpBridge is shutting down');
    }

    const entry = createSessionEntry(
      ci,
      newSessionResp.sessionId,
      boundWorkspace,
    );
    const clientId = registerClient(entry, requestedClientId);
    // `defaultEntry` is the single-scope attach target — only sessions
    // SPAWNED UNDER `'single'` may claim it. A thread-scope spawn must
    // never become the attach target, otherwise a later omitted-scope
    // (or daemon-default-`single`) caller would attach with
    // `attached: true` to what its sender promised was an isolated
    // session — see #4175 PR 5 (mixed-scope leak found in review).
    // Subsequent same-scope spawns also don't overwrite (first wins).
    if (effectiveScope === 'single' && !defaultEntry) defaultEntry = entry;

    // ACP `newSession` doesn't take a model id; honor the caller's
    // `modelServiceId` via `unstable_setSessionModel`. See
    // `applyModelServiceId` for rationale (race against
    // transportClosedReject, publish model_switched on success,
    // model_switch_failed on failure, don't tear down the session).
    if (modelServiceId) {
      await applyModelServiceId(
        entry,
        modelServiceId,
        initTimeoutMs,
        clientId,
      ).catch(() => {
        // Already published `model_switch_failed`; session stays
        // operational on the agent's default model.
      });
    }

    // Bd1zc: re-check that the entry is still live before returning.
    // The model-switch call yields and races against
    // `channel.exited` — if the child crashed during the model
    // switch, the exited handler already removed the entry from
    // byId. Without this check, the caller would get HTTP 200 with
    // a sessionId that already 404s on every subsequent request.
    if (!byId.has(entry.sessionId)) {
      throw new Error(
        `Session ${entry.sessionId} died during model-switch ` +
          `initialization`,
      );
    }

    return {
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      attached: false,
      clientId,
      createdAt: entry.createdAt,
    };
  }

  /**
   * Send `unstable_setSessionModel` and broadcast a `model_switched`
   * event. Used at create-session time (via doSpawn) AND on attach when
   * the caller passes a modelServiceId — the existing session may be
   * running a different model.
   *
   * Serialized through `entry.modelChangeQueue` so two concurrent
   * attach-with-different-model requests can't race into the agent.
   * On failure, publishes a `model_switch_failed` event for cross-client
   * observability and re-throws so the HTTP caller sees the error
   * (session keeps running its previous model — that's the safer
   * default than tearing down a shared session because one client
   * asked for an unknown model).
   */
  async function applyModelServiceId(
    entry: SessionEntry,
    modelId: string,
    timeoutMs: number,
    originatorClientId?: string,
  ): Promise<void> {
    const conn = entry.connection as unknown as {
      unstable_setSessionModel(p: {
        sessionId: string;
        modelId: string;
      }): Promise<unknown>;
    };
    // Race against `transportClosedReject` so a child crash during
    // model switch fails the call immediately instead of waiting the
    // full `timeoutMs`. Matches what `sendPrompt` and `setSessionModel`
    // already do — without this, a callback-attach with a broken model
    // wedges the HTTP handler for 10s.
    const transportClosed = getTransportClosedReject(entry);
    const work = entry.modelChangeQueue.then(async () => {
      // A1: mark a bridge-driven model roundtrip so the agent's
      // `current_model_update` extNotification (this path also drives
      // `Session.setModel`, which emits it) is suppressed by the demux —
      // the authoritative `model_switched` is published below.
      entry.modelRoundtripInFlight = true;
      try {
        await Promise.race([
          withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId,
            }),
            timeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]);
        entry.events.publish({
          type: 'model_switched',
          data: { sessionId: entry.sessionId, modelId },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch (err) {
        // Surface the failure to ALL attached clients, not just the
        // caller — a shared session swallowing a denied model change
        // silently would surprise the others.
        entry.events.publish({
          type: 'model_switch_failed',
          data: {
            sessionId: entry.sessionId,
            requestedModelId: modelId,
            error: err instanceof Error ? err.message : String(err),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      } finally {
        entry.modelRoundtripInFlight = false;
      }
    });
    // Tail swallows failures so subsequent model changes still run; the
    // original caller still observes the rejection on `work`.
    entry.modelChangeQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /**
   * Resolve every pending request belonging to one session as cancelled.
   *
   * **Scope contract (per ACP spec / live-collab default):**
   * Permissions are issued by the agent inline DURING an active
   * prompt — `requestPermission` returns a Promise the agent awaits
   * before continuing. Per the bridge's per-session FIFO + ACP's
   * "one active prompt per session" guarantee, ALL outstanding
   * permissions at any moment belong to the **currently active
   * prompt**. So "cancel all pending permissions for this session"
   * is equivalent to "cancel the active prompt's permissions" — and
   * that's exactly what ACP requires when a prompt is cancelled
   * ("cancelling a prompt MUST resolve outstanding requestPermission
   * calls with outcome.cancelled").
   *
   * **Multi-client live-collab caveat:** under `sessionScope: 'single'`
   * Client B may have been about to vote on A's pending permission
   * via SSE — when A disconnects mid-prompt, B's vote (if it arrives
   * after the abort) gets `404`. This is the right behavior: A's
   * prompt is being cancelled, so the permission belongs to a turn
   * that no longer matters. From B's side they see
   * `permission_resolved` with `outcome: cancelled` on the SSE
   * stream, then the prompt's `cancelled` stop reason. Voting on a
   * cancelled-prompt's permission was never going to drive the
   * agent forward anyway.
   */
  const cancelPendingForSession = (sessionId: string) => {
    // F3 N5 invariant — mediator first (it cancels each pending,
    // emits `permission_resolved`, writes audit, settles the
    // Promise), THEN clear the bridge's fast cap-check index.
    permissionMediator.forgetSession(sessionId);
    byId.get(sessionId)?.pendingPermissionIds.clear();
  };

  /**
   * Lazy-init the per-session `transportClosedReject` promise that
   * `sendPrompt` / `setSessionModel` / `applyModelServiceId` race their
   * ACP calls against. ONE listener is attached to `channel.exited`
   * over the session's lifetime (the first caller "wins" and creates
   * the promise; subsequent callers reuse it) — a per-call attach
   * would grow Node's listener list linearly with prompt count on
   * chatty sessions. The rejection message names the FIRST caller,
   * which can be misleading if a later method observes the failure;
   * the cost-benefit favors the single-listener invariant.
   */
  const getTransportClosedReject = (entry: SessionEntry): Promise<never> => {
    if (!entry.transportClosedReject) {
      entry.transportClosedReject = entry.channel.exited.then(() => {
        throw new BridgeChannelClosedError(
          `mid-request (session ${entry.sessionId})`,
        );
      });
    }
    return entry.transportClosedReject;
  };

  const resolveWorkspaceKey = (workspaceCwd: string): string => {
    if (!path.isAbsolute(workspaceCwd)) {
      throw new Error(
        `workspaceCwd must be an absolute path; got "${workspaceCwd}"`,
      );
    }
    const workspaceKey =
      workspaceCwd === boundWorkspace
        ? boundWorkspace
        : canonicalizeWorkspace(workspaceCwd);
    if (workspaceKey !== boundWorkspace) {
      throw new WorkspaceMismatchError(boundWorkspace, workspaceKey);
    }
    return workspaceKey;
  };

  const liveChannelInfo = (): ChannelInfo | undefined => {
    if (!channelInfo || channelInfo.isDying) return undefined;
    return channelInfo;
  };

  const channelInfoForEntry = (
    entry: SessionEntry,
  ): ChannelInfo | undefined => {
    if (channelInfo?.channel === entry.channel) return channelInfo;
    for (const info of aliveChannels) {
      if (info.channel === entry.channel) return info;
    }
    return undefined;
  };

  const getChannelClosedReject = (info: ChannelInfo): Promise<never> => {
    if (!info.statusClosedReject) {
      info.statusClosedReject = info.channel.exited.then(() => {
        throw new BridgeChannelClosedError('mid-request (workspace status)');
      });
    }
    return info.statusClosedReject;
  };

  const requestWorkspaceStatus = async <T>(
    method: string,
    idle: () => T,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    const info = liveChannelInfo();
    if (!info) return idle();
    const response = await withTimeout(
      Promise.race([
        info.connection.extMethod(method, { ...params, cwd: boundWorkspace }),
        getChannelClosedReject(info),
      ]),
      initTimeoutMs,
      method,
    );
    return response as unknown as T;
  };

  const requestSessionStatus = async <T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    const info = channelInfoForEntry(entry);
    if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
    const response = await Promise.race([
      withTimeout(
        entry.connection.extMethod(method, { ...params, sessionId }),
        initTimeoutMs,
        method,
      ),
      getTransportClosedReject(entry),
    ]);
    return response as unknown as T;
  };

  const notifyAgentSessionClose = async (
    entry: SessionEntry,
    ci: ChannelInfo | undefined,
    label: 'closeSession' | 'killSession',
  ): Promise<void> => {
    if (!ci || ci.channel !== entry.channel) return;
    try {
      await Promise.race([
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionClose, {
            sessionId: entry.sessionId,
          }),
          initTimeoutMs,
          SERVE_CONTROL_EXT_METHODS.sessionClose,
        ),
        getTransportClosedReject(entry),
      ]);
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${label} ACP session close notification failed ` +
          `for session ${JSON.stringify(entry.sessionId)}: ${String(
            err instanceof Error ? err.message : err,
          )}`,
      );
    }
  };

  /**
   * Fan-out an event to every live session bus. PR 17 mutation events
   * (`tool_toggled`, `workspace_initialized`, `mcp_server_restart*`,
   * persisted `approval_mode_changed` mirror) call this.
   *
   * Mirrors PR 16's `publishWorkspaceEvent` member: per-entry
   * success/failure accounting + an "ALL buses dropped" stderr
   * elevation so monitoring catches the all-closed-during-shutdown
   * scenario. Was a local swallow-and-skip until #4297 fold-in 1
   * picked up the suggestion to align with the instrumented path.
   *
   * Kept as a local closure rather than a member method because call
   * sites within the bridge implementation run inside the factory
   * scope where `this` is not yet the proxy.
   *
   * Optional `skipSessionId` — when set, that session is excluded
   * from the broadcast. Used by `setSessionApprovalMode` to avoid
   * delivering `approval_mode_changed` twice to the requesting
   * session (which already received the session-scoped publish on
   * its own bus). Without the skip, the SDK reducer's
   * `approvalModeChangedCount` reaches 2 for a single mutation on
   * the requesting client.
   */
  const broadcastWorkspaceEvent = (
    envelope: Omit<BridgeEvent, 'id' | 'v'>,
    skipSessionId?: string,
  ): void => {
    const sessions = Array.from(byId.values());
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;
    for (const entry of sessions) {
      if (skipSessionId !== undefined && entry.sessionId === skipSessionId) {
        skippedCount += 1;
        continue;
      }
      try {
        const published = entry.events.publish(envelope);
        if (published === undefined) {
          failureCount += 1;
          teeServeDebugLine(
            `broadcastWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed)`,
          );
        } else {
          successCount += 1;
        }
      } catch (err) {
        failureCount += 1;
        const detail =
          `broadcastWorkspaceEvent: bus publish failed for session ` +
          `${JSON.stringify(entry.sessionId)} (type=${envelope.type}): ` +
          `${err instanceof Error ? err.message : String(err)}`;
        if (shuttingDown) {
          teeServeDebugLine(detail);
        } else {
          writeStderrLine(`qwen serve: ${detail}`);
        }
      }
    }
    // Only elevate when the broadcast had at least one eligible
    // recipient (excluding the skipped requester) and ALL of them
    // dropped the event. Single-session workspaces with the requester
    // skipped naturally produce zero recipients — that's not an
    // "all dropped" condition, just nobody to deliver to.
    //
    // #4297 fold-in 6 (deepseek S1, addresses #3261079572): count the
    // sessions we actually skipped instead of unconditionally
    // subtracting 1 when `skipSessionId` is set. The previous shape
    // suppressed the all-dropped alarm when a non-matching
    // `skipSessionId` was passed (caller mistake, stale id, or the
    // matching session was just torn down) — eligible would land at
    // `sessions.length - 1` even though every session was published
    // to and every publish failed. Counting actual skips makes the
    // alarm condition self-consistent regardless of how the caller
    // mis-uses the param.
    const eligible = sessions.length - skippedCount;
    if (eligible > 0 && successCount === 0 && !shuttingDown) {
      writeStderrLine(
        `qwen serve: broadcastWorkspaceEvent type=${envelope.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`,
      );
    }
  };

  const createSessionEventBus = (): EventBus =>
    new EventBus(eventRingSize, undefined, new TurnBoundaryCompactionEngine());

  const createSessionEntry = (
    ci: ChannelInfo,
    sessionId: string,
    workspaceCwd: string,
    events = createSessionEventBus(),
  ): SessionEntry => {
    const entry: SessionEntry = {
      sessionId,
      workspaceCwd,
      createdAt: new Date().toISOString(),
      channel: ci.channel,
      connection: ci.connection,
      events,
      promptQueue: Promise.resolve(),
      modelChangeQueue: Promise.resolve(),
      approvalModeQueue: Promise.resolve(),
      pendingPermissionIds: new Set(),
      clientIds: new Map(),
      clientLastSeenAt: new Map(),
      attachCount: 0,
      spawnOwnerWantedKill: false,
    };
    ci.sessionIds.add(entry.sessionId);
    byId.set(entry.sessionId, entry);
    // PR 14b fix #1 (codex review round 1): drain any guardrail
    // events that fired during this session's `newSession` handler
    // (before this entry registered) onto the freshly-created
    // EventBus. Idempotent on unknown sessionIds.
    ci.client.drainEarlyEvents(entry.sessionId, entry);
    return entry;
  };

  const isAcpSessionResourceNotFound = (
    err: unknown,
    sessionId: string,
  ): boolean => {
    if (!err || typeof err !== 'object') return false;
    const maybe = err as {
      code?: unknown;
      data?: unknown;
      message?: unknown;
    };
    if (maybe.code !== -32002) return false;
    const expectedUri = `session:${sessionId}`;
    if (
      maybe.data &&
      typeof maybe.data === 'object' &&
      (maybe.data as { uri?: unknown }).uri === expectedUri
    ) {
      return true;
    }
    // Fallback for ACP servers that omit `data.uri` and embed the
    // URI in the human-readable message. Use exact equality on the
    // canonical "Resource not found: <uri>" form rather than
    // `includes(expectedUri)` — a substring match would cause a
    // sessionId of `"a"` to falsely match a message containing
    // `"session:abc"`.
    return (
      typeof maybe.message === 'string' &&
      maybe.message === `Resource not found: ${expectedUri}`
    );
  };

  const replayFieldsFor = (
    entry: { events: EventBus },
    action: 'load' | 'resume',
  ): Pick<
    BridgeRestoredSession,
    'compactedReplay' | 'liveJournal' | 'lastEventId'
  > => {
    const snapshot = entry.events.snapshotReplay();
    if (!snapshot) return { lastEventId: entry.events.lastEventId };
    if (action === 'load') {
      return {
        compactedReplay: snapshot.compactedTurns,
        liveJournal: snapshot.liveJournal,
        lastEventId: snapshot.lastEventId,
      };
    }
    return { lastEventId: snapshot.lastEventId };
  };

  async function restoreSession(
    action: 'load' | 'resume',
    req: BridgeRestoreSessionRequest,
  ): Promise<BridgeRestoredSession> {
    if (shuttingDown) {
      throw new Error('HttpAcpBridge is shutting down');
    }
    const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);

    const existing = byId.get(req.sessionId);
    if (existing) {
      existing.attachCount++;
      const clientId = registerClient(existing, req.clientId);
      return {
        sessionId: existing.sessionId,
        workspaceCwd: existing.workspaceCwd,
        attached: true,
        clientId,
        createdAt: existing.createdAt,
        // Late attachers get the same ACP state the original restore
        // caller saw; spawn-only sessions don't carry a state payload.
        state: existing.restoreState ?? {},
        ...replayFieldsFor(existing, action),
      };
    }

    const inFlight = inFlightRestores.get(req.sessionId);
    if (inFlight) {
      // Cross-action races BOTH ways must reject. A `resume` arriving
      // while a `load` is in flight cannot quietly coalesce: the load
      // is replaying full history through SSE on a shared EventBus,
      // and `DaemonSessionClient.resume()` seeds `lastEventId: 0`,
      // which means the resume client would receive every replayed
      // frame — directly violating resume's "no UI replay" contract.
      // The mirror direction (`load` onto `resume`) is rejected for
      // the same reason: a load caller expects history but resume
      // didn't replay any. Same-action coalescing is unaffected.
      if (action !== inFlight.action) {
        throw new RestoreInProgressError(
          req.sessionId,
          inFlight.action,
          action,
        );
      }
      // Reserve the attach SYNCHRONOUSLY before awaiting so the spawn
      // owner's `requireZeroAttaches` disconnect-reaper observes our
      // intent. The IIFE folds this counter into `entry.attachCount`
      // at `createSessionEntry` time.
      inFlight.coalesceState.count++;
      let restored: BridgeRestoredSession;
      try {
        restored = await inFlight.promise;
      } catch (err) {
        // Roll back our reservation so a subsequent retry isn't
        // permanently skewed if the in-flight restore failed.
        inFlight.coalesceState.count--;
        throw err;
      }
      const entry = byId.get(restored.sessionId);
      if (!entry) {
        // Restore owner's session got reaped before our await
        // resumed (channel died mid-microtask, etc). Roll back the
        // reservation too — there's no entry for it to live on.
        inFlight.coalesceState.count--;
        throw new SessionNotFoundError(
          restored.sessionId,
          'the agent child likely crashed during session restore — retry to restore the session',
        );
      }
      // NOTE: do NOT bump entry.attachCount here — `createSessionEntry`
      // already initialized it from coalesceState.count synchronously
      // when the IIFE registered the entry. Spread `restored` so the
      // ACP state propagates to coalesced waiters (BQ9tV-equivalent
      // for restore waiter consistency).
      return {
        ...restored,
        attached: true,
        clientId: registerClient(entry, req.clientId),
        createdAt: entry.createdAt,
      };
    }

    if (
      byId.size + inFlightSpawns.size + inFlightRestores.size >=
      maxSessions
    ) {
      throw new SessionLimitExceededError(maxSessions);
    }

    const restoreEvents = createSessionEventBus();
    let registeredEntry: SessionEntry | undefined;
    let ci: ChannelInfo | undefined;
    // Live counter shared with coalesced waiters (see InFlightRestore
    // doc comment). Mutated synchronously by the coalesce branch above
    // and read once by the IIFE when seeding `entry.attachCount`.
    const coalesceState = { count: 0 };
    const promise = (async (): Promise<BridgeRestoredSession> => {
      pendingRestoreEvents.set(req.sessionId, restoreEvents);
      ci = await ensureChannel();
      ci.pendingRestoreIds.add(req.sessionId);
      // PR 14b fix (codex round 6): mark this id as in-flight restore
      // BEFORE the ACP `loadSession`/`unstable_resumeSession` call.
      // Restore-time guardrail events arriving on the bridge during
      // that ACP call hit `bufferEarlyEvent` BEFORE the
      // post-restore `createSessionEntry → drainEarlyEvents` clears
      // the (close-window) tombstone, so without this allow-list the
      // tombstone would silently drop them. Cleared in the matching
      // `finally` below regardless of success / failure.
      ci.client.markRestoreInFlight(req.sessionId);
      // Restore is a low-frequency one-shot path, so we register a
      // fresh `channel.exited` listener per call instead of going
      // through `getTransportClosedReject` (which exists to keep
      // sendPrompt's per-session listener count at 1 over the
      // session's lifetime). The listener is bound to this restore's
      // race only — once the race settles, no new awaits attach to
      // it, so there's no listener leak across restores.
      const transportClosed = ci.channel.exited.then(() => {
        throw new BridgeChannelClosedError(`during session/${action}`);
      });
      // Suppress the dangling rejection if `withTimeout` wins the
      // race below: `transportClosed` then stays pending, and a
      // later `channel.exited` settle fires the inner `throw` with
      // no observer attached. Node 22 logs `unhandledRejection`;
      // under `--unhandled-rejections=throw` (common in container
      // deployments) the daemon process crashes. The `Promise.race`
      // path's own consumer below catches the rejection in the
      // try/catch, so the suppressed rejection here is the
      // race-loser case only.
      transportClosed.catch(() => {});
      let state: BridgeSessionState;
      try {
        if (action === 'load') {
          state = await Promise.race([
            withTimeout(
              ci.connection.loadSession({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                // Restore path drops per-request `mcpServers` (matches
                // `doSpawn`); daemon-wide MCP comes from settings on
                // the agent side. The SDK's `RestoreSessionRequest`
                // intentionally has no `mcpServers` field for the
                // same reason.
                mcpServers: [],
              }),
              initTimeoutMs,
              'loadSession',
            ),
            transportClosed,
          ]);
        } else {
          state = await Promise.race([
            withTimeout(
              ci.connection.unstable_resumeSession({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                mcpServers: [],
              }),
              initTimeoutMs,
              'resumeSession',
            ),
            transportClosed,
          ]);
        }
      } catch (err) {
        restoreEvents.close();
        if (isAcpSessionResourceNotFound(err, req.sessionId)) {
          throw new SessionNotFoundError(req.sessionId);
        }
        if (
          ci.sessionIds.size === 0 &&
          ci.pendingRestoreIds.size === 1 &&
          ci.pendingRestoreIds.has(req.sessionId)
        ) {
          ci.isDying = true;
          await ci.channel.kill().catch(() => {
            /* best-effort — channel.exited handler still runs */
          });
        }
        throw err;
      }

      if (shuttingDown) {
        restoreEvents.close();
        throw new Error('HttpAcpBridge is shutting down');
      }
      if (ci.isDying || !aliveChannels.has(ci)) {
        restoreEvents.close();
        throw new Error(
          `Session ${req.sessionId} restored on a closed agent channel`,
        );
      }
      const racedEntry = byId.get(req.sessionId);
      if (racedEntry) {
        restoreEvents.close();
        // Self + any coalescers we accumulated while the restore was
        // in flight. Coalescers must not bump attachCount themselves
        // (they read it off the registered entry on the next tick).
        racedEntry.attachCount += 1 + coalesceState.count;
        const clientId = registerClient(racedEntry, req.clientId);
        return {
          sessionId: racedEntry.sessionId,
          workspaceCwd: racedEntry.workspaceCwd,
          attached: true,
          clientId,
          createdAt: racedEntry.createdAt,
          state: racedEntry.restoreState ?? {},
          ...replayFieldsFor(racedEntry, action),
        };
      }

      const entry = createSessionEntry(
        ci,
        req.sessionId,
        workspaceKey,
        restoreEvents,
      );
      entry.restoreState = state;
      const clientId = registerClient(entry, req.clientId);
      // Fold synchronous coalesce reservations into the new entry's
      // `attachCount`. By this point all coalescers that beat us must
      // have hit the inFlightRestores branch and bumped
      // `coalesceState.count`; later coalescers will hit the byId
      // early-return path instead and increment `entry.attachCount`
      // directly.
      entry.attachCount = coalesceState.count;
      registeredEntry = entry;
      // Explicit `session/load` / `session/resume` is "give me THIS
      // id"; it must NOT become the implicit attach target for
      // subsequent omitted-id `POST /session` callers under `single`
      // scope. Those callers asked for "any default", and silently
      // joining a restored live history would surprise them.
      // `defaultEntry` is reserved for sessions created through
      // `doSpawn` under `'single'` scope.
      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        state,
        ...replayFieldsFor(entry, action),
      };
    })().finally(() => {
      ci?.pendingRestoreIds.delete(req.sessionId);
      // PR 14b fix (codex round 6): pair with `markRestoreInFlight`.
      // Once the IIFE settles, either `createSessionEntry` ran
      // (`drainEarlyEvents` already cleared the tombstone) or the
      // restore failed (handled below).
      ci?.client.clearRestoreInFlight(req.sessionId);
      pendingRestoreEvents.delete(req.sessionId);
      if (!registeredEntry) {
        restoreEvents.close();
        // PR 14b fix (codex round 7): on restore failure, purge any
        // guardrail events that the child buffered during this
        // restore window AND re-tombstone the id. Pre-fix the
        // round-6 allow-list (`markRestoreInFlight`) let
        // `bufferEarlyEvent` accept frames during the ACP call;
        // failure here only cleared the allow-list entry, leaving
        // queued frames in `earlyEvents`. A subsequent successful
        // `session/load`/`session/resume` for the same id within
        // 60s would then `drainEarlyEvents` those stale frames into
        // the new session — exactly the leak round 5's tombstone
        // was meant to prevent. `markSessionClosed` already does
        // both: refresh tombstone + delete `earlyEvents[id]`.
        ci?.client.markSessionClosed(req.sessionId);
      }
    });

    inFlightRestores.set(req.sessionId, { action, promise, coalesceState });
    try {
      return await promise;
    } finally {
      inFlightRestores.delete(req.sessionId);
    }
  }

  return {
    get sessionCount() {
      return byId.size;
    },

    get pendingPermissionCount() {
      return permissionMediator.pendingCount;
    },

    get permissionPolicy() {
      return permissionMediator.policy;
    },

    async loadSession(req) {
      return restoreSession('load', req);
    },

    async resumeSession(req) {
      return restoreSession('resume', req);
    },

    async spawnOrAttach(req) {
      if (shuttingDown) {
        // `runQwenServe.close()` calls `bridge.shutdown()` BEFORE
        // `server.close()`. During that window, established HTTP
        // connections can still hit `POST /session`. Refuse here so
        // late-arrivers don't spawn children the shutdown path won't
        // see — they'd otherwise leak past `process.exit(0)`.
        throw new Error('HttpAcpBridge is shutting down');
      }
      // Fast-path the common §02 case: clients pre-flight `caps.workspaceCwd`
      // and post back the exact same string, so the equality check
      // saves a `realpathSync.native` syscall per spawnOrAttach. The
      // omit-cwd path in `server.ts` also synthesizes `cwd =
      // boundWorkspace` before calling here, so it hits this branch
      // too. Falls through to the full canonicalize when the client
      // sent a non-canonical alias (`/work/./bound`, mixed casing on
      // case-insensitive FS, a symlinked aliased path, …) — that
      // still needs the realpath to compare correctly.
      const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);

      // Resolve the effective scope for THIS call. A per-request
      // `req.sessionScope` overrides the daemon-wide default; omitting
      // it falls back to `defaultSessionScope` so every existing caller
      // observes pre-#4175-PR-5 behavior bit-for-bit. The string-validation
      // happens here (rather than at the route layer alone) so direct
      // callers — tests, embeds, future entry points — can't bypass it.
      if (
        req.sessionScope !== undefined &&
        req.sessionScope !== 'single' &&
        req.sessionScope !== 'thread'
      ) {
        throw new InvalidSessionScopeError(req.sessionScope);
      }
      const effectiveScope = req.sessionScope ?? defaultSessionScope;

      if (effectiveScope === 'single') {
        const existing = defaultEntry;
        if (existing) {
          // BRSCi: bump attach counter BEFORE any await so the
          // spawn-owner's disconnect reaper (server.ts:
          // `requireZeroAttaches: true`) sees this attach even when
          // we yield on the model-switch below. Increment is
          // synchronous → atomic against the killSession
          // sync-prefix check.
          //
          // BVryk + BWGSL: counter is NOT strictly monotonic any
          // more — `detachClient()` decrements it to roll back an
          // attach whose HTTP response couldn't be written
          // (tanzhenxin issue 2). The race-guard invariant we still
          // hold is "attachCount reflects the number of attaching
          // clients whose response was written or is about to be
          // written"; decrementing is the symmetric cleanup for
          // attaches that turned out to be fictitious. The
          // ordering guarantee that matters for the killSession
          // race is "bump runs before any await inside this
          // microtask," which is what we get here.
          existing.attachCount++;
          const clientId = registerClient(existing, req.clientId);
          // If the caller passed a modelServiceId on attach, the session
          // may currently be running a DIFFERENT model. Honor the request
          // by issuing setSessionModel — same call we'd use on
          // /session/:id/model. Surfaces a `model_switched` event so
          // every attached client sees the change. If the new model is
          // rejected, propagate as a spawn-style error rather than
          // silently returning an attach-with-stale-model.
          if (req.modelServiceId) {
            // Swallow: matches the create-session catch in `doSpawn`
            // below — a model-switch rejection on an already-running
            // session must NOT 500 the attach (the session is fully
            // operational on its current model; tearing it down or
            // returning an error without the sessionId would deny
            // the caller any way to recover). The
            // `model_switch_failed` SSE event is the visible signal.
            await applyModelServiceId(
              existing,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            attached: true,
            clientId,
            createdAt: existing.createdAt,
          };
        }
        // Coalesce: if another caller is already mid-spawn for this same
        // workspace, await their result. The reporter's call appears as an
        // attach (the spawn was someone else's, not theirs). If the
        // reporter asked for a different modelServiceId than the spawn
        // chose, apply it now.
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          // BRSCi: bump attach counter SYNCHRONOUSLY in the same
          // microtask the in-flight spawn resolves to us, BEFORE
          // any further await. The spawn-owner's route handler
          // microtask (which calls `killSession({requireZeroAttaches})`)
          // runs after our spawnOrAttach() resolves; the ordering
          // guarantee is "every attach-bump runs before the
          // matching killSession sync prefix" only if the bump is
          // the first sync step after `await inFlight`. Doing the
          // model-switch await first re-opens the race deepseek-v4-pro
          // flagged in BRSCi.
          const attachedEntry = byId.get(session.sessionId);
          if (attachedEntry) attachedEntry.attachCount++;
          // BX9_U: even with the BRSCi bump-before-await ordering,
          // there are still adversarial paths where the entry could
          // be torn down between `await inFlight` resolving and our
          // continuation running (e.g. channel.exited firing during
          // a crash spawn, or a direct bridge.killSession call from
          // outside the route handler). In those cases byId.get()
          // returned undefined. Fail loud with a descriptive error
          // so the caller can distinguish "immediate agent death"
          // from a stale sessionId and retry into a fresh spawn.
          if (!attachedEntry) {
            throw new SessionNotFoundError(
              session.sessionId,
              'the agent child likely crashed during initialization — retry to spawn a new session',
            );
          }
          const clientId = registerClient(attachedEntry, req.clientId);
          if (req.modelServiceId) {
            // Same swallow as above — we picked up an in-flight
            // spawn, the session is real, model-switch failure
            // shouldn't deny us the sessionId.
            await applyModelServiceId(
              attachedEntry,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          return { ...session, attached: true, clientId };
        }
      }

      // Cap check: count both registered sessions and in-flight spawns
      // (a fresh-spawn races that's about to register hasn't hit
      // `byId` yet but should still count toward the limit). Attaches
      // returned above bypass this — only NEW children are gated.
      if (
        byId.size + inFlightSpawns.size + inFlightRestores.size >=
        maxSessions
      ) {
        throw new SessionLimitExceededError(maxSessions);
      }

      const promise = doSpawn(req.modelServiceId, effectiveScope, req.clientId);
      // Track in-flight spawns regardless of scope. Under `single`
      // this also serves the coalescing path above (a parallel
      // `spawnOrAttach` finds the entry and waits for the same
      // promise). Under `thread` we don't need coalescing — every
      // call gets its own session — but `shutdown()` snapshots
      // `inFlightSpawns.values()` to know which spawns to await
      // for graceful tear-down. Without this, a `thread`-scope
      // shutdown returns before in-progress spawns finish their
      // child cleanup, surfacing stderr noise after the daemon
      // claimed graceful shutdown. Use a unique key per spawn so
      // simultaneous thread-scope spawns don't collide on the
      // workspace key.
      const tracker =
        effectiveScope === 'single'
          ? workspaceKey
          : `${workspaceKey}#${randomUUID()}`;
      inFlightSpawns.set(tracker, promise);
      try {
        return await promise;
      } finally {
        // Always clear the in-flight slot whether the spawn resolved
        // or rejected — leaving a rejected promise behind would
        // poison every future coalescing-path call for this
        // workspace (single-scope) or grow unbounded (thread-scope).
        inFlightSpawns.delete(tracker);
      }
    },

    async sendPrompt(sessionId, req, signal, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge sendPrompt for session=${sessionId}`,
        'info',
      );
      const capturedContext = telemetry.captureContext();
      const queuedAt = Date.now();
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      // Pre-aborted: skip the queue entirely. Without this the prompt
      // chains onto promptQueue, waits its turn, and the FIFO worker
      // checks `signal.aborted` only AFTER reaching the head — wasted
      // queue churn on every retry-after-abort, plus a confusing trace
      // where the prompt appears to "run" before erroring.
      if (signal?.aborted) {
        throw new DOMException('Prompt aborted', 'AbortError');
      }
      // Force the body's sessionId to match the routing id — a client that
      // sent a stale id in the body would otherwise be dispatched to the
      // wrong agent process.
      const result = entry.promptQueue.then(() =>
        telemetry.runWithContext(
          capturedContext,
          async () =>
            await telemetry.withSpan(
              'prompt.dispatch',
              {
                'qwen-code.daemon.bridge.operation': 'prompt.dispatch',
                'session.id': sessionId,
                'qwen-code.daemon.prompt.queue_wait_ms': Date.now() - queuedAt,
                ...(context?.clientId
                  ? { 'qwen-code.client_id': context.clientId }
                  : {}),
              },
              async () => {
                const normalized: PromptRequest = telemetry.injectPromptContext(
                  {
                    ...req,
                    sessionId,
                  },
                );
                // If the caller aborted while we were queued behind earlier
                // prompts, don't even start this one.
                if (signal?.aborted) {
                  throw new DOMException('Prompt aborted', 'AbortError');
                }
                if (originatorClientId === undefined) {
                  delete entry.activePromptOriginatorClientId;
                } else {
                  entry.activePromptOriginatorClientId = originatorClientId;
                }
                // Echo the user prompt to the session bus so other SSE-subscribed
                // clients see the input alongside the agent response.
                //
                // The interactive prompt path was the only one not emitting
                // `user_message_chunk` — `Session#executePrompt` (the agent
                // side) forwards the prompt directly to the LLM; the cron path
                // (Session.ts:1402) and `HistoryReplayer` (line 65) emit it
                // explicitly. Without this echo, multi-client UIs only saw
                // assistant text from peer prompts — no record of who said what.
                //
                // Originator dedup: SDK consumers' `normalizeDaemonEvent` with
                // `suppressOwnUserEcho: true` filters the echo when
                // `event.originatorClientId === opts.clientId`. So the
                // originator's local UI doesn't double-render its own input.
                //
                // Multi-modal: one envelope per content block. Non-text blocks
                // pass through verbatim (the agent's Core multimodal echo is a
                // separate follow-up tracked in PR #4353 §D); for now the
                // common text path is the immediate fix.
                entry.cancelBroadcast = false;
                echoPromptToSessionBus(entry, normalized, originatorClientId);
                const promptPromise = entry.connection
                  .prompt(normalized)
                  .finally(() => {
                    delete entry.activePromptOriginatorClientId;
                  });

                // Race against channel termination: if the underlying transport
                // dies (child crashed, stream torn down) WHILE the prompt is in
                // flight, the SDK's pending-request promise can hang because the
                // wire never delivers a response. Make the prompt fail-fast in
                // that case so the per-session FIFO doesn't poison the next
                // queued prompt with an unbounded await. See
                // `getTransportClosedReject` for the single-listener invariant.
                //
                // FIXME(stage-2): no absolute prompt deadline. A buggy agent
                // that ignores `cancel()` while keeping the channel alive can
                // hold this race open indefinitely — the abort path fires
                // `cancel()` and resolves pending permissions, but the
                // `promptPromise` itself only settles when the agent
                // cooperates. Stage 2 should add a configurable per-prompt
                // wall clock (e.g. `--prompt-deadline 30m`) into this race so
                // a wedged agent can't slow-leak prompt promises. Tracked
                // under #3803 follow-ups.
                const racedPromise = Promise.race([
                  promptPromise,
                  getTransportClosedReject(entry),
                ]);

                // C3 (doudouOUC #4484 post-merge review): the user echo
                // (`echoPromptToSessionBus`) was already published BEFORE the
                // forward. If the forward itself fails (transport died, ACP child
                // error) and it wasn't a user-initiated cancel that already
                // broadcast, peers would be stuck having seen the echoed input with
                // no response and no terminal signal — permanent silence. Emit a
                // compensating `prompt_cancelled{reason:'forward_failed'}` so the
                // turn visibly ends. The `…Once` latch dedups against the abort
                // path (a normal cancel resolves rather than rejects, so this only
                // fires on genuine forward failures). Side-effect only — the
                // caller's `racedPromise` reference still surfaces the rejection.
                void racedPromise
                  .then(
                    () => {},
                    (err) => {
                      writeStderrLine(
                        `sendPrompt: forward failed for session ${sessionId}: ${
                          err instanceof Error ? err.message : String(err)
                        }`,
                      );
                      broadcastPromptCancelledOnce(
                        entry,
                        sessionId,
                        originatorClientId,
                        'forward_failed',
                      );
                      cancelPendingForSession(sessionId);
                      entry.connection.cancel({ sessionId }).catch(() => {});
                    },
                  )
                  .catch(() => {});

                if (!signal) return racedPromise;
                const onAbort = () => {
                  broadcastPromptCancelledOnce(
                    entry,
                    sessionId,
                    originatorClientId,
                  );
                  cancelPendingForSession(sessionId);
                  entry.connection.cancel({ sessionId }).catch(() => {});
                };
                if (signal.aborted) {
                  onAbort();
                } else {
                  signal.addEventListener('abort', onAbort, { once: true });
                  if (signal.aborted) onAbort();
                  racedPromise
                    .finally(() => signal.removeEventListener('abort', onAbort))
                    .catch(() => {});
                }
                return racedPromise;
              },
            ),
        ),
      );
      const promptId = context?.promptId;
      result.then(
        (promptResult) => {
          broadcastTurnComplete(
            entry,
            sessionId,
            promptResult,
            promptId,
            originatorClientId,
          );
        },
        (err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          broadcastTurnError(
            entry,
            sessionId,
            err,
            promptId,
            originatorClientId,
          );
        },
      );
      // Tail swallows failures so subsequent prompts still run. The caller
      // still sees rejections on its own `result` reference.
      entry.promptQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async cancelSession(sessionId, req, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge cancelSession for session=${sessionId}`,
        'info',
      );
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const cancelOriginatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      // Broadcast `prompt_cancelled` so other SSE-subscribed clients see
      // the cancel as a first-class event rather than inferring it from
      // the absence of further `agent_message_chunk` frames. Mirrors
      // `session_closed` — same audit gap (cross-client sync audit,
      // 2026-05-24). Published before the ACP cancel forward (see the
      // "cancel requested, not confirmed" semantic in
      // `broadcastPromptCancelled`).
      //
      // Unconditional by design: not gated on `activePromptOriginatorClientId`
      // because that field is only set when the active prompt carried an
      // originator — gating on it would drop the broadcast for anonymous
      // active prompts. A cancel against a genuinely idle session is a
      // harmless no-op that consumers treat idempotently.
      //
      // The pending-permission resolution below intentionally omits the
      // originator stamp (those resolutions are system-initiated, not
      // user-voted); this top-level `prompt_cancelled` carries the
      // cancelling client so peer UIs can attribute it.
      //
      // `…Once` (D2): dedups against the `sendPrompt` abort path so a
      // client that POSTs /cancel and then drops its socket doesn't emit
      // two `prompt_cancelled` frames for the same turn. The latch resets
      // at the next prompt start, so a later turn still broadcasts.
      broadcastPromptCancelledOnce(entry, sessionId, cancelOriginatorClientId);
      // ACP spec: cancelling a prompt MUST resolve outstanding
      // requestPermission calls with outcome.cancelled. Do this *before*
      // forwarding the notification so the agent's wind-down sees the
      // resolutions.
      cancelPendingForSession(sessionId);
      // Cancel intentionally bypasses the prompt queue: it's a notification
      // that the agent uses to wind down the *currently active* prompt, not
      // something to wait behind queued work.
      //
      // CONTRACT (multi-prompt clients): cancel affects ONLY the active
      // prompt. Any prompts the client previously POSTed and that are
      // still queued behind the active one will continue to execute
      // after the active prompt resolves with `stopReason: 'cancelled'`.
      // This matches ACP's "cancel is a wind-down notification for the
      // current turn" semantics — multi-prompt queueing is a daemon
      // convenience, not in spec, so we don't extend cancel's reach
      // there. Clients that want a hard stop should stop posting new
      // prompts and call `cancelSession` after their last prompt
      // resolves, or kill the session via the channel-exit path.
      const notif: CancelNotification = req
        ? { ...req, sessionId }
        : { sessionId };
      await telemetry.withSpan(
        'session.cancel',
        {
          'qwen-code.daemon.bridge.operation': 'session.cancel',
          'session.id': sessionId,
        },
        async () => {
          try {
            await entry.connection.cancel(notif);
          } catch (err) {
            if (isNotCurrentlyGeneratingCancelError(err)) return;
            throw err;
          }
        },
      );
    },

    subscribeEvents(sessionId, subOpts) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.subscribe(subOpts);
    },

    getSessionLastEventId(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.lastEventId;
    },

    respondToPermission(requestId, response, context) {
      // F3 Commit 3 — legacy workspace-level vote route. Look up the
      // session via mediator's resolved+pending peek, forward to
      // session-scoped handler if both ids agree.
      const sessionId = permissionMediator.peekSessionFor(requestId);
      // I4 (Commit 3 review) — also check `byId.has(sessionId)`. The
      // mediator's resolved LRU survives session teardown by design;
      // `respondToSessionPermission` would throw `SessionNotFoundError`
      // once `byId.delete(sessionId)` ran. Pre-F3 returned a clean
      // false → 404 for this case; preserve.
      if (sessionId === undefined || !byId.has(sessionId)) {
        // Wenshao review #4335 / 3272493777 — the PR #4231 security
        // boundary that previously called `resolveAnyTrustedClientId`
        // here was inverted: it returned 400 for unregistered
        // clientIds and 404 for registered ones, creating a
        // cross-session client-registration oracle. A remote prober
        // posting `POST /permission/<fabricated-id>` with various
        // X-Qwen-Client-Id headers could distinguish "this clientId
        // is registered in some active session" (404) from "not
        // registered anywhere" (400). The session-scoped route at
        // `respondToSessionPermission` already short-circuits to
        // `false` BEFORE clientId validation when the requestId is
        // unknown (Round 7 / 3271978329); applying the same
        // posture here closes the oracle on the legacy route.
        //
        // Wenshao review #4335 / 3273077256 — symmetric observability:
        // the session-scoped sibling writes an unconditional stderr
        // breadcrumb on its analogous unknown-requestId rejection
        // (Round 8 / 3272493792). Match that posture here so an
        // operator tailing daemon stderr sees both routes' 404s
        // without needing QWEN_SERVE_DEBUG=1.
        writeStderrLine(
          `qwen serve: legacy permission vote ${JSON.stringify(requestId)} ` +
            `has no live session (peek returned ${JSON.stringify(sessionId)}); ` +
            `returning 404.`,
        );
        return false;
      }
      return this.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        context,
      );
    },

    respondToSessionPermission(sessionId, requestId, response, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // C1 (Commit 3 review) — preserve pre-F3 cross-session reject
      // semantics: a vote whose requestId belongs to a DIFFERENT
      // session must return false (→ 404) WITHOUT validating
      // `context.clientId` against this session's registry.
      const actualSessionId = permissionMediator.peekSessionFor(requestId);
      if (actualSessionId !== undefined && actualSessionId !== sessionId) {
        teeServeDebugLine(
          `rejected permission vote ${JSON.stringify(requestId)} ` +
            `for session ${JSON.stringify(sessionId)}; request belongs to ` +
            `session ${JSON.stringify(actualSessionId)}.`,
        );
        return false;
      }
      // Wenshao review #4335 / 3271978329 (Critical) — error precedence:
      // when `peekSessionFor` returns `undefined` (timed out / LRU-
      // evicted / never registered), pre-F3 returned `false` (→ 404)
      // BEFORE any clientId validation. Without this explicit guard,
      // execution falls through to `resolveTrustedClientId` which
      // throws `InvalidClientIdError` (→ 400) when the caller's
      // `X-Qwen-Client-Id` isn't registered, leaking session-exists
      // information: a probe with a fabricated clientId could
      // distinguish "session exists with these clients" (400) from
      // "no such request" (404). Match pre-F3 by short-circuiting
      // here.
      //
      // Wenshao review #4335 / 3272493792 — observability: the
      // forbidden-vote paths in the mediator write unconditional
      // stderr breadcrumbs (`writeForbiddenStderr`), but this
      // security-sensitive guard previously logged only via the
      // debug-gated `writeServeDebugLine`. Promote to an
      // unconditional `writeStderrLine` so operators tailing
      // stderr at 3 AM can correlate unexpected 404s without
      // having to reboot with `QWEN_SERVE_DEBUG=1`.
      if (actualSessionId === undefined) {
        writeStderrLine(
          `qwen serve: rejected permission vote ${JSON.stringify(requestId)} ` +
            `for session ${JSON.stringify(sessionId)}; mediator has no ` +
            `pending or resolved record (unknown / timed out / LRU-evicted).`,
        );
        return false;
      }
      // requestId matches THIS session — only now validate clientId.
      // `resolveTrustedClientId` throws `InvalidClientIdError`
      // (mapped to 400 by the route) when the supplied id isn't in
      // `entry.clientIds`.
      const trustedClientId = resolveTrustedClientId(entry, context?.clientId);
      // F3 voter cancel sentinel: when the ACP body is
      // `{outcome: 'cancelled'}`, the wire frame doesn't carry an
      // `optionId`. Map it to the mediator-internal sentinel so
      // the mediator can resolve the pending as cancelled
      // regardless of the active policy.
      //
      // Wenshao review #4335 / 3271185588 (Critical) — the mediator
      // recognizes `CANCEL_VOTE_SENTINEL` BEFORE validating the
      // option against `allowedOptionIds`, so a wire client sending
      // `{outcome: 'selected', optionId: '__cancelled__'}` would
      // short-circuit all policy dispatch (designated originator
      // check / consensus quorum / local-only loopback gate). The
      // mediator's JSDoc warns that callers MUST NOT forward this
      // case from the wire; enforce the precondition here. The
      // collision-defense at request issue time
      // (`CancelSentinelCollisionError`) already prevents agents
      // from advertising the sentinel as an option, so this guard
      // closes the only remaining vector.
      if (
        response.outcome.outcome === 'selected' &&
        response.outcome.optionId === CANCEL_VOTE_SENTINEL
      ) {
        throw new InvalidPermissionOptionError(requestId, CANCEL_VOTE_SENTINEL);
      }
      const optionId =
        response.outcome.outcome === 'selected'
          ? response.outcome.optionId
          : CANCEL_VOTE_SENTINEL;
      const voterMetadata = extractPermissionResponseMetadata(response);
      const outcome = permissionMediator.vote({
        requestId,
        sessionId,
        clientId: trustedClientId,
        optionId,
        receivedAtMs: Date.now(),
        fromLoopback: context?.fromLoopback ?? false,
        ...(voterMetadata ? { metadata: voterMetadata } : {}),
      });
      switch (outcome.kind) {
        case 'resolved':
          return true;
        case 'recorded':
          // Consensus-policy intermediate vote.
          return true;
        case 'already_resolved':
          // Mediator already emitted `permission_already_resolved`.
          return false;
        case 'unknown_request':
          teeServeDebugLine(
            `rejected permission vote ${JSON.stringify(requestId)} ` +
              `for session ${JSON.stringify(sessionId)}; mediator has no ` +
              `pending or resolved record.`,
          );
          return false;
        case 'forbidden':
          throw new PermissionForbiddenError(
            requestId,
            sessionId,
            outcome.reason,
          );
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unreachable PermissionVoteOutcome: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    },

    async closeSession(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      let originatorClientId: string | undefined;
      if (context?.clientId !== undefined) {
        originatorClientId = resolveTrustedClientId(entry, context.clientId);
      }
      writeStderrLine(
        `qwen serve: closing session ${JSON.stringify(sessionId)}` +
          (originatorClientId
            ? ` by client ${JSON.stringify(originatorClientId)}`
            : ''),
      );
      telemetry.event('session.close', {
        'qwen-code.daemon.bridge.operation': 'session.close',
        'session.id': sessionId,
      });
      if (defaultEntry === entry) defaultEntry = undefined;
      // #4325 fix: resolve the channel via `channelInfoForEntry(entry)`
      // (search `aliveChannels` for the entry's actual channel) instead
      // of the module-scoped `channelInfo` (the CURRENT attach target).
      // The two diverge during the channel-overlap window — A dying,
      // B freshly spawned as `channelInfo` — where capturing
      // `channelInfo` would (1) skip the `sessionIds.delete()` since
      // `B.channel !== entry.channel`, leaving A's `sessionIds` set
      // pinned past the close, and (2) call `markSessionClosed` on
      // **B**'s client instead of **A**'s, evaluating B's kill
      // condition with stale assumptions about its session count.
      // Other session methods in this file already use the helper
      // (`setSessionApprovalMode`, `requestSessionStatus`); this
      // brings closeSession in line.
      //
      // HAZARD(#4325): the regression test for this fix
      // (`httpAcpBridge.test.ts` ~L6421) is single-channel smoke ONLY —
      // a revert that reintroduces the module-scoped `channelInfo`
      // capture WILL NOT fail any existing test, because the
      // overlap-race state isn't deterministically constructable
      // without factory-internal hooks. Code-review-time visibility
      // of the `channelInfoForEntry(entry)` call here is the primary
      // defense against accidental revert. Don't refactor away the
      // helper call without first landing the deterministic overlap
      // test (deferred follow-up).
      const ci = channelInfoForEntry(entry);
      if (!ci) {
        // Diagnostic visibility (#4334 wenshao review DWrbr): when the
        // entry's channel has already been torn down out-of-band, the
        // cleanup branches below all short-circuit silently. The
        // "closing session" log at the top of this method fires
        // regardless, so the close *call* is visible — but the fact
        // that channel-side bookkeeping was skipped is not. Sibling
        // methods (e.g. `requestSessionStatus`) surface this as
        // `SessionNotFoundError`; `closeSession` is intentionally
        // idempotent so we just log instead of throwing.
        writeStderrLine(
          `qwen serve: closeSession channelInfoForEntry returned undefined ` +
            `for session ${JSON.stringify(sessionId)} — channel cleanup skipped (entry's channel already torn down)`,
        );
      }
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      await notifyAgentSessionClose(entry, ci, 'closeSession');
      // F3 Commit 3 — mediator-driven cancel cascade replaces the
      // pre-F3 per-id resolvePending loop. Same effect (each pending
      // settles as cancelled, SSE permission_resolved emits, audit
      // records); state lives in the mediator now.
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      byId.delete(sessionId);
      // PR 14b fix (codex round 5): tombstone the closed sessionId
      // so any late `extNotification` from the (now-defunct) child
      // can't seed the early-event buffer and leak into a future
      // load/resume of the same persisted id.
      ci?.client.markSessionClosed(sessionId);
      try {
        entry.events.publish({
          type: 'session_closed',
          data: {
            sessionId,
            reason: 'client_close',
            // `data.closedBy` is kept for back-compat with existing
            // wire consumers; new code should read envelope-level
            // `originatorClientId` (matches `session_metadata_updated`,
            // `model_switched`, `approval_mode_changed`, etc.).
            ...(originatorClientId ? { closedBy: originatorClientId } : {}),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch {
        /* bus already closed */
      }
      // `session_closed` is terminal. Close the bus before ACP cancel so any
      // late cancellation frames from the agent are intentionally dropped.
      entry.events.close();
      try {
        await telemetry.withSpan(
          'session.close.cancel_active_prompt',
          {
            'qwen-code.daemon.bridge.operation':
              'session.close.cancel_active_prompt',
            'session.id': sessionId,
          },
          async () => await entry.connection.cancel({ sessionId }),
        );
      } catch {
        /* no active prompt or session already torn down */
      }
      if (ci && ci.sessionIds.size === 0 && ci.pendingRestoreIds.size === 0) {
        ci.isDying = true;
        await ci.channel.kill().catch((err) => {
          writeStderrLine(
            `qwen serve: closeSession channel kill failed for session ` +
              `${JSON.stringify(sessionId)}: ${String(err)}`,
          );
        });
      }
    },

    updateSessionMetadata(sessionId, metadata, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Capture the trusted originator so the broadcast envelope can
      // attribute the change to a specific client (parity with
      // `model_switched`, `approval_mode_changed`, etc., which stamp
      // envelope-level `originatorClientId`). Prior to this, the
      // metadata broadcast had no originator stamp at all — UIs
      // couldn't tell which client renamed the session.
      const metadataOriginatorClientId =
        context?.clientId !== undefined
          ? resolveTrustedClientId(entry, context.clientId)
          : undefined;
      if (metadata.displayName !== undefined) {
        if (
          typeof metadata.displayName !== 'string' ||
          metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH
        ) {
          throw new InvalidSessionMetadataError(
            'displayName',
            `must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
          );
        }
        if (hasControlCharacter(metadata.displayName)) {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must not contain control characters',
          );
        }
        const nextDisplayName = metadata.displayName || undefined;
        if (entry.displayName !== nextDisplayName) {
          entry.displayName = nextDisplayName;
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} ` +
              `displayName=${entry.displayName === undefined ? 'cleared' : 'set'}` +
              (context?.clientId
                ? ` by client ${JSON.stringify(context.clientId)}`
                : ''),
          );
          try {
            entry.events.publish({
              type: 'session_metadata_updated',
              data: { sessionId, displayName: entry.displayName },
              ...(metadataOriginatorClientId
                ? { originatorClientId: metadataOriginatorClientId }
                : {}),
            });
          } catch {
            /* bus already closed */
          }
        }
      }
      return { displayName: entry.displayName };
    },

    listWorkspaceSessions(workspaceCwd) {
      if (!path.isAbsolute(workspaceCwd)) return [];
      const key =
        workspaceCwd === boundWorkspace
          ? boundWorkspace
          : canonicalizeWorkspace(workspaceCwd);
      if (key !== boundWorkspace) return [];
      const out: BridgeSessionSummary[] = [];
      for (const entry of byId.values()) {
        if (entry.workspaceCwd === key) {
          out.push({
            sessionId: entry.sessionId,
            workspaceCwd: entry.workspaceCwd,
            createdAt: entry.createdAt,
            displayName: entry.displayName,
            clientCount: entry.clientIds.size,
            hasActivePrompt: entry.activePromptOriginatorClientId !== undefined,
          });
        }
      }
      return out;
    },

    recordHeartbeat(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Validate the optional client id BEFORE bumping any timestamp so
      // an unknown client doesn't get to advance the per-session
      // watermark — that would let an attacker with a valid bearer
      // token mask client absence by spamming heartbeats with random
      // ids. `resolveTrustedClientId` throws `InvalidClientIdError`,
      // which the route layer maps to `400 invalid_client_id`.
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const lastSeenAt = Date.now();
      entry.sessionLastSeenAt = lastSeenAt;
      if (clientId !== undefined) {
        entry.clientLastSeenAt.set(clientId, lastSeenAt);
      }
      return {
        sessionId: entry.sessionId,
        ...(clientId !== undefined ? { clientId } : {}),
        lastSeenAt,
      };
    },

    getHeartbeatState(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) return undefined;
      // Snapshot the client map so callers can't mutate the live one;
      // `sessionLastSeenAt` is undefined for sessions that have never
      // received a heartbeat (the typical state right after spawn).
      return {
        ...(entry.sessionLastSeenAt !== undefined
          ? { sessionLastSeenAt: entry.sessionLastSeenAt }
          : {}),
        clientLastSeenAt: new Map(entry.clientLastSeenAt),
      };
    },

    publishWorkspaceEvent(event) {
      // Issue #4175 PR 16. Workspace-level mutations (memory writes /
      // agent CRUD) need a fan-out path that doesn't require a session
      // id. Iterate every live session's bus best-effort — a closed bus
      // (mid-shutdown, or evicted under load) is silently skipped, same
      // posture as the `permission_resolved` publish inside
      // `resolvePending`.
      //
      // The route handler's contract is "read-after-write" and any SSE
      // subscriber that misses the event can re-fetch via the route's
      // GET sibling. Stage 5 PR 24 PermissionMediator can layer a
      // proper workspace event bus on top if adapters need stricter
      // delivery semantics.
      //
      // Per-entry exceptions go to stderr in normal operation, but
      // are downgraded to the debug channel when `shuttingDown` is
      // true. `EventBus.publish` is documented never to throw (BX9_p
      // contract at eventBus.ts:186), so anything landing here in
      // normal ops is by definition unexpected — silencing it via
      // QWEN_SERVE_DEBUG would let a true regression succeed at the
      // route layer (200 OK) while SSE subscribers stop seeing
      // events. The shutdown gate keeps the common race noise out of
      // the production log without hiding actual bugs.
      //
      // PR #4255 fold-in 9: track per-session success/fail. A
      // closed-bus return (`undefined` from `EventBus.publish` —
      // see eventBus.ts:195-207) counts as a failure (operator
      // signal), distinct from a thrown exception (regression
      // signal). When zero sessions are active OR every active bus
      // dropped the event, we elevate to unconditional stderr so
      // monitoring catches the all-buses-dropped scenario.
      // Two near-duplicate fan-outs coexist in this file:
      //   - this `publishWorkspaceEvent` member (PR 16) — used by
      //     workspace-mutation routes that have a bridge proxy
      //     reference (memory / agents).
      //   - the local `broadcastWorkspaceEvent` closure declared above
      //     in this factory body (PR 17 mutation surface) — used by
      //     `setSessionApprovalMode`
      //     / `setWorkspaceToolEnabled` / `restartMcpServer` / `initWorkspace`
      //     because their call sites run inside the factory closure
      //     where `this` isn't yet the proxy. The closure also takes
      //     an optional `skipSessionId` for the persisted approval-mode
      //     mirror; this member doesn't.
      // The duplication is acknowledged debt — addressed in #4297
      // fold-in 11 (#3263954688). A future refactor can extract a
      // shared `fanOutToSessions(envelope, sessions, opts?)` helper
      // once the `skipSessionId` semantics stabilize.
      const sessions = Array.from(byId.values());
      let successCount = 0;
      let failureCount = 0;
      for (const entry of sessions) {
        try {
          const published = entry.events.publish(event);
          if (published === undefined) {
            failureCount += 1;
            teeServeDebugLine(
              `publishWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed)`,
            );
          } else {
            successCount += 1;
          }
        } catch (err) {
          failureCount += 1;
          const detail =
            `publishWorkspaceEvent: bus publish failed for session ` +
            `${JSON.stringify(entry.sessionId)} (type=${event.type}): ` +
            `${err instanceof Error ? err.message : String(err)}`;
          if (shuttingDown) {
            teeServeDebugLine(detail);
          } else {
            writeStderrLine(`qwen serve: ${detail}`);
          }
        }
      }
      if (sessions.length > 0 && successCount === 0 && !shuttingDown) {
        writeStderrLine(
          `qwen serve: publishWorkspaceEvent type=${event.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`,
        );
      }
    },

    knownClientIds() {
      // Snapshot the union of every live session's stamped client ids.
      // Returned as a fresh Set so callers can mutate-safely (the live
      // per-session maps stay private). Workspace-level mutation routes
      // use this to validate `X-Qwen-Client-Id` without owning a
      // session id; PR 24 will replace it with a workspace-scoped
      // registry that doesn't conflate session-attach with workspace-
      // attach.
      const out = new Set<string>();
      for (const entry of byId.values()) {
        for (const id of entry.clientIds.keys()) out.add(id);
      }
      return out;
    },

    async getWorkspaceMcpStatus() {
      return requestWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceMcp, () =>
        createIdleWorkspaceMcpStatus(boundWorkspace),
      );
    },

    async getWorkspaceMcpToolsStatus(serverName) {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcpTools,
        () => ({
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd: boundWorkspace,
          serverName,
          initialized: false,
          acpChannelLive: false,
          tools: [],
          errors: [
            {
              kind: 'mcp_tools',
              status: 'not_started' as const,
              hint: 'spawn a session to populate',
            },
          ],
        }),
        { serverName },
      );
    },

    async getWorkspaceSkillsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace),
      );
    },

    async getWorkspaceToolsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceTools,
        () => ({
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd: boundWorkspace,
          initialized: true as const,
          acpChannelLive: false,
          tools: [],
          errors: [
            {
              kind: 'tools',
              status: 'not_started' as const,
              hint: 'spawn a session to populate',
            },
          ],
        }),
      );
    },

    async getWorkspaceProvidersStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace),
      );
    },

    async getWorkspaceEnvStatus() {
      const acpChannelLive = !!liveChannelInfo();
      // PR 22b/2: daemon-host env snapshot delegated to
      // `BridgeOptions.statusProvider`. When omitted (Mode A in-process
      // consumers, tests) the bridge returns an idle envelope —
      // matches the "queryable but empty" pattern PR 12 / 13
      // established for diagnostic routes.
      //
      // Wenshao review fold-in (#4304): a custom provider that throws
      // would otherwise propagate past the bridge into `/workspace/env`
      // as a 500. Catch + log + fall back to the idle envelope so the
      // route still responds — the `daemon cells always answerable`
      // invariant the pre-injection `buildEnvStatusFromProcess` carried
      // (it never threw because it was synchronous and self-contained)
      // is preserved structurally.
      if (!opts.statusProvider) {
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
      try {
        return await opts.statusProvider.getEnvStatus(
          boundWorkspace,
          acpChannelLive,
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: statusProvider.getEnvStatus failed; ` +
            `falling back to idle envelope: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
    },

    async getWorkspacePreflightStatus() {
      // PR 22b/2: daemon-host preflight cells delegated to
      // `BridgeOptions.statusProvider`. Without a provider the daemon
      // half is empty `[]`; ACP-side cells are still fetched normally
      // when a child is live.
      //
      // Wenshao review fold-in (#4304): a throwing provider would
      // otherwise propagate past the bridge and turn the entire
      // preflight envelope into a 500 — losing both daemon cells AND
      // the ACP-side cells fetched below. Catch + log + fall back to
      // empty so ACP cells still render. Pre-injection
      // `buildDaemonPreflightCells` used `Promise.allSettled` and was
      // effectively unthrowable; this preserves that route-level
      // invariant for custom provider impls that may throw.
      let daemonCells: ServePreflightCell[];
      if (!opts.statusProvider) {
        // Asymmetric vs `getWorkspaceEnvStatus` (which falls back to a
        // full `createIdleEnvStatus` envelope): preflight is the union
        // of daemon-locality + ACP-locality cells stitched below, so an
        // empty daemon slice IS the right fallback — the ACP slice
        // fills in independently from the live channel (or its
        // `not_started` placeholders).
        daemonCells = [];
      } else {
        try {
          daemonCells =
            await opts.statusProvider.getDaemonPreflightCells(boundWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: statusProvider.getDaemonPreflightCells failed; ` +
              `falling back to empty daemon cells: ` +
              (err instanceof Error ? err.message : String(err)),
          );
          daemonCells = [];
        }
      }
      const acpChannelLive = !!liveChannelInfo();

      let acpResponse:
        | { cells: ServePreflightCell[]; errors?: ServeStatusCell[] }
        | undefined;
      let envelopeError: ServeStatusCell | undefined;
      try {
        acpResponse = await requestWorkspaceStatus(
          SERVE_STATUS_EXT_METHODS.workspacePreflight,
          () => ({ cells: createIdleAcpPreflightCells() }),
        );
      } catch (err) {
        // Bridge-side timeout / channel close while consulting ACP. Daemon
        // cells still render; envelope-level error tells the client which
        // surface failed without sinking the whole route.
        const errorKind = mapDomainErrorToErrorKind(err);
        envelopeError = {
          kind: 'preflight',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          ...(errorKind ? { errorKind } : {}),
        };
        acpResponse = { cells: createIdleAcpPreflightCells() };
      }

      const errors: ServeStatusCell[] = [
        ...(acpResponse.errors ?? []),
        ...(envelopeError ? [envelopeError] : []),
      ];

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true as const,
        acpChannelLive,
        cells: [...daemonCells, ...acpResponse.cells],
        ...(errors.length > 0 ? { errors } : {}),
      };
    },

    async getSessionContextStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext,
      );
    },

    async getSessionContextUsageStatus(sessionId, opts) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContextUsage,
        { detail: opts?.detail === true },
      );
    },

    async getSessionSupportedCommandsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionSupportedCommands,
      );
    },

    async getSessionTasksStatus(sessionId) {
      return requestSessionStatus<ServeSessionTasksStatus>(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionTasks,
      );
    },

    async setSessionModel(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      const normalized: SetSessionModelRequest = { ...req, sessionId };
      // The ACP SDK marks setSessionModel as unstable (not in spec yet); the
      // method on AgentSideConnection is `unstable_setSessionModel`. Cast
      // through the shape we know rather than couple to the prefix in case
      // it's renamed when the spec stabilizes.
      const conn = entry.connection as unknown as {
        unstable_setSessionModel(
          p: SetSessionModelRequest,
        ): Promise<SetSessionModelResponse>;
      };
      // Serialize through `entry.modelChangeQueue` so a `POST /session/:id/model`
      // can't race with `applyModelServiceId` (e.g. an attach-with-different-
      // modelServiceId) and leave the agent connection in an indeterminate
      // model. `applyModelServiceId` already chains on this queue; without
      // mirroring that here, two concurrent model changes interleave and the
      // last `model_switched` event published may not match the actual model
      // the agent is on.
      //
      // Race the agent call against `transportClosedReject` and a
      // `withTimeout` so a wedged child can't block the HTTP handler
      // forever. Matches `sendPrompt` (transport race) and
      // `applyModelServiceId` (timeout) — the absence of either was an
      // attack surface for "POST /session/:id/model never returns".
      // See `getTransportClosedReject` for the single-listener invariant.
      //
      // FIXME(stage-2): we reuse `initTimeoutMs` (default 10s) as the
      // model-switch deadline because the two values happen to share
      // a sensible order of magnitude today. They're conceptually
      // distinct (cold-start handshake vs in-flight model swap) and
      // a Stage 2 split into `modelSwitchTimeoutMs` would let
      // operators tune them independently — also a good time to
      // remove the no-abort behavior of `withTimeout` (it rejects
      // the promise but leaves the underlying ACP call running, so a
      // late-arriving `model_switched` can race a previously-fired
      // `model_switch_failed`). Both depend on ACP exposing a cancel
      // signal for `unstable_setSessionModel`.
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(async () => {
        // A1: suppress the agent's current_model_update notification (this
        // path drives Session.setModel, which emits it) while the bridge
        // owns the change. Publish the authoritative model_switched INSIDE
        // this callback — i.e. while the flag is still true — mirroring
        // `applyModelServiceId`, so the agent notification can never slip
        // through after the flag clears even if transport ordering changes.
        entry.modelRoundtripInFlight = true;
        try {
          const result = await Promise.race([
            withTimeout(
              conn.unstable_setSessionModel(normalized),
              initTimeoutMs,
              'setSessionModel',
            ),
            transportClosed,
          ]);
          entry.events.publish({
            type: 'model_switched',
            data: { sessionId: entry.sessionId, modelId: req.modelId },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
          return result;
        } finally {
          entry.modelRoundtripInFlight = false;
        }
      });
      // Tail-swallow on the queue so a model-change failure doesn't poison
      // every subsequent change (matches `applyModelServiceId`'s pattern).
      entry.modelChangeQueue = work.then(
        () => undefined,
        () => undefined,
      );
      let response: SetSessionModelResponse;
      try {
        response = await work;
      } catch (err) {
        // Mirror `applyModelServiceId`'s observability contract: surface
        // failed model changes on the SSE bus so subscribers can update
        // their UI / retry. Without this the only signal is the HTTP
        // 5xx, which doesn't reach passive viewers.
        try {
          entry.events.publish({
            type: 'model_switch_failed',
            data: {
              sessionId: entry.sessionId,
              requestedModelId: req.modelId,
              error: err instanceof Error ? err.message : String(err),
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        } catch {
          /* bus closed */
        }
        throw err;
      }
      // model_switched is published inside the work callback above (while the
      // suppress flag is still set), mirroring applyModelServiceId.
      return response;
    },

    async setSessionApprovalMode(sessionId, mode, opts, context) {
      // #4175 Wave 4 PR 17. Forwards through `qwen/control/session/
      // approval_mode` so the change lands inside the ACP child's own
      // `Config` (per-session `setApprovalMode`). The bridge layer adds
      // two things on top: trusted `originatorClientId` resolution and
      // an opt-in persist hook that writes `tools.approvalMode` to the
      // workspace settings file. Persist is OFF by default — see the
      // interface doc for the reasoning.
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      // #4282 fold-in 4 (qwen-latest C1): validate the persist contract
      // BEFORE the ACP roundtrip changes the in-process mode. The previous
      // post-call placement meant a missing `persistApprovalMode` callback
      // produced a 500 *after* the ACP child had already applied the
      // mode change — observable to other in-flight requests but
      // invisible to the caller. Mirrors the pre-call validation in
      // `setWorkspaceToolEnabled`.
      if (opts.persist && !persistApprovalMode) {
        throw new Error(
          'setSessionApprovalMode called with `persist: true` but no ' +
            '`persistApprovalMode` callback wired in BridgeOptions. ' +
            'runQwenServe wires the production callback; direct embeds ' +
            'and tests must opt in or omit `persist`.',
        );
      }
      // Serialize the WHOLE change — ACP roundtrip + persist + publish — through
      // `entry.approvalModeQueue` (A3). Covering only the `extMethod` call (the
      // earlier shape) left persist+publish OUTSIDE the queue: two concurrent
      // `persist:true` calls could interleave their persist phases and publish
      // out of order, so the bus's last `approval_mode_changed` disagreed with
      // the mode the ACP child actually settled on. Keeping persist+publish in
      // the queued work means the next change can't start its `extMethod` until
      // this change's side effects are fully done. Mirrors `modelChangeQueue`.
      const approvalWork = entry.approvalModeQueue.then(async () => {
        const response = (await Promise.race([
          withTimeout(
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
              { sessionId, mode },
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
          ),
          getTransportClosedReject(entry),
        ])) as { previous: ApprovalMode; current: ApprovalMode };

        let persisted = false;
        if (opts.persist) {
          try {
            await withTimeout(
              persistApprovalMode?.(boundWorkspace, mode) ?? Promise.resolve(),
              PERSIST_TIMEOUT_MS,
              'persistApprovalMode',
            );
            persisted = persistApprovalMode !== undefined;
          } catch (err) {
            // Persist failure is non-fatal — the in-process change already
            // took effect inside the ACP child. Log but don't fail the route.
            writeStderrLine(
              `setSessionApprovalMode: persist failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        try {
          entry.events.publish({
            type: 'approval_mode_changed',
            data: {
              sessionId: entry.sessionId,
              previous: response.previous,
              next: response.current,
              persisted,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        } catch {
          /* bus closed */
        }
        // #4282 fold-in 4 (S2): a persisted change becomes the workspace
        // default, so fan out a workspace-scoped mirror for peer sessions.
        // #4297 fold-in 1: skip the requesting session (its own bus already
        // got the publish above) to avoid double-counting in the reducer.
        if (persisted) {
          broadcastWorkspaceEvent(
            {
              type: 'approval_mode_changed',
              data: {
                sessionId: entry.sessionId,
                previous: response.previous,
                next: response.current,
                persisted,
              },
              ...(originatorClientId ? { originatorClientId } : {}),
            },
            entry.sessionId,
          );
        }
        return {
          sessionId: entry.sessionId,
          mode: response.current,
          previous: response.previous,
          persisted,
        };
      });
      // Tail-swallow so a failed change doesn't poison subsequent ones.
      entry.approvalModeQueue = approvalWork.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await approvalWork;
      } catch (err) {
        // The ACP child rethrows `TrustGateError` as a JSON-RPC error whose
        // `data.errorKind` is `'trust_gate'`; re-instantiate the typed class so
        // the HTTP route maps it to 403 with the `auth_env_error` errorKind.
        const data = (err as { data?: unknown })?.data;
        if (
          data &&
          typeof data === 'object' &&
          'errorKind' in data &&
          (data as { errorKind?: unknown }).errorKind === 'trust_gate'
        ) {
          const rawMessage = (err as { message?: unknown })?.message;
          const message =
            typeof rawMessage === 'string'
              ? rawMessage
              : 'Trust-gate rejection from ACP child';
          throw new TrustGateError(message);
        }
        throw err;
      }
    },

    async generateSessionRecap(sessionId, _context) {
      // #4175 follow-up. Thin pass-through to `qwen/control/session/
      // recap` — the ACP child runs `generateSessionRecap` against the
      // session's GeminiClient history and returns `{sessionId, recap}`
      // where `recap` may be `null` for too-short histories or transient
      // model failures. The core helper is documented to never throw,
      // so the only paths that surface as bridge errors are: unknown
      // sessionId (`SessionNotFoundError`), transport closed mid-flight
      // (race against `getTransportClosedReject`), and the backstop
      // `SESSION_RECAP_TIMEOUT_MS` race for a wedged ACP channel.
      //
      // `_context` carries the trusted client id for future event
      // fan-out (e.g. a `session_recap_generated` push event), but
      // recap is informational-only today — no SSE broadcast.
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap dispatching ext-method for session=${sessionId}`,
        'info',
      );
      const response = (await Promise.race([
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionRecap, {
            sessionId,
          }),
          SESSION_RECAP_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionRecap,
        ),
        getTransportClosedReject(entry),
      ])) as { sessionId: string; recap: string | null };
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap completed for session=${sessionId} recap=${response.recap ? `len=${response.recap.length}` : 'null'}`,
        'info',
      );
      return {
        sessionId: entry.sessionId,
        recap: response.recap ?? null,
      };
    },

    async generateSessionBtw(sessionId, question, signal, _context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      if (signal?.aborted) return { sessionId, answer: null };
      const races: Array<Promise<unknown>> = [
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionBtw, {
            sessionId,
            question,
          }),
          SESSION_BTW_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionBtw,
        ),
        getTransportClosedReject(entry),
      ];
      let cleanupAbort: (() => void) | undefined;
      if (signal) {
        races.push(
          new Promise<never>((_, reject) => {
            const handler = () =>
              reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', handler, { once: true });
            cleanupAbort = () => signal.removeEventListener('abort', handler);
          }),
        );
      }
      let response: { sessionId: string; answer: string | null };
      try {
        response = (await Promise.race(races)) as {
          sessionId: string;
          answer: string | null;
        };
      } finally {
        cleanupAbort?.();
      }
      return {
        sessionId: entry.sessionId,
        answer: response.answer ?? null,
      };
    },

    async executeShellCommand(
      sessionId,
      command,
      signal,
      context,
    ): Promise<ShellCommandResult> {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge executeShellCommand for session=${sessionId}`,
        'info',
      );
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );

      if (signal?.aborted) {
        return { exitCode: null, output: '', aborted: true };
      }

      const cwd = entry.workspaceCwd;

      entry.events.publish({
        type: 'user_shell_command',
        data: { sessionId, command, cwd },
        ...(originatorClientId ? { originatorClientId } : {}),
      });

      const outputChunks: string[] = [];
      const abort = new AbortController();
      const onSignalAbort = () => abort.abort();
      signal?.addEventListener('abort', onSignalAbort, { once: true });

      try {
        const handle = await ShellExecutionService.execute(
          command,
          cwd,
          (event: ShellOutputEvent) => {
            if (event.type === 'data') {
              const chunk =
                typeof event.chunk === 'string'
                  ? event.chunk
                  : event.chunk
                      .map((line: Array<{ text: string }>) =>
                        line.map((t) => t.text).join(''),
                      )
                      .join('\n');
              outputChunks.push(chunk);
              entry.events.publish({
                type: 'session_update',
                data: {
                  sessionId,
                  update: {
                    sessionUpdate: 'shell_output',
                    output: chunk,
                    _meta: {
                      serverTimestamp: Date.now(),
                      source: 'user-shell',
                    },
                  },
                },
                ...(originatorClientId ? { originatorClientId } : {}),
              });
            }
          },
          abort.signal,
          false,
          { terminalWidth: 120, terminalHeight: 40 },
          { streamStdout: true },
        );

        const timeoutId = setTimeout(
          () => abort.abort(),
          SHELL_COMMAND_TIMEOUT_MS,
        );
        timeoutId.unref();

        const result = await handle.result;
        clearTimeout(timeoutId);

        const exitCode = result.exitCode;
        const aborted = result.aborted;
        const output = outputChunks.join('') || result.output;

        entry.events.publish({
          type: 'user_shell_result',
          data: {
            sessionId,
            exitCode,
            signal: result.signal,
            aborted,
            _meta: { serverTimestamp: Date.now() },
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });

        const historyOutput =
          output.length > MAX_SHELL_OUTPUT_FOR_HISTORY
            ? output.substring(0, MAX_SHELL_OUTPUT_FOR_HISTORY) +
              '\n... (truncated)'
            : output;

        try {
          await entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionShellHistory,
            { sessionId, command, output: historyOutput, exitCode },
          );
        } catch (err) {
          writeServeDebugLine(
            `shell history injection failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        return { exitCode, output, aborted };
      } catch (err) {
        entry.events.publish({
          type: 'user_shell_result',
          data: {
            sessionId,
            exitCode: null,
            signal: null,
            aborted: false,
            error: err instanceof Error ? err.message : String(err),
            _meta: { serverTimestamp: Date.now() },
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      } finally {
        signal?.removeEventListener('abort', onSignalAbort);
      }
    },

    async setWorkspaceToolEnabled(toolName, enabled, originatorClientId) {
      // #4175 Wave 4 PR 17. Pure file IO + event fan-out — no ACP
      // roundtrip. The settings file is the source of truth; live
      // sessions retain their already-registered tools until the next
      // ACP child spawn (when `tools.disabled` is consulted at Config
      // construction time).
      if (!persistDisabledTools) {
        throw new Error(
          'setWorkspaceToolEnabled requires `persistDisabledTools` in ' +
            'BridgeOptions; runQwenServe wires the production callback. ' +
            'Direct embeds and tests must opt in.',
        );
      }
      await persistDisabledTools(boundWorkspace, toolName, enabled);
      broadcastWorkspaceEvent({
        type: 'tool_toggled',
        data: { toolName, enabled },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      return { toolName, enabled };
    },

    async restartMcpServer(serverName, originatorClientId, opts) {
      // #4175 Wave 4 PR 17. The restart logic lives inside the ACP
      // child (it owns the `McpClientManager`); the bridge's role is
      // to (a) pick a live channel to forward through, (b) translate
      // the structured response back into the typed result, (c) fan
      // out the appropriate event to every session bus. Soft refusals
      // (skipped:true) come back as a normal response; hard errors
      // (server not configured, manager unavailable, post-discover
      // not connected) are translated via `data.errorKind` into typed
      // bridge errors that `sendBridgeError` maps to stable HTTP
      // responses (#4282 gpt-5.5 C4/C5 fold-in).
      //
      // F2 (#4175 commit 5): `opts.entryIndex` is forwarded to the
      // ACP child for pool-mode restart targeting. The agent's
      // handler falls back to legacy single-entry semantics when no
      // pool entry matches, so older daemons that don't yet honor
      // `entryIndex` keep the pre-F2 response shape — clients
      // gated on the `mcp_pool_restart` capability tag are the only
      // ones that send `entryIndex`.
      const info = liveChannelInfo();
      if (!info) {
        throw new SessionNotFoundError(`mcp:${serverName}`);
      }
      type LegacyOk = {
        serverName: string;
        restarted: true;
        durationMs: number;
      };
      type LegacySkip = {
        serverName: string;
        restarted: false;
        skipped: true;
        reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
      };
      type PoolEntries = {
        serverName: string;
        entries: Array<{
          entryIndex: number;
          restarted: boolean;
          durationMs?: number;
          reason?: string;
        }>;
      };
      let response: LegacyOk | LegacySkip | PoolEntries;
      const params: Record<string, unknown> = { serverName };
      if (opts?.entryIndex !== undefined) {
        params['entryIndex'] = opts.entryIndex;
      }
      try {
        response = (await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart,
              params,
            ),
            MCP_RESTART_SERVER_DEADLINE_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart,
          ),
          getChannelClosedReject(info),
        ])) as LegacyOk | LegacySkip | PoolEntries;
      } catch (err) {
        // Detect structured ACP error payloads and re-instantiate as
        // typed bridge errors. JSON-RPC strips class names across the
        // wire; the agent attaches `data.errorKind` as the
        // reconstruction signal.
        const data = (err as { data?: unknown })?.data;
        if (data && typeof data === 'object') {
          const kind = (data as { errorKind?: unknown }).errorKind;
          const sn = (data as { serverName?: unknown }).serverName;
          if (kind === 'mcp_server_not_found' && typeof sn === 'string') {
            throw new McpServerNotFoundError(sn);
          }
          if (kind === 'mcp_restart_failed' && typeof sn === 'string') {
            const status = (data as { mcpStatus?: unknown }).mcpStatus;
            throw new McpServerRestartFailedError(
              sn,
              typeof status === 'string' ? status : 'unknown',
            );
          }
        }
        throw err;
      }
      // F2 (#4175 commit 5): pool-mode `entries[]` shape fans out one
      // typed event per entry so SDK reducers see a stable per-entry
      // count regardless of whether the underlying restart was
      // single-entry (legacy) or multi-entry (pool-mode). Reusing the
      // existing `mcp_server_restarted` / `mcp_server_restart_refused`
      // event types keeps `KnownDaemonEvent` schema additive — clients
      // gated only on `entryCount > 1` get accurate per-entry signals
      // without a new event type.
      // F2 (#4175 commit 6 review fix — wenshao W15): the response
      // arrives as untyped JSON from `info.connection.extMethod(...)`
      // — a buggy/out-of-sync ACP child returning a malformed shape
      // (e.g. `entries` is a string, or per-entry objects miss
      // `entryIndex`) would otherwise crash this route with a
      // TypeError. Add a runtime shape check and degrade-with-error
      // for entries that don't match the typed wire contract.
      if ('entries' in response) {
        const entries = Array.isArray(response.entries) ? response.entries : [];
        if (!Array.isArray(response.entries)) {
          writeStderrLine(
            `qwen serve: pool restart response carried 'entries' field ` +
              `but it is not an array (server=${response.serverName}); ` +
              `treating as empty.`,
          );
        }
        for (const entry of entries) {
          if (
            typeof entry !== 'object' ||
            entry === null ||
            typeof (entry as { entryIndex?: unknown }).entryIndex !== 'number'
          ) {
            writeStderrLine(
              `qwen serve: skipping malformed pool restart entry ` +
                `(server=${response.serverName}): ${JSON.stringify(entry)}`,
            );
            continue;
          }
          if (entry.restarted) {
            broadcastWorkspaceEvent({
              type: 'mcp_server_restarted',
              data: {
                serverName: response.serverName,
                durationMs: entry.durationMs ?? 0,
                entryIndex: entry.entryIndex,
              },
              ...(originatorClientId ? { originatorClientId } : {}),
            });
          } else {
            broadcastWorkspaceEvent({
              type: 'mcp_server_restart_refused',
              data: {
                serverName: response.serverName,
                reason: 'restart_failed',
                entryIndex: entry.entryIndex,
                ...(entry.reason ? { details: entry.reason } : {}),
              },
              ...(originatorClientId ? { originatorClientId } : {}),
            });
          }
        }
      } else if (response.restarted === true) {
        broadcastWorkspaceEvent({
          type: 'mcp_server_restarted',
          data: {
            serverName: response.serverName,
            durationMs: response.durationMs,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } else {
        broadcastWorkspaceEvent({
          type: 'mcp_server_restart_refused',
          data: {
            serverName: response.serverName,
            reason: response.reason,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      return response;
    },

    async addRuntimeMcpServer(name, config, originatorClientId) {
      // T2.8 (#4514). Round-trip the runtime-add ext-method through the
      // live ACP child and broadcast an `mcp_server_added` event on
      // success. Soft-refuse (`budget_warning_only`) returns the skip
      // shape without emitting — the caller (HTTP route) decides how to
      // surface the skip to the SDK consumer.
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP add: ${name}`),
          { data: { errorKind: 'acp_channel_unavailable' } },
        );
      }
      type AddOk = {
        name: string;
        transport: 'stdio' | 'sse' | 'http' | 'tcp' | 'sdk';
        replaced: boolean;
        shadowedSettings: boolean;
        toolCount: number;
        originatorClientId: string;
      };
      type AddSkip = {
        name: string;
        skipped: true;
        reason: 'budget_warning_only';
      };
      const response = (await Promise.race([
        withTimeout(
          info.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd,
            { name, config, originatorClientId },
          ),
          MCP_RESTART_SERVER_DEADLINE_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd,
        ),
        getChannelClosedReject(info),
      ])) as AddOk | AddSkip;
      // Emit event on success (non-skip)
      const addSkipped = (response as { skipped?: boolean }).skipped === true;
      if (!addSkipped) {
        const ok = response as AddOk;
        broadcastWorkspaceEvent({
          type: 'mcp_server_added',
          data: {
            name: ok.name,
            transport: ok.transport,
            replaced: ok.replaced,
            shadowedSettings: ok.shadowedSettings,
            toolCount: ok.toolCount,
            originatorClientId: ok.originatorClientId,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      return response;
    },

    async removeRuntimeMcpServer(name, originatorClientId) {
      // T2.8 (#4514). Round-trip the runtime-remove ext-method through
      // the live ACP child and broadcast `mcp_server_removed` on success.
      // Idempotent skip (`not_present`) returns without emitting.
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP remove: ${name}`),
          { data: { errorKind: 'acp_channel_unavailable' } },
        );
      }
      type RemoveOk = {
        name: string;
        removed: true;
        wasShadowingSettings: boolean;
        originatorClientId: string;
      };
      type RemoveSkip = { name: string; skipped: true; reason: 'not_present' };
      let response: RemoveOk | RemoveSkip;
      try {
        response = (await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove,
              { name, originatorClientId },
            ),
            MCP_RESTART_SERVER_DEADLINE_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove,
          ),
          getChannelClosedReject(info),
        ])) as RemoveOk | RemoveSkip;
      } catch (err) {
        const data = (err as { data?: unknown })?.data;
        if (data && typeof data === 'object') {
          const kind = (data as { errorKind?: unknown }).errorKind;
          if (kind === 'acp_channel_unavailable') {
            throw err;
          }
        }
        throw err;
      }
      // Emit event on success (non-skip)
      const removeSkipped =
        (response as { skipped?: boolean }).skipped === true;
      if (!removeSkipped) {
        const ok = response as RemoveOk;
        broadcastWorkspaceEvent({
          type: 'mcp_server_removed',
          data: {
            name: ok.name,
            wasShadowingSettings: ok.wasShadowingSettings,
            originatorClientId: ok.originatorClientId,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      return response;
    },

    async initWorkspace(initOpts, originatorClientId) {
      // #4175 Wave 4 PR 17. Mechanical scaffold of an empty `QWEN.md`
      // (or whatever `getCurrentGeminiMdFilename()` returns under
      // `--memory-file-name` overrides). No ACP roundtrip, no LLM
      // call — clients that want AI-fill follow up with
      // `POST /session/:id/prompt`.
      //
      // FIXME(#4282 fold-in 2 — deepseek SV2): this route uses
      // `node:fs/promises` directly instead of routing through
      // `WorkspaceFileSystem` (PR 18 boundary), so it produces no
      // `fs.access`/`fs.denied` audit trail and skips
      // `assertTrustedForIntent`. The bridge doesn't have an
      // `fsFactory` plumbed at the bridge layer today — the boundary
      // is constructed per-request inside `createServeApp` for PR 19+
      // routes. A follow-up will hoist the factory into
      // `BridgeOptions` so daemon-level routes (init, future
      // workspace ops) can share the same trust + audit posture.
      // Impact today is low: the daemon binds to a workspace the
      // operator chose and the trust dialog flow doesn't yet exist
      // for the daemon. The CV1 symlink reject below covers the
      // immediate boundary-escape concern.
      // #4282 fold-in 5 (Codex P2-1). Use the snapshot from
      // `BridgeOptions.contextFilename` (sourced from the workspace's
      // merged settings at daemon boot) instead of the process-global
      // `getCurrentGeminiMdFilename()` — the daemon parent never goes
      // through `loadCliConfig`, so a workspace configured with
      // `context.fileName: 'AGENTS.md'` would otherwise see init
      // create `QWEN.md` while the rest of the workspace reads a
      // different file.
      const filename = contextFilename;
      // #4282 gpt-5.5 C1 fold-in: `context.fileName` is settings-
      // controlled. A daemon configured with `context.fileName:
      // "../outside.md"` would otherwise resolve outside
      // `boundWorkspace` and let this strict-gated mutation create
      // or truncate a file outside the workspace boundary. Resolve
      // the joined path and reject anything that escapes.
      const target = path.resolve(boundWorkspace, filename);
      const withinWorkspace =
        target === boundWorkspace ||
        target.startsWith(boundWorkspace + path.sep);
      if (!withinWorkspace) {
        throw new WorkspaceInitPathEscapeError(filename, boundWorkspace);
      }
      // #4282 fold-in 5 (Codex P2-4). The textual `withinWorkspace`
      // and final-component `lstat` checks miss intermediate symlinks
      // — e.g. `context.fileName: "docs/QWEN.md"` with `docs` a
      // symlink to `/tmp` would let the later `writeFile(target)`
      // follow the parent symlink and create or truncate outside
      // `boundWorkspace`. Resolve the parent chain via
      // `realpath`, walking up through any not-yet-existing ancestors,
      // and verify the canonical parent stays within the canonical
      // workspace.
      const wsCanonical = await fs.realpath(boundWorkspace);
      const parentCanonical = await canonicalizeExistingAncestor(
        path.dirname(target),
      );
      const parentWithinWorkspace =
        parentCanonical === wsCanonical ||
        parentCanonical.startsWith(wsCanonical + path.sep);
      if (!parentWithinWorkspace) {
        throw new WorkspaceInitSymlinkError(
          target,
          'parent',
          `Configured workspace context filename ${JSON.stringify(filename)} ` +
            `has a parent path that resolves outside the bound workspace ` +
            `(parent canonicalizes to ${JSON.stringify(parentCanonical)}, ` +
            `workspace canonicalizes to ${JSON.stringify(wsCanonical)}). ` +
            `Refusing to write — replace any symlinked parent directory ` +
            `with a real directory before re-running init.`,
        );
      }
      // #4282 fold-in 2 (gpt-5.5 CV1): the textual `withinWorkspace`
      // check above only validates the JOINED path, but a file at
      // `target` that's a symlink can still point outside the
      // workspace. Without an explicit `lstat` reject, `force: true`
      // would follow the link and truncate the external target; a
      // dangling-symlink pointing outside would also let `writeFile`
      // create the external target. Reject symlinks at the boundary
      // — PR 18's `WorkspaceFileSystem` will provide the proper
      // chain-aware resolution + audit hooks once `initWorkspace`
      // routes through that boundary (tracked as a follow-up).
      try {
        const lst = await fs.lstat(target);
        if (lst.isSymbolicLink()) {
          throw new WorkspaceInitSymlinkError(
            target,
            'target',
            `Workspace context file ${JSON.stringify(target)} is a symlink. ` +
              `Refusing to follow it for write — replace the symlink with a ` +
              `regular file (or remove it) before re-running init.`,
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceInitSymlinkError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — target doesn't exist; fresh create is fine.
      }
      let existingSize: number | undefined;
      let action: 'created' | 'overwrote' | 'noop' = 'created';
      try {
        const existing = await fs.readFile(target, 'utf8');
        if (existing.trim().length > 0) {
          existingSize = Buffer.byteLength(existing, 'utf8');
          if (initOpts.force !== true) {
            throw new WorkspaceInitConflictError(target, existingSize);
          }
          action = 'overwrote';
        } else {
          // #4282 wenshao H4 fold-in: an existing whitespace-only file
          // is treated as a no-op rather than silently overwritten.
          // Previously the code would label the response `'created'`
          // and unconditionally `writeFile(target, '')`, destroying
          // the user's whitespace content (stray template, half-
          // written init, intentional newline) without `force: true`.
          // The HTTP intent of "init only if absent" is honored by
          // skipping the write and surfacing `'noop'` so the SSE
          // event accurately reflects that no on-disk change
          // occurred.
          action = 'noop';
        }
      } catch (err) {
        if (err instanceof WorkspaceInitConflictError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — fall through to create.
      }
      if (action === 'created') {
        // #4297 fold-in 5 (wenshao critical, addresses #3260836305).
        // Close the TOCTOU window between the `lstat`/`readFile`
        // checks above and this write by using `'wx'`
        // (O_WRONLY|O_CREAT|O_EXCL): the open atomically refuses
        // when ANY inode (regular file, dir, symlink, …) exists at
        // the target path, so a local attacker can't slip a symlink
        // between our checks and follow it through here.
        //
        // #4297 fold-in 10 (qwen-latest S2, addresses #3263954690):
        // EEXIST bubbles up as `WorkspaceInitRaceError(kind:
        // 'eexist')` — a sibling class to `WorkspaceInitSymlinkError`
        // so the HTTP code distinguishes a race-created inode (could
        // be regular file OR symlink — we don't know which) from the
        // symlink-confirmed cases at the lstat / O_NOFOLLOW sites.
        let fh: import('node:fs/promises').FileHandle;
        try {
          fh = await fs.open(target, 'wx');
        } catch (err) {
          const code = (err as { code?: unknown } | null | undefined)?.code;
          if (code === 'EEXIST') {
            throw new WorkspaceInitRaceError(
              target,
              'eexist',
              `Workspace context file ${JSON.stringify(target)} appeared ` +
                `between our absence check and the create — refusing to ` +
                `proceed (a regular file or symlink was just placed at the ` +
                `target path, and following it could escape the workspace).`,
            );
          }
          throw err;
        }
        try {
          // #4297 fold-in 10 (qwen-latest S5, addresses #3263954707):
          // post-open parent re-verification narrows the parent-symlink
          // TOCTOU window between `canonicalizeExistingAncestor` and
          // `fs.open`. `O_NOFOLLOW` only protects the final component;
          // a local writer could swap a real `docs/` parent for a
          // `docs -> /tmp` symlink between our pre-check and this open
          // and the kernel would resolve the parent unconditionally.
          // Re-canonicalizing the parent post-open and refusing the
          // write when it moved out of the workspace catches that race
          // (cost: one extra realpath syscall per init).
          await verifyParentWithinWorkspace(target, wsCanonical, 'create', fh);
          await fh.writeFile('', 'utf8');
        } finally {
          await fh.close();
        }
      } else if (action === 'overwrote') {
        // #4297 fold-in 7 (gpt-5.5 critical, addresses #3262615446):
        // close the TOCTOU window on the `force: true` path with
        // `O_WRONLY|O_TRUNC|O_NOFOLLOW`. `O_NOFOLLOW` causes
        // `open()` to fail with ELOOP if the final component is a
        // symlink — even if a local writer races a symlink in
        // between our `lstat`/`readFile` checks and this open, the
        // open refuses rather than truncating the link target.
        // (The symbol exists on Linux/macOS; on Windows the constant
        // is 0/no-op since the OS always follows symlinks, which
        // is consistent with the documented Stage-1 trust posture
        // there — Windows daemon support is best-effort.)
        let fh: import('node:fs/promises').FileHandle;
        try {
          // #4297 post-merge wenshao Critical fold-in (folded into F1
          // #4319): drop `O_TRUNC` from the open flags. The kernel
          // applies O_TRUNC AT `open(2)` SYSCALL TIME — before
          // `verifyParentWithinWorkspace` (below) gets a chance to
          // detect a parent-symlink race. With O_TRUNC, a local user
          // who wins the TOCTOU between `canonicalizeExistingAncestor`
          // and this `open()` zeros the file at the attacker-
          // redirected location (arbitrary-file-truncation primitive
          // against any file the daemon UID can open). The pre-fix
          // code's own comment on `verifyParentWithinWorkspace`
          // acknowledged this as "documented residual risk"; wenshao
          // pushed back that this exceeds the Stage-1 trust model.
          //
          // Truncation now happens AFTER `verifyParentWithinWorkspace`
          // succeeds, via `fh.truncate(0)` on the fd we already hold.
          // fd-based truncate does NOT re-resolve the path, so an
          // attacker swapping the parent symlink after we open can't
          // redirect the truncation.
          //
          // #4297 fold-in 10 (qwen-latest S3, addresses #3263954697):
          // `O_NOFOLLOW ?? 0` matches the defensive pattern in
          // `core/src/utils/{sessionStorageUtils,gitDiff}.ts` and
          // `cli/src/ui/utils/customBanner.ts` for platforms that
          // don't expose the constant. Functionally a no-op (JS
          // bitwise coerces `undefined` to 0) but keeps the codebase
          // consistent for the next greppy refactor.
          fh = await fs.open(
            target,
            fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
          );
        } catch (err) {
          const code = (err as { code?: unknown } | null | undefined)?.code;
          // #4297 fold-in 8 (qwen-latest S1, addresses #3262861754):
          // split ELOOP and ENOENT diagnostics so operators don't
          // misdiagnose. ELOOP is the genuine `O_NOFOLLOW` rejection
          // — a symlink at the final component, possibly an attack
          // race. ENOENT here means the file was DELETED between
          // the readFile content check and this open — a benign race
          // with a concurrent writer (git checkout, editor save).
          // Both still surface as `WorkspaceInitSymlinkError(kind:
          // 'target')` so the route maps to a structured 400; the
          // class doubles as the workspace-init race-condition
          // bucket, but the message is now accurate per case.
          if (code === 'ELOOP') {
            throw new WorkspaceInitSymlinkError(
              target,
              'target',
              `Workspace context file ${JSON.stringify(target)} could not ` +
                `be opened with O_NOFOLLOW (ELOOP); the path may have been ` +
                `swapped to a symlink between the content check and the ` +
                `overwrite. Refusing to follow it.`,
            );
          }
          if (code === 'ENOENT') {
            // #4297 fold-in 10 (qwen-latest S2, addresses #3263954690):
            // ENOENT here means race-deletion, not a symlink — use the
            // sibling `WorkspaceInitRaceError` so the HTTP code
            // (`workspace_init_race`) doesn't mislead operators into
            // hunting a symlink attack on benign concurrent-modification.
            throw new WorkspaceInitRaceError(
              target,
              'enoent',
              `Workspace context file ${JSON.stringify(target)} was deleted ` +
                `between the content check and the overwrite (likely a ` +
                `concurrent writer — git checkout, editor save, etc.). ` +
                `Refusing to recreate blindly; rerun init.`,
            );
          }
          throw err;
        }
        try {
          // #4297 fold-in 10 (qwen-latest S5, addresses #3263954707):
          // same post-open parent re-verification as the create path.
          // The overwrite branch is more sensitive — race-substituting
          // a parent symlink to redirect TRUNCATE outside the workspace
          // is the worst-case escape. Verifying after `O_NOFOLLOW` open
          // succeeds catches the parent-only race that O_NOFOLLOW
          // doesn't cover (the kernel resolved the parent path).
          await verifyParentWithinWorkspace(
            target,
            wsCanonical,
            'overwrite',
            fh,
          );
          // #4297 post-merge wenshao Critical fold-in (folded into F1
          // #4319): truncate AFTER verify, using the fd we already
          // hold. fd-based truncate doesn't re-resolve the path, so
          // an attacker who swaps the parent symlink between
          // verifyParentWithinWorkspace and here can't redirect the
          // truncation to an external file. See the open-flags
          // comment above for the full O_TRUNC race analysis.
          await fh.truncate(0);
          await fh.writeFile('', 'utf8');
        } finally {
          await fh.close();
        }
      }
      broadcastWorkspaceEvent({
        type: 'workspace_initialized',
        data: { path: target, action },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      return { path: target, action };
    },

    async killSession(sessionId, opts) {
      const entry = byId.get(sessionId);
      if (!entry) return;
      // BQ9tV race guard: skip the reap if any other client already
      // attached to this entry. The disconnect-reaper in server.ts
      // sets `requireZeroAttaches: true` because it only wants to
      // reap when the spawn-owner that disconnected truly was the
      // sole client. Counter increment + this check both run
      // synchronously, so no microtask boundary lets a race slip
      // through.
      // BkwQP: when bailing because of an attach, set the tombstone
      // so a later `detachClient` (that brings attachCount back to
      // 0) can complete the deferred reap. Without this, both
      // spawn-owner-and-attach disconnecting leaves the session
      // orphaned forever (spawn owner's reap bails here, attach's
      // detach does nothing structural).
      if (opts?.requireZeroAttaches && entry.attachCount > 0) {
        entry.spawnOwnerWantedKill = true;
        return;
      }
      // F3 Commit 3 — mediator-driven cancel cascade. Must run BEFORE
      // byId.delete so the mediator's emit callback can still reach
      // entry.events via byId.get(sessionId) (same order as closeSession).
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      // Remove from the state eagerly so concurrent `spawnOrAttach`
      // can't reattach to a session we're tearing down.
      if (defaultEntry === entry) defaultEntry = undefined;
      byId.delete(sessionId);
      // Detach from the channel. The channel dies only when its LAST
      // session leaves — other sessions on the same channel keep
      // running.
      //
      // #4325 fix: same channel-overlap fix as in `closeSession` above.
      // `channelInfoForEntry(entry)` returns the entry's actual
      // channel rather than the module-scoped `channelInfo` (current
      // attach target), preventing the "kill operates on the freshly-
      // spawned channel B instead of the dying channel A" cascade
      // during the overlap window.
      //
      // HAZARD(#4325): see the matching block in `closeSession`. The
      // regression test for this fix is single-channel smoke and
      // would NOT fail if this line reverts to `channelInfo`. Keep
      // `channelInfoForEntry(entry)` until the deterministic overlap
      // test lands.
      const ci = channelInfoForEntry(entry);
      if (!ci) {
        // Same diagnostic as `closeSession` (#4334 wenshao review
        // DWrbr) — when the entry's channel is already gone, the
        // cleanup below short-circuits silently; surface that.
        writeStderrLine(
          `qwen serve: killSession channelInfoForEntry returned undefined ` +
            `for session ${JSON.stringify(sessionId)} — channel cleanup skipped (entry's channel already torn down)`,
        );
      }
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      await notifyAgentSessionClose(entry, ci, 'killSession');
      // PR 14b fix (codex round 5): tombstone the killed sessionId
      // so any in-flight `extNotification` from the (about-to-be-
      // killed) child can't seed the early-event buffer for a
      // subsequent load/resume of the same persisted id. See the
      // matching guard in BridgeClient.bufferEarlyEvent.
      ci?.client.markSessionClosed(sessionId);
      // Publish `session_died` BEFORE closing the bus. After the eager
      // `byId.delete` above, the channel.exited handler's
      // `byId.get(...)` returns undefined so the automatic publish
      // at crash time wouldn't fire. SSE subscribers need this
      // terminal frame to know the session is gone.
      try {
        entry.events.publish({
          type: 'session_died',
          data: { sessionId, reason: 'killed' },
        });
      } catch {
        /* bus already closed */
      }
      entry.events.close();
      // Only kill the channel when no other sessions remain AND no
      // restore is in flight.
      // `pendingRestoreIds` covers in-flight `session/load` and
      // `session/resume` calls that haven't yet registered into
      // `sessionIds`. Killing the channel out from under them would
      // SIGTERM the restore mid-flight and 500 the caller for a
      // failure orthogonal to their request.
      if (ci && ci.sessionIds.size === 0 && ci.pendingRestoreIds.size === 0) {
        // Mark dying SYNCHRONOUSLY before the await so a concurrent
        // `spawnOrAttach` arriving during the SIGTERM grace window
        // doesn't attach to a transport we're tearing down — without
        // this it would land the caller with a sessionId that 404s on
        // every follow-up once `channel.exited` fires (the equivalent
        // of the pre-PR eager `byWorkspaceChannel.delete()` from the
        // Stage 1 routing era). `channelInfo` stays set until OS reap
        // so `killAllSync` still finds a target (BkUyD).
        ci.isDying = true;
        await ci.channel.kill().catch(() => {
          // Best-effort kill — channel may already be dead.
        });
      }
    },

    async detachClient(sessionId, clientId) {
      // tanzhenxin issue 2: the BQ9tV `attachCount` race guard is
      // monotonic — once any attach bumps it, the spawn-owner's
      // disconnect-reaper becomes a permanent no-op even if the
      // attaching client itself disconnected. This is the symmetric
      // rollback the server's `!res.writable && session.attached`
      // path calls into.
      //
      // BkwQP: detachClient ONLY decrements; it does NOT reap on
      // its own. Reaping is the spawn-owner's responsibility, and
      // the spawn owner's `killSession({ requireZeroAttaches: true })`
      // sets `spawnOwnerWantedKill` if they had to bail because we
      // already had `attachCount > 0`. Only when that tombstone is
      // set do we complete the deferred reap from here. Without
      // this restraint, a transient attach disconnecting would
      // reap a still-valid session whose spawn owner is alive but
      // hasn't opened SSE yet.
      const entry = byId.get(sessionId);
      if (!entry) return;
      if (entry.attachCount > 0) entry.attachCount--;
      unregisterClient(entry, clientId);
      if (
        entry.spawnOwnerWantedKill &&
        entry.attachCount === 0 &&
        entry.events.subscriberCount === 0
      ) {
        // Defer-completed reap. Re-use killSession's logic; pass
        // `requireZeroAttaches: false` (default) because we've
        // already validated all the conditions ourselves.
        await this.killSession(sessionId).catch(() => {
          /* best-effort; channel.exited will eventually reap anyway */
        });
      }
    },

    killAllSync() {
      // Bd1y6: synchronous best-effort SIGKILL on EVERY alive channel
      // (typically 1, but during a `killSession`-then-`spawnOrAttach`
      // overlap there can be 2 — the dying one in `aliveChannels`
      // plus a fresh attach-target in `channelInfo`). Set
      // `shuttingDown` so any racing async path fails fast.
      //
      // tanzhenxin BkUyD: iterate `aliveChannels` (the OS-level "still
      // alive" source of truth) — `channelInfo` only points at the
      // CURRENT attach target, missing any dying channel whose
      // `channel.exited` hasn't fired yet. Without this, a fresh
      // spawn overwriting `channelInfo` during the prior channel's
      // SIGTERM grace would leave the dying child without SIGKILL
      // escalation when `process.exit(1)` fires.
      shuttingDown = true;
      const channels = Array.from(aliveChannels);
      defaultEntry = undefined;
      byId.clear();
      for (const info of channels) {
        try {
          info.channel.killSync();
        } catch {
          /* best-effort — already-dead child / pid race */
        }
      }
    },

    async shutdown() {
      // Set BEFORE the snapshot so any racing `spawnOrAttach` triggered
      // by an in-flight HTTP connection after `runQwenServe.close()`
      // entered the bridge.shutdown() phase fails fast instead of
      // spawning a child this teardown won't see.
      shuttingDown = true;
      const entries = Array.from(byId.values());
      // Snapshot every alive channel (typically 1; up to 2 during a
      // `killSession`-then-`spawnOrAttach` overlap) — entries are
      // intentionally NOT removed from `aliveChannels` here; their
      // `channel.exited` handlers clear them once the OS has reaped
      // each child. That preserves the BkUyD invariant: a
      // double-Ctrl+C arriving mid-SIGTERM-grace can still find every
      // alive channel via `killAllSync`. Marking each `isDying` makes
      // them invisible to any racing `ensureChannel` call — but
      // `shuttingDown` already blocks new `spawnOrAttach` upstream,
      // so this is mostly belt-and-suspenders (a direct internal
      // `ensureChannel` past the gate would still see the dying
      // state and not attach).
      const channels = Array.from(aliveChannels);
      for (const ci of channels) ci.isDying = true;
      // F3 Commit 3 — drain mediator pending state before clearing
      // byId so awaiting `requestPermission` callers unwind. Each
      // `forgetSession` settles all matching pending as
      // session_closed; the bridge's per-entry index gets cleared
      // alongside.
      for (const e of entries) {
        permissionMediator.forgetSession(e.sessionId);
        e.pendingPermissionIds.clear();
      }
      defaultEntry = undefined;
      byId.clear();
      // Publish a terminal `session_died` BEFORE closing each bus so SSE
      // subscribers can distinguish "daemon shut down" from a transient
      // network error and don't sit indefinitely retrying. The
      // channel.exited handler also publishes this on a child crash,
      // but at shutdown time the entry has already been removed from
      // `byId` (above), so the handler's `byId.get(...)` is undefined
      // and the automatic publish wouldn't fire.
      for (const e of entries) {
        try {
          e.events.publish({
            type: 'session_died',
            data: { sessionId: e.sessionId, reason: 'daemon_shutdown' },
          });
        } catch {
          /* bus already closed */
        }
        e.events.close();
      }
      // Wait for in-flight channel + session spawns. The snapshot
      // above only sees what's already registered; a doSpawn past
      // `newSession()` but pre-`byId.set` is missed, as is an
      // `ensureChannel` past `channelFactory()` but pre-`channelInfo
      // = info`. The late-shutdown re-checks at doSpawn/ensureChannel
      // catch both — but without these awaits, `bridge.shutdown()`
      // would resolve before they finish, and the orphan stderr
      // error from a half-built child would fire AFTER the daemon
      // claimed graceful shutdown (log-confusing).
      const inFlightSessionAwaits = Array.from(inFlightSpawns.values()).map(
        (p): Promise<void> =>
          p.then(
            () => undefined,
            () => undefined,
          ),
      );
      const inFlightRestoreAwaits = Array.from(inFlightRestores.values()).map(
        (restore): Promise<void> =>
          restore.promise.then(
            () => undefined,
            () => undefined,
          ),
      );
      const inFlightChannelAwait: Promise<void> = inFlightChannelSpawn
        ? inFlightChannelSpawn.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
      await Promise.all([
        ...channels.map((ci) => ci.channel.kill().catch(() => {})),
        ...inFlightSessionAwaits,
        ...inFlightRestoreAwaits,
        inFlightChannelAwait,
      ]);
    },
  };
}

/**
 * #4282 fold-in 5 (Codex P2-4). Resolve `inputPath` to its real
 * filesystem path, walking up through directory components that
 * don't yet exist on disk. Used by `initWorkspace` to make sure
 * every parent directory of the target file canonicalizes inside
 * the bound workspace — a symlink at any level (e.g. `docs/QWEN.md`
 * with `docs -> /tmp`) would otherwise let `writeFile` escape the
 * workspace boundary.
 *
 * The walk-up mirrors what `realpath` would do if it accepted
 * non-existent terminal segments: the deepest extant ancestor
 * dictates the canonical prefix, and any not-yet-created components
 * inherit it. Hitting the filesystem root (`path.dirname(p) === p`)
 * without finding anything that exists rethrows the underlying
 * ENOENT — by that point the input was unrooted in a way the
 * caller's contract can't honor.
 */
async function canonicalizeExistingAncestor(
  inputPath: string,
): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      // #4297 post-merge wenshao S2 fold-in (folded into F1 #4319):
      // also catch ELOOP — a circular symlink in the parent path
      // (e.g., `a -> b`, `b -> a`) makes `fs.realpath` fail with
      // ELOOP. Without this, that bubbles up as an unstructured
      // HTTP 500 instead of the typed `WorkspaceInitSymlinkError`
      // (400) the route handler expects from the workspace-init
      // race detection family. Walking up the parent chain when
      // ELOOP hits at a sub-component preserves the existing
      // "walk to the deepest extant ancestor" contract.
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * #4297 fold-in 10 (qwen-latest S5, addresses #3263954707). Re-verify
 * the parent directory canonicalizes inside the workspace AFTER the
 * `fs.open()` succeeded. `O_NOFOLLOW` only covers the final path
 * component; a local writer with workspace write access could race-
 * substitute a parent dir for a symlink between the pre-open
 * `canonicalizeExistingAncestor` check and the actual open. The
 * kernel resolves parent symlinks unconditionally during open, so
 * the fd we just opened may point outside `wsCanonical`.
 *
 * Catching the race after the fact: re-realpath the parent and
 * compare against `wsCanonical`. If the parent moved, the open
 * succeeded against an out-of-workspace inode; we throw
 * `WorkspaceInitSymlinkError(kind: 'parent')` so the route maps
 * to a 400 (config / race / attack ambiguous, but not a daemon
 * failure).
 *
 * The cleanup parameter distinguishes:
 *   - `'create'`: the open created the file; on race detection we
 *     unlink it best-effort to avoid leaving an empty file in the
 *     attacker's redirected location.
 *   - `'overwrite'`: the open truncated an existing file we'd
 *     already content-checked. The truncate happened at open time
 *     so the damage (zero-length file at the redirected path) is
 *     already done — but the throw at least prevents subsequent
 *     write content; documented residual risk.
 *
 * Residual race window: between this `realpath` and the next
 * `writeFile` on the fd, the parent could in principle be swapped
 * again. The fd we hold is still valid against the inode it was
 * opened against, which is what `writeFile` writes to — so this
 * remaining window is sub-millisecond and bounded to "fd opened
 * against an inode that briefly was under wsCanonical." Acceptable
 * residual posture for the Stage-1 trust model.
 */
async function verifyParentWithinWorkspace(
  target: string,
  wsCanonical: string,
  cleanup: 'create' | 'overwrite',
  fh: import('node:fs/promises').FileHandle,
): Promise<void> {
  const parentCanonical = await canonicalizeExistingAncestor(
    path.dirname(target),
  );
  const within =
    parentCanonical === wsCanonical ||
    parentCanonical.startsWith(wsCanonical + path.sep);
  if (within) return;
  // Best-effort cleanup before throwing. We're already in a failure
  // path; ignore secondary errors so the original race-detection
  // throw isn't shadowed.
  //
  // #4297 post-merge wenshao Critical fold-in (folded into F1 #4319):
  // do NOT `fs.unlink(target)`. After a parent-directory race the
  // textual `target` path now resolves through the attacker's freshly-
  // planted parent symlink to an external location — `fs.unlink`
  // would happily delete whatever file exists at the attacker's
  // chosen path, giving any local user with workspace write access
  // an arbitrary-file-deletion primitive against the daemon's UID.
  // The empty file we created at the pre-race location is harmless
  // (0 bytes, inside the workspace we'd just verified). Leaving it
  // there over deleting an arbitrary external file is the right
  // safety trade.
  if (cleanup === 'create') {
    await fh.close().catch(() => {});
  }
  throw new WorkspaceInitSymlinkError(
    target,
    'parent',
    `Workspace context file ${JSON.stringify(target)}'s parent moved ` +
      `outside the workspace between the pre-open canonicalize and ` +
      `the post-open verify (parent canonicalizes to ${JSON.stringify(parentCanonical)}, ` +
      `workspace canonicalizes to ${JSON.stringify(wsCanonical)}). ` +
      `Refusing to write — investigate the concurrent writer or the ` +
      `parent-directory permissions.`,
  );
}

/**
 * Race `p` against a timeout. The timeout REJECTS the returned
 * promise but does NOT abort the underlying operation — `p` keeps
 * running to completion (or its own failure) and its eventual
 * resolution is silently dropped.
 *
 * Stage 1 limitation: for `unstable_setSessionModel` the agent may
 * complete the model switch AFTER we surfaced the timeout to the
 * HTTP caller, leading to drift between caller's perceived model
 * and agent's actual model. Subscribers also see contradictory
 * SSE events (`model_switch_failed` from the timeout, then a late
 * `model_switched` if the agent succeeds). Acceptable for Stage 1
 * because:
 *   1. ACP's `unstable_setSessionModel` doesn't accept a cancel
 *      signal yet (the SDK's `prompt` does, hence `sendPrompt`'s
 *      explicit `cancel` notification on abort).
 *   2. Model switches complete in milliseconds in practice; a
 *      timeout firing means the agent is genuinely wedged, not
 *      just slow, and would have been DOA anyway.
 * Stage 2 will add abort plumbing once ACP exposes a cancel hook
 * for `unstable_setSessionModel`. Tracked in the model-change
 * concurrency notes in `applyModelServiceId`. BSA0C suggested a
 * `modelSwitchTimedOut` flag + `model_switch_late_success`
 * synthetic frame for full observability of the divergent state;
 * recorded as a Stage 2 follow-up so the timeout/late-success
 * handshake is implemented once across both ACP-side cancel and
 * the bridge-side state flag (rather than just papering over the
 * symptom).
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
