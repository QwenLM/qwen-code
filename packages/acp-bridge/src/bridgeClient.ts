/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type { BridgeEvent, EventBus } from './eventBus.js';
import type { BridgeFileSystem } from './bridgeFileSystem.js';
import { CANCEL_VOTE_SENTINEL } from './permissionMediator.js';
// Narrowed from the concrete `MultiClientPermissionMediator` to the
// sub-interface this class actually uses (`request` only). Structural
// typing lets the bridge factory pass the full mediator instance
// without a cast; test stubs only need to fake the `request` method.
import type { PermissionMediator } from './permission.js';
import type {
  PermissionRequestRecord,
  PermissionResolution,
} from './permission.js';
import { CancelSentinelCollisionError } from './bridgeErrors.js';
import { writeStderrLine } from './internal/stderrLine.js';

/**
 * Duck-type check for `FsError` from `cli/src/serve/fs/errors.ts`.
 * FsError lives in `cli`, but this class lives in `acp-bridge` — a
 * direct import would invert the dependency. Uses `.name`-based duck
 * typing (same pattern as `mapDomainErrorToErrorKind` in status.ts).
 *
 * Without this: when the `BridgeFileSystem` adapter throws an
 * `FsError`, the ACP SDK's default RPC error path serializes only
 * `error.message` — the structured `kind` / `status` / `hint` are
 * lost. With this: the bridge catches FsError and rethrows as ACP
 * `RequestError(-32603, message, {errorKind, hint, status})` so the
 * agent's RPC client can branch on `data.errorKind`.
 */
interface FsErrorShape {
  name: 'FsError';
  message: string;
  kind: string;
  status?: number;
  hint?: string;
}

function isFsErrorShape(err: unknown): err is FsErrorShape {
  return (
    err instanceof Error &&
    err.name === 'FsError' &&
    typeof (err as { kind?: unknown }).kind === 'string'
  );
}

/**
 * Rethrow an FsError as a structured ACP `RequestError` so the
 * agent's RPC client sees `data.errorKind` / `data.hint` /
 * `data.status` rather than just the human-readable message.
 * Non-FsError errors are rethrown unchanged — the default ACP
 * serialization is fine for unstructured errors.
 */
function preserveFsErrorOverAcp(err: unknown): never {
  if (isFsErrorShape(err)) {
    throw new RequestError(-32603, err.message, {
      errorKind: err.kind,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
      ...(err.status !== undefined ? { status: err.status } : {}),
    });
  }
  throw err;
}

/**
 * Translate the mediator's internal `PermissionResolution` to the
 * ACP-shaped `RequestPermissionResponse` the agent expects.
 * Voter-cancel, timeout, and session-closed all project to the same
 * `{outcome: 'cancelled'}` shape — the ACP wire frame doesn't
 * distinguish them. The audit log carries `decisionReason.type`
 * for forensic discrimination.
 */
function resolutionToAcpResponse(
  resolution: PermissionResolution,
): RequestPermissionResponse & Record<string, unknown> {
  if (resolution.kind === 'option') {
    return {
      outcome: { outcome: 'selected', optionId: resolution.optionId },
      ...(resolution.metadata ?? {}),
    };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Bounded buffering for ACP `extNotification` frames that arrive on
 * `BridgeClient` before the matching session has been registered in
 * `byId`. The bridge populates `byId` only AFTER `connection.newSession`
 * returns, but the child's MCP discovery runs INSIDE `newSession` and
 * may fire budget events synchronously before the response makes it
 * back. Without buffering, those frames are silently dropped.
 *
 * The triple bound (max sessions x max events per session x TTL)
 * caps worst-case heap retention even if a malicious / buggy child
 * spammed `extNotification` for sessionIds that never register:
 * 64 x 32 x ~200B = 400 KB total. TTL is generous (60s) so brief
 * scheduling pauses don't cause real warnings to be evicted.
 */
const MAX_EARLY_EVENT_SESSIONS = 64;
const MAX_EARLY_EVENTS_PER_SESSION = 32;
const MAX_SUGGESTION_LENGTH = 500;
const EARLY_EVENT_TTL_MS = 60_000;

// Known approval-mode ids accepted on the in-session `current_mode_update`
// demux path. Mirrors the `modeMap` keys in `Session.setMode` (CLI); an id
// outside this set is dropped before it fans out to SSE clients / the SDK
// reducer. Keep the two in lockstep. Exported so the bridge's reconcile and
// snapshot-seed paths apply the same enum backstop to agent-supplied mode ids.
export const KNOWN_APPROVAL_MODES: ReadonlySet<string> = new Set([
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
]);

/**
 * Human-readable label for a `fs.Stats` object's kind, used in the
 * `readTextFile` "not a regular file" rejection message (BX8YO).
 * Sockets, pipes, char-devices etc. all report `size: 0` but stream
 * unbounded data; the operator wants to know which one they hit so
 * the path-mistake is obvious.
 */
function describeStatKind(stats: import('node:fs').Stats): string {
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isFIFO()) return 'named pipe (FIFO)';
  if (stats.isSocket()) return 'socket';
  return 'non-regular file';
}

/**
 * Extract the line range `[startLine, endLine)` (0-based) from a string
 * without allocating a per-line array. Equivalent to
 * `content.split('\n').slice(startLine, endLine).join('\n')` but
 * O(file size) string scan rather than O(file size) string + O(line
 * count) array. Matters for the partial-read path of `readTextFile`
 * where the limit is small and the file is large.
 */
function sliceLineRange(
  content: string,
  startLine: number,
  endLine: number | undefined,
): string {
  // Find the byte offset where line `startLine` begins.
  let offset = 0;
  for (let i = 0; i < startLine; i++) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) return '';
    offset = nl + 1;
  }
  if (endLine === undefined) return content.slice(offset);
  // Walk `endLine - startLine` newlines forward to find the end byte.
  let end = offset;
  const want = endLine - startLine;
  for (let i = 0; i < want; i++) {
    const nl = content.indexOf('\n', end);
    if (nl === -1) return content.slice(offset);
    end = nl + 1;
  }
  // Trim the trailing `\n` so the slice mirrors `lines.slice(...).join('\n')`.
  return content.slice(offset, end > offset ? end - 1 : end);
}

/**
 * Minimal session-entry shape `BridgeClient` reads via its
 * `resolveEntry` callback. Defined here (rather than importing the
 * factory's richer `SessionEntry`) to keep the bridge package free of
 * daemon-host session-bookkeeping types: the factory's `SessionEntry`
 * structurally satisfies this interface, so no explicit conversion
 * is required.
 *
 * Only four fields cross the boundary: `sessionId`, `events`,
 * `pendingPermissionIds`, `activePromptOriginatorClientId`. New fields
 * BridgeClient grows must be added here too (and the factory's
 * `SessionEntry` is required to provide them — TS enforces the
 * structural match at the callback signature).
 */
/**
 * ACP ext-method the spawned `qwen --acp` child calls between tool batches to
 * pull user messages the browser queued mid-turn. Must match the constant in
 * `cli/src/acp-integration/session/Session.ts` (the caller). The desktop ACP
 * client answers the same method from its own in-memory queue; in `qwen serve`
 * the daemon answers it here, from `SessionEntry.midTurnMessageQueue`.
 */
const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';

/**
 * SSE frame published when mid-turn messages are actually drained into the
 * running turn. The browser consumes it to move those messages out of its
 * pending queue (so they aren't resent as the next turn) and render them as
 * sent. `data: { sessionId, messages: string[] }`.
 */
const MID_TURN_MESSAGE_INJECTED_EVENT = 'mid_turn_message_injected';

export interface BridgeClientSessionEntry {
  sessionId: string;
  events: EventBus;
  pendingPermissionIds: Set<string>;
  /**
   * Mid-turn user messages queued by the browser, drained here when the ACP
   * child calls the `craft/drainMidTurnQueue` ext-method. Owned by the full
   * `SessionEntry` in `bridge.ts`; surfaced on this narrowed view so
   * `extMethod` can splice it. See `SessionEntry.midTurnMessageQueue`.
   */
  midTurnMessageQueue: string[];
  activePromptOriginatorClientId?: string;
  /**
   * True while the bridge drives a model roundtrip; the
   * `current_model_update` extNotification demux reads it to suppress
   * promotion during a bridge-driven change. Set on the full `SessionEntry`
   * in `bridge.ts`; surfaced here for the demux.
   */
  modelRoundtripInFlight?: boolean;
  /** A2: mirrors `modelRoundtripInFlight` for approval-mode roundtrips. */
  approvalModeRoundtripInFlight?: boolean;
}

/**
 * Bridge `Client` implementation — the daemon's response surface for things
 * the agent asks the client (file reads/writes, permission prompts).
 *
 * Stage 1 behavior:
 *   - `requestPermission` publishes a `permission_request` event onto the
 *     session bus and awaits the first HTTP `POST /permission/:requestId`
 *     vote (first-responder wins). When the session is cancelled or the
 *     daemon shuts down, the pending promise resolves with
 *     `{ outcome: { outcome: 'cancelled' } }` per ACP spec.
 *   - `sessionUpdate` notifications publish onto the session's EventBus; SSE
 *     subscribers (`GET /session/:id/events`) drain it.
 *   - File reads/writes proxy to local fs (daemon and agent share the host).
 *
 * Stage 1 trust model: the spawned `qwen --acp` child runs as the same user
 * as the daemon, so the file-proxy methods do NOT enforce a workspace-cwd
 * sandbox. The agent could already read or write the same files via its
 * built-in tools (e.g. shell). Restricting the bridge here would be
 * theatre. Stage 4+ remote-sandbox deployments swap this `Client` for a
 * sandbox-aware variant.
 */
export class BridgeClient implements Client {
  constructor(
    /**
     * Look up the `SessionEntry` for an ACP call. Stage 1.5 multi-
     * session on one channel means `BridgeClient` is shared across
     * many sessions, so we can't bind the entry in a closure — we
     * dispatch by the `sessionId` ACP includes in every per-session
     * notification / request. `undefined` sessionId is the fallback
     * for ACP calls that don't carry one (none expected on the
     * client surface as of this writing) and resolves to whatever
     * the channel's most-recent entry is — kept defensive to avoid
     * silent drops if ACP grows a no-sessionId call.
     */
    private readonly resolveEntry: (
      sessionId?: string,
    ) => BridgeClientSessionEntry | undefined,
    private readonly resolvePendingRestoreEvents: (
      sessionId?: string,
    ) => EventBus | undefined,
    /** The multi-client permission coordinator. Owns ALL pending +
     * resolved permission state; this client just plumbs
     * `requestPermission` into `mediator.request` and forwards
     * the resolution to the agent. Strategy dispatch and audit/emit
     * fan-out live inside the mediator.
     */
    private readonly mediator: Pick<PermissionMediator, 'request'>,
    /**
     * Bd1yh: wall-clock ms before `requestPermission` resolves as
     * cancelled if no client vote arrives. 0 = disabled. Prevents
     * the per-session FIFO `promptQueue` from poisoning forever
     * when no SSE subscriber is connected. Forwarded directly to
     * `mediator.request`; the mediator owns the timer.
     */
    private readonly permissionTimeoutMs: number,
    /**
     * Bd1z5: per-session cap on in-flight permissions. New requests
     * past this cap resolve as cancelled with a stderr warning.
     * Infinity = disabled. The bridge keeps `entry.pendingPermissionIds`
     * as a fast cap-check index; the mediator is still the source of
     * truth for the pending registry.
     */
    private readonly maxPendingPerSession: number,
    /**
     * Optional fs injection seam. When provided, `writeTextFile` /
     * `readTextFile` delegate to this implementation instead of running
     * the inline `fs.realpath` / `fs.writeFile` / `fs.readFile` proxy
     * below. Production `qwen serve` wires a serve-side adapter
     * wrapping `WorkspaceFileSystem` here so writes get the TOCTOU +
     * symlink + trust-gate + audit machinery the inline proxy lacks.
     * Omitted by tests + Mode A in-process consumers + channels / IDE
     * companion — preserves the inline proxy behavior.
     */
    private readonly fileSystem?: BridgeFileSystem,
    /**
     * §2.3 callback: centralised `model_switched` publish through the
     * bridge factory's cache-updating helper. The BridgeClient calls
     * this instead of inlining `entry.events.publish(...)` so the
     * cache update + generation bump stays atomic in one place.
     */
    private readonly onModelPromoted?: (
      entry: BridgeClientSessionEntry,
      modelId: string,
      originatorClientId: string | undefined,
    ) => void,
    /**
     * §2.3 / A2 callback: centralised `approval_mode_changed` publish.
     * Called by the A2 `current_mode_update` demux when the agent
     * switches approval mode in-session (exit_plan_mode, ProceedAlways,
     * /mode). `previous` is read from the bridge state cache.
     */
    private readonly onModePromoted?: (
      entry: BridgeClientSessionEntry,
      modeId: string,
      originatorClientId: string | undefined,
    ) => void,
  ) {}

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const entry = this.resolveEntry(params.sessionId);
    if (!entry) return { outcome: { outcome: 'cancelled' } };

    // Bd1z5: per-session cap. Reject before issuing so we never
    // grow `pendingPermissionIds` past the limit.
    if (entry.pendingPermissionIds.size >= this.maxPendingPerSession) {
      writeStderrLine(
        `qwen serve: session ${entry.sessionId} exceeded ` +
          `maxPendingPermissionsPerSession (${this.maxPendingPerSession}) — ` +
          `resolving new permission as cancelled.`,
      );
      return { outcome: { outcome: 'cancelled' } };
    }

    // BkwQI: snapshot the option-id set the agent is offering for
    // this prompt. The mediator validates the voter's `optionId`
    // against this set so a malicious client can't forge an option
    // (e.g. `ProceedAlways*`) the agent intentionally hid.
    const allowedOptionIds = new Set(
      params.options.map((o: { optionId?: unknown }) =>
        String(o.optionId ?? ''),
      ),
    );
    allowedOptionIds.delete('');

    // Pre-flight the cancel-vote sentinel collision BEFORE publishing
    // the `permission_request` SSE event. The mediator also checks
    // defensively at issue time, but if we publish first and the
    // mediator throws, SSE subscribers see an orphan event with no
    // resolution.
    const requestId = randomUUID();
    if (allowedOptionIds.has(CANCEL_VOTE_SENTINEL)) {
      throw new CancelSentinelCollisionError(requestId, CANCEL_VOTE_SENTINEL);
    }

    // Publish AFTER the collision check so a violating agent never
    // leaves an orphan `permission_request` on the SSE bus. If the
    // bus is closed (shutdown race), bail before touching the
    // mediator. The mediator's N1 invariant (synchronous register
    // inside the Promise executor) protects against the
    // forgetSession-races-with-issue case ONLY when register runs;
    // refusing to enter the mediator on a publish-failure is the
    // symmetric defense for the publish-failure case.
    const published = entry.events.publish({
      type: 'permission_request',
      data: {
        requestId,
        sessionId: entry.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      },
      ...(entry.activePromptOriginatorClientId
        ? { originatorClientId: entry.activePromptOriginatorClientId }
        : {}),
    });
    if (!published) return { outcome: { outcome: 'cancelled' } };

    // Cap-index add happens AFTER publish-success so a publish-fail
    // path doesn't need to roll back. The mediator's
    // `forgetSession` is the only thing that drains this index (via
    // the bridge's `cancelPendingForSession`).
    entry.pendingPermissionIds.add(requestId);
    try {
      const record: PermissionRequestRecord = {
        requestId,
        sessionId: entry.sessionId,
        originatorClientId: entry.activePromptOriginatorClientId,
        allowedOptionIds,
        issuedAtMs: Date.now(),
      };
      const resolution = await this.mediator.request(
        record,
        this.permissionTimeoutMs,
      );
      return resolutionToAcpResponse(resolution);
    } finally {
      entry.pendingPermissionIds.delete(requestId);
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const entry = this.resolveEntry(params.sessionId);
    const events =
      entry?.events ?? this.resolvePendingRestoreEvents(params.sessionId);
    if (!events) return;
    const originator = entry?.activePromptOriginatorClientId
      ? { originatorClientId: entry.activePromptOriginatorClientId }
      : {};
    // A2UI-over-MCP: tool_call_update results from an A2UI UI server carry
    // the A2UI command JSON flattened by core (EmbeddedResource -> text, the
    // application/a2ui+json mime is dropped, so detection keys off the
    // server/tool identity). Extract the commands, publish them as a separate
    // `sessionUpdate:'a2ui'` frame for renderer clients, and sanitize the
    // original tool frame so raw command JSON never reaches transcripts/SSE.
    const a2ui = extractA2uiToolUpdate(params);
    if (a2ui) {
      // One frame per surface: tool results carrying commands for multiple
      // surfaces are split so every consumer sees a single-surface frame.
      for (const surface of a2ui.surfaces) {
        events.publish({
          type: 'session_update',
          data: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'a2ui',
              a2ui: {
                surfaceId: surface.surfaceId,
                callId: a2ui.callId,
                commands: surface.commands,
              },
              _meta: { serverTimestamp: Date.now(), source: 'a2ui-bridge' },
            },
          },
          ...originator,
        });
      }
      params = a2ui.sanitizedParams;
    }
    // History replay re-emits each persisted record carrying its ORIGINAL
    // wall-clock time as an epoch-ms `timestamp` nested in `update._meta` (set
    // by the message/tool emitters). Lift it to the envelope-level
    // `serverTimestamp` so `EventBus.publish` preserves it instead of stamping
    // publish-time `Date.now()` — otherwise a resumed session renders every
    // historical message at the resume moment instead of when it was sent.
    // Live updates without such a timestamp pass no envelope `_meta` and keep
    // the EventBus `Date.now()` fallback unchanged.
    const updateMeta = (params.update as { _meta?: Record<string, unknown> })
      ._meta;
    const originalTs =
      updateMeta?.['serverTimestamp'] ?? updateMeta?.['timestamp'];
    const serverTimestamp =
      typeof originalTs === 'number' && Number.isFinite(originalTs)
        ? originalTs
        : undefined;
    events.publish({
      type: 'session_update',
      data: params,
      ...originator,
      ...(serverTimestamp !== undefined ? { _meta: { serverTimestamp } } : {}),
    });
  }

  /**
   * Bounded early-event buffer. Frames are keyed by sessionId; each
   * entry tracks its `expiresAt` for lazy TTL-based eviction in
   * `bufferEarlyEvent`. Drained by `drainEarlyEvents` whenever the
   * bridge registers a session with a matching id. See
   * MAX_EARLY_EVENT_* constants for capacity bounds.
   */
  private readonly earlyEvents = new Map<
    string,
    {
      frames: Array<Omit<BridgeEvent, 'id' | 'v'>>;
      expiresAt: number;
    }
  >();

  /**
   * Tombstone for closed/killed session ids. Prevents late
   * `extNotification` from a dying child from leaking into the
   * early-event buffer and being replayed onto a future session
   * that reuses the same id via `session/load` or `session/resume`.
   *
   * Tombstone semantics:
   * - Marked when the bridge removes a sessionId from `byId` (kill
   *   path, channel.exited handler, closeSession).
   * - Concurrently purges any in-flight `earlyEvents[id]`.
   * - `bufferEarlyEvent` rejects tombstoned ids.
   * - `drainEarlyEvents` clears the tombstone — a fresh
   *   `createSessionEntry` for the same id is a legitimate
   *   "load/resume of a persisted session id" case.
   * - TTL = `EARLY_EVENT_TTL_MS` (60s) — same as the early-event
   *   buffer, so by the time a tombstone expires there can be no
   *   stale frame for that id anywhere in the system.
   */
  private readonly tombstonedSessionIds = new Map<string, number>();

  /**
   * Allow-list of sessionIds currently being restored via
   * `session/load` / `session/resume`. Bypasses the tombstone check
   * in `bufferEarlyEvent` so restore-time guardrail events for a
   * previously-closed id flow through to the future
   * `createSessionEntry -> drainEarlyEvents` call.
   *
   * Without this, the tombstone set before a future `load` can clear
   * it via `drainEarlyEvents` would silently drop legitimate
   * restore-time events (e.g. MCP discovery budget events firing
   * during the ACP call window).
   *
   * Bridge factory enters the set before awaiting the ACP restore
   * call and exits on settle (success or failure).
   */
  private readonly inFlightRestoreIds = new Set<string>();

  /**
   * Handle child->bridge ACP `extMethod` requests (calls that expect a
   * response, unlike `extNotification`). The only method served today is
   * `craft/drainMidTurnQueue`: the ACP child calls it between tool batches to
   * pull any messages the browser queued mid-turn. We splice the per-session
   * queue, return them to the child as the response, and — when non-empty —
   * publish a `mid_turn_message_injected` SSE frame so the browser can move
   * those messages out of its pending queue and render them as sent. Unknown
   * methods reject with ACP `methodNotFound` (-32601), matching the SDK's
   * default for an unimplemented client surface; the child's drain caller
   * treats that as "drain unsupported" and stops asking.
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method !== MID_TURN_QUEUE_DRAIN_METHOD) {
      throw RequestError.methodNotFound(method);
    }
    const sessionId =
      typeof params['sessionId'] === 'string'
        ? (params['sessionId'] as string)
        : undefined;
    // The drain always carries a sessionId; without one we can't route it on a
    // multi-session channel (and `resolveEntry(undefined)` would throw there),
    // so answer with an empty drain rather than poisoning the turn.
    if (!sessionId) return { messages: [] };
    const entry = this.resolveEntry(sessionId);
    if (!entry) return { messages: [] };
    const messages = entry.midTurnMessageQueue.splice(0);
    if (messages.length > 0) {
      try {
        entry.events.publish({
          type: MID_TURN_MESSAGE_INJECTED_EVENT,
          data: { sessionId: entry.sessionId, messages },
        });
      } catch {
        // Bus already closed (session tearing down). The child still receives
        // the messages below; only the browser-side echo is lost.
      }
    }
    return { messages };
  }

  /**
   * Handle child->bridge ACP `extNotification` calls. Six methods are
   * recognized — `qwen/notify/session/model-update`,
   * `qwen/notify/session/mode-update`,
   * `qwen/notify/session/title-update` (auto/in-process session titles),
   * `qwen/notify/session/prompt-suggestion` (followup assist),
   * `qwen/notify/session/terminal-sequence`, and
   * `qwen/notify/session/mcp-budget-event` — each translated into a
   * session-scoped SSE frame. Unknown methods are dropped silently
   * for forward-compat.
   */
  async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'qwen/notify/session/model-update') {
      this.handleInSessionModelUpdate(params);
      return;
    }
    if (method === 'qwen/notify/session/mode-update') {
      this.handleInSessionModeUpdate(params);
      return;
    }
    if (method === 'qwen/notify/session/title-update') {
      // Child-side title updates (auto-generated titles land in the child's
      // chat recording — the bridge never sees the write) are rebroadcast as
      // the canonical `session_metadata_updated` envelope, the same event
      // manual HTTP renames publish, so clients have ONE signal for
      // "this session's name changed".
      const sessionId = params['sessionId'];
      const title = params['title'];
      if (typeof sessionId !== 'string' || typeof title !== 'string' || !title)
        return;
      const entry = this.resolveEntry(sessionId);
      if (!entry) return;
      try {
        entry.events.publish({
          type: 'session_metadata_updated',
          data: {
            sessionId,
            displayName: title,
            ...(typeof params['titleSource'] === 'string'
              ? { titleSource: params['titleSource'] }
              : {}),
          },
        });
      } catch {
        /* bus already closed */
      }
      return;
    }
    if (method === 'qwen/notify/session/prompt-suggestion') {
      const sessionId = params['sessionId'];
      const suggestion = params['suggestion'];
      const promptId = params['promptId'];
      if (
        typeof sessionId !== 'string' ||
        typeof suggestion !== 'string' ||
        suggestion.length === 0 ||
        suggestion.length > MAX_SUGGESTION_LENGTH ||
        typeof promptId !== 'string'
      ) {
        writeStderrLine(
          `[demux] session=${typeof sessionId === 'string' ? sessionId : '<missing>'} type=prompt_suggestion action=dropped reason=malformed`,
        );
        return;
      }
      const entry = this.resolveEntry(sessionId);
      if (!entry) return;
      entry.events.publish({
        type: 'followup_suggestion',
        data: { sessionId, suggestion, promptId },
      });
      return;
    }
    if (method === 'qwen/notify/session/terminal-sequence') {
      const sessionId = params['sessionId'];
      if (typeof sessionId !== 'string') return;
      const { v: _v, sessionId: _sid, ...rest } = params;
      void _v;
      void _sid;
      this.publishExtNotification(sessionId, 'terminal_sequence', rest);
      return;
    }
    if (method !== 'qwen/notify/session/mcp-budget-event') return;
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    const kind = params['kind'];
    let type: string;
    if (kind === 'budget_warning') {
      type = 'mcp_budget_warning';
    } else if (kind === 'refused_batch') {
      type = 'mcp_child_refused_batch';
    } else {
      return;
    }
    // Strip the routing fields (`v`, `sessionId`, `kind`) from the
    // outbound `data` payload — the SSE frame already carries `v` at
    // the envelope level (`EVENT_SCHEMA_VERSION`) and the session id
    // is implicit from the endpoint, so duplicating them in `data`
    // would be noise. `kind` is encoded as the frame `type`.
    const { v: _v, sessionId: _sid, kind: _kind, ...rest } = params;
    void _v;
    void _sid;
    void _kind;
    this.publishExtNotification(sessionId, type, rest);
  }

  private publishExtNotification(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const entry = this.resolveEntry(sessionId);
    const frame: Omit<BridgeEvent, 'id' | 'v'> = {
      type,
      data,
      ...(entry?.activePromptOriginatorClientId
        ? { originatorClientId: entry.activePromptOriginatorClientId }
        : {}),
    };
    if (entry) {
      entry.events.publish(frame);
      return;
    }
    // No entry yet — buffer for `drainEarlyEvents`. The bridge calls
    // `drainEarlyEvents` immediately after `byId.set(sessionId, entry)`
    // in `createSessionEntry`; if the session never registers (spawn
    // failure), the entry is GC'd by TTL after EARLY_EVENT_TTL_MS.
    this.bufferEarlyEvent(sessionId, frame);
  }

  /**
   * Promote an in-session `current_model_update` extNotification to a
   * `model_switched` bus event. Suppressed while the bridge is driving
   * its own model roundtrip (`entry.modelRoundtripInFlight`) — there the
   * bridge publishes the authoritative `model_switched`, so promoting
   * here too would double-publish. A structured log records the decision
   * so the `dropped` case is observable.
   */
  private handleInSessionModelUpdate(params: Record<string, unknown>): void {
    const sessionId = params['sessionId'];
    const currentModelId = params['currentModelId'];
    if (typeof sessionId !== 'string' || typeof currentModelId !== 'string') {
      return;
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      // No live session — a model switch only happens on an established
      // session, so unlike the MCP-budget path there is nothing to buffer.
      writeStderrLine(
        `[demux] session=${sessionId} type=current_model_update action=dropped reason=no_entry`,
      );
      return;
    }
    if (entry.modelRoundtripInFlight) {
      // Bridge owns this change and will publish model_switched itself.
      writeStderrLine(
        `[demux] session=${sessionId} type=current_model_update action=suppressed reason=bridge_roundtrip_in_flight`,
      );
      return;
    }
    if (this.onModelPromoted) {
      this.onModelPromoted(
        entry,
        currentModelId,
        entry.activePromptOriginatorClientId,
      );
    } else {
      // `EventBus.publish` never throws (closed bus → undefined no-op); per
      // its documented contract we don't wrap it.
      entry.events.publish({
        type: 'model_switched',
        data: { sessionId, modelId: currentModelId },
        ...(entry.activePromptOriginatorClientId
          ? { originatorClientId: entry.activePromptOriginatorClientId }
          : {}),
      });
    }
    writeStderrLine(
      `[demux] session=${sessionId} type=current_model_update action=promoted model=${currentModelId}`,
    );
  }

  /**
   * A2: promote an in-session `current_mode_update` extNotification to
   * `approval_mode_changed`. Uses the same suppression pattern as
   * `handleInSessionModelUpdate` — suppressed while the bridge is driving
   * its own approval-mode roundtrip (`entry.approvalModeRoundtripInFlight`)
   * — but diverges with two additions the model handler lacks: enum
   * validation against `KNOWN_APPROVAL_MODES`, and a legacy
   * `session_update{current_mode_update}` dual-emit for IDE companion
   * compat (transition — see §6 of the design doc), itself deduped via the
   * `legacyFrameSent` flag.
   */
  private handleInSessionModeUpdate(params: Record<string, unknown>): void {
    const sessionId = params['sessionId'];
    const currentModeId = params['currentModeId'];
    if (typeof sessionId !== 'string' || typeof currentModeId !== 'string') {
      return;
    }
    // Validate against the known approval-mode enum before it fans out.
    // `Session.setMode` guards the symmetric send path with the same set
    // ("an unknown id would call setApprovalMode(undefined), leaving the
    // permission system undefined"); this is the receive path the agent
    // can reach without that validation, so an unknown id here would
    // propagate through `approval_mode_changed` to every SSE client and
    // land in the SDK reducer's `state.approvalMode`. Keep in lockstep
    // with `Session.setMode`'s `modeMap` keys (includes `auto`).
    if (!KNOWN_APPROVAL_MODES.has(currentModeId)) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=dropped reason=unknown_mode mode=${currentModeId}`,
      );
      return;
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=dropped reason=no_entry`,
      );
      return;
    }
    if (entry.approvalModeRoundtripInFlight) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=suppressed reason=bridge_roundtrip_in_flight`,
      );
      return;
    }
    if (this.onModePromoted) {
      this.onModePromoted(
        entry,
        currentModeId,
        entry.activePromptOriginatorClientId,
      );
    } else {
      // Fallback path (no `onModePromoted` injected — tests / non-bridge
      // consumers; production always wires the bridge callback). Mirror
      // the main path's full payload: the SDK's
      // `isApprovalModeChangedData` requires `previous` (non-empty
      // string) and `persisted` (boolean), so a `{ sessionId, next }`
      // shape fails validation and `asKnownDaemonEvent` drops the event.
      // `previous` is unavailable on this path (the cache lives on the
      // bridge's `SessionEntry`, not the demux interface), so seed it
      // with the protocol default.
      //
      // `EventBus.publish` never throws (a closed bus is a return-undefined
      // no-op and subscriber-enqueue failures are caught internally), so
      // per its documented contract we don't wrap it in try/catch.
      entry.events.publish({
        type: 'approval_mode_changed',
        data: {
          sessionId,
          previous: 'default',
          next: currentModeId,
          persisted: false,
        },
        ...(entry.activePromptOriginatorClientId
          ? { originatorClientId: entry.activePromptOriginatorClientId }
          : {}),
      });
    }
    // TODO(dual-emit-removal): also emit the legacy generic
    // `session_update{current_mode_update}` for one release cycle so the
    // VS Code IDE companion's existing `case 'current_mode_update'`
    // handler keeps working. Remove this block (and its tracking issue)
    // once the companion ships an `approval_mode_changed` handler.
    //
    // Skip it when the producer already sent the legacy frame itself: the
    // `exit_plan_mode` path (`Session.sendCurrentModeUpdateNotification`)
    // calls `sendUpdate` before this extNotification, which
    // `BridgeClient.sessionUpdate` already fanned onto the bus as the same
    // `session_update{current_mode_update}` frame. Dual-emitting here would
    // deliver it twice. The `setMode` path omits the flag (it has no
    // `sendUpdate`), so its dual-emit still fires.
    //
    // Use the canonical ACP-nested shape (`data.update.sessionUpdate`),
    // matching what `BridgeClient.sessionUpdate` publishes for a real
    // `current_mode_update` notification. A flat
    // `{ sessionId, sessionUpdate, currentModeId }` would (a) not be
    // recognised by the companion's standard `data.update.sessionUpdate`
    // switch, and (b) collide structurally with the real `session_update`
    // the agent already emits on the `exit_plan_mode` path — leaving two
    // incompatible shapes on the bus for one change.
    if (params['legacyFrameSent'] === true) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=promoted mode=${currentModeId} legacy_frame=skipped`,
      );
      return;
    }
    // `EventBus.publish` never throws (closed bus → undefined no-op); per its
    // documented contract we don't wrap it in try/catch.
    entry.events.publish({
      type: 'session_update',
      data: {
        sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId,
        },
      },
      ...(entry.activePromptOriginatorClientId
        ? { originatorClientId: entry.activePromptOriginatorClientId }
        : {}),
    });
    writeStderrLine(
      `[demux] session=${sessionId} type=current_mode_update action=promoted mode=${currentModeId}`,
    );
  }

  /**
   * Enqueue `frame` for `sessionId`. Lazy TTL sweep runs first so
   * caller doesn't pay for stale entries before deciding whether
   * the session-cap is reached. New sessionIds past
   * `MAX_EARLY_EVENT_SESSIONS` are dropped (defense against a
   * malicious / buggy child fanning out fake sessionIds); same-
   * sessionId frames past `MAX_EARLY_EVENTS_PER_SESSION` are
   * dropped to bound per-session memory.
   */
  private bufferEarlyEvent(
    sessionId: string,
    frame: Omit<BridgeEvent, 'id' | 'v'>,
  ): void {
    const now = Date.now();
    // Drop frames for ids the bridge has already marked closed/killed.
    // Sweep + check before any other work so a malicious / buggy child
    // can't keep appending post-mortem frames against an old id. Live
    // ids that re-register (load/resume) clear their tombstone in
    // `drainEarlyEvents`.
    //
    // Skip the tombstone check for ids currently being restored so a
    // `close -> load same id` sequence within 60s doesn't lose
    // restore-time guardrail events.
    this.sweepExpiredTombstones(now);
    if (
      this.tombstonedSessionIds.has(sessionId) &&
      !this.inFlightRestoreIds.has(sessionId)
    ) {
      writeStderrLine(
        `qwen serve: dropping mcp guardrail extNotification ` +
          `for tombstoned session ${JSON.stringify(sessionId)} ` +
          `(post-close stale event)`,
      );
      return;
    }
    this.sweepExpiredEarlyEvents(now);
    let buf = this.earlyEvents.get(sessionId);
    if (!buf) {
      if (this.earlyEvents.size >= MAX_EARLY_EVENT_SESSIONS) {
        // Hitting this cap means the daemon is under notification
        // pressure from 64+ concurrent sessions — worth surfacing.
        writeStderrLine(
          `qwen serve: dropping mcp guardrail extNotification — ` +
            `early-event buffer at MAX_EARLY_EVENT_SESSIONS ` +
            `(${MAX_EARLY_EVENT_SESSIONS}); possible session-id fanout abuse`,
        );
        return;
      }
      buf = { frames: [], expiresAt: now + EARLY_EVENT_TTL_MS };
      this.earlyEvents.set(sessionId, buf);
    }
    if (buf.frames.length >= MAX_EARLY_EVENTS_PER_SESSION) {
      writeStderrLine(
        `qwen serve: dropping mcp guardrail extNotification ` +
          `for session ${JSON.stringify(sessionId)} — per-session ` +
          `cap (${MAX_EARLY_EVENTS_PER_SESSION}) reached`,
      );
      return;
    }
    buf.frames.push(frame);
  }

  private sweepExpiredEarlyEvents(now: number): void {
    for (const [sid, buf] of this.earlyEvents) {
      if (buf.expiresAt <= now) this.earlyEvents.delete(sid);
    }
  }

  private sweepExpiredTombstones(now: number): void {
    for (const [sid, expiresAt] of this.tombstonedSessionIds) {
      if (expiresAt <= now) this.tombstonedSessionIds.delete(sid);
    }
  }

  /**
   * Mark a sessionId as closed so a late `extNotification` from the
   * dying child can't leak into the early-event buffer. Bridge factory
   * calls this from every `byId.delete(sid)` site (kill path,
   * channel.exited handler, closeSession). Idempotent on already-
   * tombstoned ids — refreshes the TTL so a recently-killed id stays
   * dead long enough for any in-flight stale frames to expire.
   */
  markSessionClosed(sessionId: string): void {
    const now = Date.now();
    // Bound `tombstonedSessionIds` under session churn. On a daemon
    // that closes/kills many sessions but rarely receives
    // extNotifications, the map would grow monotonically without this
    // sweep. O(map size) but cheap (one integer compare per entry);
    // under any realistic workload the map stays small.
    this.sweepExpiredTombstones(now);
    this.tombstonedSessionIds.set(sessionId, now + EARLY_EVENT_TTL_MS);
    // Purge any frames already buffered for this id — they're now
    // stale by definition (their session is dead).
    this.earlyEvents.delete(sessionId);
  }

  /**
   * Mark a sessionId as currently being restored via `session/load` /
   * `session/resume`. While in this set, `bufferEarlyEvent` accepts
   * frames for the id even if it's tombstoned — so restore-time
   * guardrail events from the freshly-restored child reach
   * `drainEarlyEvents` instead of being rejected by the tombstone.
   *
   * Bridge factory calls this BEFORE awaiting the ACP restore call.
   * `clearRestoreInFlight` is paired in the matching `finally` so a
   * failed restore doesn't leave a dangling allow-list entry.
   */
  markRestoreInFlight(sessionId: string): void {
    this.inFlightRestoreIds.add(sessionId);
  }

  /**
   * Companion to `markRestoreInFlight`. Bridge factory calls this when
   * the restore IIFE settles — after `createSessionEntry` runs
   * (success) or after the ACP restore call fails (error). Cleared to
   * prevent the Set from growing forever under high restore churn.
   */
  clearRestoreInFlight(sessionId: string): void {
    this.inFlightRestoreIds.delete(sessionId);
  }

  /**
   * Drain any frames buffered for `sessionId` onto `entry.events`.
   * Bridge calls this immediately after `byId.set(sessionId, entry)`
   * in `createSessionEntry`. The frames were captured before the
   * entry existed (e.g. MCP discovery during the child's `newSession`
   * handler), so draining them now lands them in the replay ring as
   * the FIRST events of this session.
   *
   * Public so the bridge factory can call it directly. Idempotent on
   * unknown sessionIds.
   */
  drainEarlyEvents(sessionId: string, entry: BridgeClientSessionEntry): void {
    // A fresh registration clears any tombstone for this id — this is
    // the legitimate "load/resume of a persisted session id" case.
    // Any stale pre-tombstone frame was already rejected by
    // `bufferEarlyEvent`; clearing the tombstone now means subsequent
    // notifications flow through the normal `entry.events.publish`
    // path.
    this.tombstonedSessionIds.delete(sessionId);
    const buf = this.earlyEvents.get(sessionId);
    if (!buf) return;
    for (const frame of buf.frames) entry.events.publish(frame);
    this.earlyEvents.delete(sessionId);
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    // Delegate to the injected `BridgeFileSystem` when present.
    // Production `qwen serve` wires `WorkspaceFileSystem` through a
    // serve-side adapter so writes get the trust-gate + TOCTOU +
    // symlink + `.gitignore` + audit machinery the inline proxy below
    // lacks. Tests, Mode A consumers, channels, and IDE companion
    // fall through to the inline path.
    if (this.fileSystem) {
      // Preserve FsError structure over ACP wire. Without this catch,
      // an `FsError({kind:'untrusted_workspace'})` from the adapter
      // would land at the agent with the kind/status/hint stripped.
      // See `preserveFsErrorOverAcp` for rationale.
      try {
        return await this.fileSystem.writeText(params);
      } catch (err) {
        preserveFsErrorOverAcp(err);
      }
    }
    // Stage 1 known divergence: this raw `fs.writeFile` reimplements file
    // I/O instead of delegating to core's filesystem service. The
    // user-visible scenarios where they differ:
    //   - BOM handling: this drops/re-encodes whatever the agent passed;
    //     core would preserve.
    //   - Non-UTF-8 source files: round-tripping through utf8 mangles
    //     content.
    //   - Original line endings: core preserves CRLF on Windows files;
    //     this writes whatever the agent buffered.
    // Wiring core's FileSystemService through the bridge requires
    // exposing it as a constructor dep; the cost-benefit is low for
    // Stage 1 (most agent-side tools call core directly, NOT through
    // these ACP fs methods) and Stage 2 in-process eliminates the
    // bridge fs proxy entirely. Tracked as a Stage 2 prerequisite —
    // the `BridgeFileSystem` injection addresses exactly this seam.
    //
    // BSA0D: write-then-rename so a SIGKILL / OOM mid-write doesn't
    // leave the target truncated. POSIX `rename` is atomic within the
    // same filesystem; on Windows it's atomic when the target doesn't
    // exist (we tolerate the race-on-overwrite case as a Stage 2
    // gap). The tmp file lives in the same directory so the rename
    // can't cross filesystem boundaries (which would degrade to a
    // copy + race re-emerges).
    //
    // BX8Yw: rename would replace a symlink at the target path with a
    // regular file, leaving the original symlink target unchanged
    // while the write appears successful. Resolve symlinks via
    // `realpath` first so the atomic write lands at the actual file.
    //
    // BfFvO: dangling-symlink case — `realpath` throws ENOENT when
    // the symlink's target doesn't exist. A blanket catch then
    // silently falls back to `params.path` (the symlink itself), and
    // `rename(tmp, params.path)` would replace the symlink with a
    // regular file — exactly the bug BX8Yw was supposed to fix.
    // Distinguish "path doesn't exist at all" (truly new file →
    // write through) from "dangling symlink" (symlink exists, target
    // doesn't → write through to the symlink's intended target so
    // the symlink stays a symlink and points at a fresh file).
    let realTarget = params.path;
    try {
      realTarget = await fs.realpath(params.path);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw err;
      // realpath ENOENT can mean (a) path doesn't exist at all, or
      // (b) the path is a symlink whose target doesn't exist. Use
      // `readlink` to disambiguate. If it succeeds we've got a
      // dangling symlink → resolve its target manually so the
      // subsequent rename creates the target instead of replacing
      // the symlink.
      try {
        const linkTarget = await fs.readlink(params.path);
        realTarget = path.resolve(path.dirname(params.path), linkTarget);
      } catch {
        // readlink also failed → truly non-existent path → write
        // through to the original (it'll be created).
      }
    }
    // BX8Yp + BX9_h: temp filename must include random bytes —
    // PID+ms alone collides under `sessionScope: 'thread'` (two
    // concurrent sessions writing the same path in the same ms) AND
    // can collide between concurrent prompts in one session. Add a
    // UUID and create exclusively (`flag: 'wx'`) so any residual
    // collision fails before content is overwritten.
    const tmp = `${realTarget}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    // BkwQW: preserve the existing target's mode bits (and owner/group
    // where possible) so editing a `0600` secret doesn't downgrade
    // it to `0644` via the process umask, and an executable file
    // doesn't lose its `+x` bit. Snapshot before write — if the
    // target doesn't exist yet, `preserveMode` stays undefined and
    // the new file gets the `0o600` default applied at the
    // `fs.writeFile` call below (NOT umask defaults — the explicit
    // `mode` argument bypasses umask for atomicity, see the `Blehd`
    // comment on `writeFile` for why).
    let preserveMode: { mode: number; uid: number; gid: number } | undefined;
    try {
      const targetStat = await fs.stat(realTarget);
      preserveMode = {
        mode: targetStat.mode & 0o7777,
        uid: targetStat.uid,
        gid: targetStat.gid,
      };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw err;
      // New file — leave `preserveMode` undefined; the writeFile call
      // below substitutes the `0o600` default via `?? 0o600`.
    }
    try {
      // Blehd: pass `mode` to `writeFile` so the temp file is
      // CREATED with the preserved mode (atomically, via the
      // syscall's open(O_CREAT, mode)). The previous "create with
      // umask defaults → chmod after" had a window where a `0600`
      // secret-edit existed at `0644` on disk before chmod ran,
      // briefly readable by anyone with directory access. Passing
      // `mode` shrinks that window to "doesn't exist". On Windows
      // the mode bits are mostly ignored by the OS; that's fine
      // since the platform has no equivalent threat model here.
      await fs.writeFile(tmp, params.content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: preserveMode?.mode ?? 0o600,
      });
      if (preserveMode) {
        // `writeFile`'s `mode` option is `mode & ~umask` on POSIX,
        // so a tight umask (e.g. operator's shell `umask 077` for
        // 0o600 default) could still drop bits we wanted preserved.
        // Belt-and-suspenders chmod brings the file to EXACTLY the
        // target's preserved mode regardless of umask interference.
        await fs.chmod(tmp, preserveMode.mode).catch(() => {
          /* chmod failed (Windows / fs without permission bits) */
        });
        // chown is owner-restricted on POSIX; non-root daemons hit
        // EPERM here. Silent ignore — preserving mode is the
        // first-order goal, ownership is a stretch goal.
        await fs.chown(tmp, preserveMode.uid, preserveMode.gid).catch(() => {
          /* expected EPERM for non-root operators */
        });
      }
      await fs.rename(tmp, realTarget);
    } catch (err) {
      // Best-effort cleanup if the write succeeded but rename failed
      // (e.g. permission change between calls). Swallow cleanup
      // errors — the original failure is the meaningful one.
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return {};
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    // Delegate to the injected `BridgeFileSystem` when present
    // (parallels the write path above). Production `qwen serve` wires
    // `WorkspaceFileSystem` adapter; tests + Mode A + channels + IDE
    // companion fall through to the inline proxy below.
    if (this.fileSystem) {
      // Preserve FsError structure over ACP wire.
      // See sibling block in `writeTextFile` for rationale.
      try {
        return await this.fileSystem.readText(params);
      } catch (err) {
        preserveFsErrorOverAcp(err);
      }
    }
    // Reject obviously-degenerate `limit` up front. Without this,
    // `sliceLineRange` hits the `end < start` path and returns an
    // unexpectedly-larger slice (or empty depending on internals).
    // ACP doesn't define semantics for limit ≤ 0, so treat as "no
    // bytes wanted".
    if (typeof params.limit === 'number' && params.limit <= 0) {
      return { content: '' };
    }
    // BSA0E: cap the file size we'll buffer into RSS at 100 MiB so a
    // request like `{ line: 1, limit: 10 }` against a 500 MB log
    // doesn't cost the daemon 500 MB of memory just to return 10
    // lines. Stage 2's in-process refactor will replace this proxy
    // with a streaming readline implementation that stops at the
    // requested range; until then the cap is the cheapest defense.
    //
    // BX8YO: also reject non-regular files. Character devices, named
    // pipes (FIFOs), procfs / sysfs entries, sockets etc. can report
    // `stats.size === 0` while producing unbounded data on read, so
    // a size-only cap doesn't protect against `/dev/zero` /
    // `/dev/urandom` / `/proc/kcore`-style inputs. ACP's contract
    // for `readTextFile` is "regular file"; everything else is an
    // operator-supplied path mistake or an adversarial-prompt
    // attempt and should fail loud.
    const READ_FILE_SIZE_CAP = 100 * 1024 * 1024;
    const stats = await fs.stat(params.path);
    if (!stats.isFile()) {
      throw new Error(
        `readTextFile: ${params.path} is not a regular file ` +
          `(reported as ${describeStatKind(stats)}). ` +
          `Pipe / device / proc-like inputs can produce unbounded data ` +
          `and aren't supported by the bridge fs proxy.`,
      );
    }
    if (stats.size > READ_FILE_SIZE_CAP) {
      throw new Error(
        `readTextFile: ${params.path} is ${stats.size} bytes, ` +
          `exceeds the ${READ_FILE_SIZE_CAP}-byte daemon cap. ` +
          `Tail/grep externally and feed the relevant slice instead.`,
      );
    }
    const content = await fs.readFile(params.path, 'utf8');
    if (typeof params.line === 'number' || typeof params.limit === 'number') {
      // ACP `ReadTextFileRequest.line` is 1-based per spec — clients passing
      // `{ line: 1, limit: 2 }` mean "the first two lines", not "skip the
      // first then take two". Convert to a 0-based slice index, clamping
      // values < 1 to 0 to be tolerant of unusual inputs.
      const startLine = params.line ?? 1;
      const start = startLine > 0 ? startLine - 1 : 0;
      const end = params.limit != null ? start + params.limit : undefined;
      // Avoid `content.split('\n')` — allocating a per-line String[] for
      // a 100 MB file roughly doubles the memory footprint just to
      // extract a few lines. Manual scan walks `indexOf('\n', …)` only
      // until the end-of-range boundary is found, then slices a single
      // range of the original string. Stage 2 in-process replaces this
      // proxy entirely (the bridge stops reading user fs).
      return { content: sliceLineRange(content, start, end) };
    }
    return { content };
  }
}

// ---------------------------------------------------------------------------
// A2UI-over-MCP extraction.
// Detection has to key off the server/tool identity rather than mime type:
// core's transformResourceBlock flattens EmbeddedResource blocks to `{text}`
// and drops the application/a2ui+json mimeType, so by the time the result
// reaches the bridge it is plain text of the form
// `<A2UI command JSON array>\n<fallback text>`.
// ---------------------------------------------------------------------------

/**
 * A2UI tool detection: prefer `_meta.serverId` (a server whose name contains
 * "a2ui" is treated as a UI server, so new tools added to that server need no
 * change here); tool-name matching is the fallback for legacy frames/replays
 * where serverId is absent.
 *
 * Exported for unit testing.
 */
const A2UI_TOOL_RE = /(^|__)(present_ui|present_choices|a2ui_action)$/;
export function isA2uiToolMeta(meta?: {
  toolName?: string;
  serverId?: string;
}): boolean {
  if (!meta) return false;
  if (
    typeof meta.serverId === 'string' &&
    meta.serverId.toLowerCase().includes('a2ui')
  )
    return true;
  return typeof meta.toolName === 'string' && A2UI_TOOL_RE.test(meta.toolName);
}

/**
 * Extract the balanced JSON array at the start of the text; returns
 * [command array, remaining fallback text], or null when no array parses.
 *
 * Exported for unit testing.
 */
export function splitA2uiText(raw: string): [unknown[], string] | null {
  const s = raw.replace(/^\s+/, '');
  if (s[0] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const arr = JSON.parse(s.slice(0, end));
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return [arr, s.slice(end).trim()];
  } catch {
    return null;
  }
}

/** Read the surfaceId off any of the four A2UI command kinds. */
function surfaceIdOf(c: unknown): string | undefined {
  const cmd = c as {
    createSurface?: { surfaceId?: string };
    updateComponents?: { surfaceId?: string };
    updateDataModel?: { surfaceId?: string };
    deleteSurface?: { surfaceId?: string };
  };
  return (
    cmd?.createSurface?.surfaceId ??
    cmd?.updateComponents?.surfaceId ??
    cmd?.updateDataModel?.surfaceId ??
    cmd?.deleteSurface?.surfaceId
  );
}

export interface A2uiExtraction {
  /** Commands grouped per surface, in first-appearance order. */
  surfaces: Array<{ surfaceId: string; commands: unknown[] }>;
  callId: string | undefined;
  /** Sanitized copy of the notification: the A2UI JSON in the tool-result text is replaced with the fallback text. */
  sanitizedParams: SessionNotification;
}

/**
 * If the notification is a `tool_call_update` from an A2UI tool whose result
 * carries an A2UI command array, extract the commands (grouped per surface)
 * and produce a sanitized notification; otherwise return null (the
 * notification is forwarded as-is).
 *
 * Exported for unit testing.
 */
export function extractA2uiToolUpdate(
  params: SessionNotification,
): A2uiExtraction | null {
  const update = (params as { update?: Record<string, unknown> }).update;
  if (!update || update['sessionUpdate'] !== 'tool_call_update') return null;
  const meta = update['_meta'] as
    | { toolName?: string; serverId?: string }
    | undefined;
  if (!isA2uiToolMeta(meta)) return null;

  // The result text lives at content[].content.text (ACP ToolCallContent
  // wraps one level); rawOutput mirrors the same text.
  const content = update['content'];
  if (!Array.isArray(content)) return null;
  let split: [unknown[], string] | null = null;
  let hitIndex = -1;
  for (let i = 0; i < content.length; i++) {
    const inner = (content[i] as { content?: { text?: unknown } })?.content;
    if (typeof inner?.text === 'string') {
      split = splitA2uiText(inner.text);
      if (split) {
        hitIndex = i;
        break;
      }
    }
  }
  if (!split) return null;
  const [commands, fallback] = split;

  // Group commands per surface (updateDataModel-only / deleteSurface-only
  // tool results are legal too). Commands without a surfaceId are dropped —
  // every A2UI server->client command carries one per the spec.
  const order: string[] = [];
  const grouped = new Map<string, unknown[]>();
  for (const c of commands) {
    const sid = surfaceIdOf(c);
    if (!sid) {
      const shape =
        c && typeof c === 'object'
          ? Object.keys(c).join(',') || 'empty object'
          : typeof c;
      writeStderrLine(
        `a2ui: dropping command with unrecognized shape (${shape})`,
      );
      continue;
    }
    if (!grouped.has(sid)) {
      grouped.set(sid, []);
      order.push(sid);
    }
    grouped.get(sid)!.push(c);
  }
  const surfaces = order.map((sid) => ({
    surfaceId: sid,
    commands: grouped.get(sid)!,
  }));

  // Sanitize: JSON -> fallback text. The model already received the raw text
  // inside the ACP child; what is being cleaned here is the SSE/transcript copy.
  const sanitizedText = fallback || '[A2UI surface rendered]';
  const sanitizedContent = content.map((block, i) =>
    i === hitIndex
      ? {
          ...(block as Record<string, unknown>),
          content: {
            ...((block as { content?: Record<string, unknown> }).content ?? {}),
            text: sanitizedText,
          },
        }
      : block,
  );
  const sanitizedUpdate: Record<string, unknown> = {
    ...update,
    content: sanitizedContent,
  };
  if (typeof update['rawOutput'] === 'string') {
    sanitizedUpdate['rawOutput'] = sanitizedText;
  }
  return {
    surfaces,
    callId:
      typeof update['toolCallId'] === 'string'
        ? update['toolCallId']
        : undefined,
    sanitizedParams: {
      ...(params as Record<string, unknown>),
      update: sanitizedUpdate,
    } as SessionNotification,
  };
}
