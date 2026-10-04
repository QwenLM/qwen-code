/**
 * QQ Bot channel adapter for Qwen Code.
 *
 * Connects QQ Bot via official QQ Bot WebSocket API.
 * Extends ChannelBase for streaming, access control, and session routing.
 * Supports QR code login, credential persistence, C2C and group chat.
 *
 * Cross-server context continuation: persists SessionRouter mappings and
 * QQ-specific routing state (chatTypeMap, replyMsgId, msgSeqMap) to disk,
 * restoring them on reconnect so conversations survive daemon restarts.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */

import {
  ChannelBase,
  SessionRouter,
  getGlobalQwenDir,
  sanitizeSenderName,
  sanitizePromptText,
  sanitizeLogText,
  singleScopeRoutingKey,
  truncateCodePoints,
  truncateUtf16Units,
  unwrapMessageRoutingKey,
} from '@qwen-code/channel-base';
import type {
  Attachment,
  ChannelConfig,
  ChannelBaseOptions,
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  Envelope,
  ToolCallEvent,
  SessionTarget,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpCode, Intent } from './types.js';
import type {
  QQChannelConfig,
  QQMessageAttachment,
  QQMessageEvent,
  QQGroupMessageEvent,
  GroupAddRobotEvent,
  GroupDelRobotEvent,
  GroupMsgToggleEvent,
} from './types.js';
import {
  QQ_IMAGE_MAX_BYTES,
  QQ_MAX_ATTACHMENTS,
  QQ_VIDEO_MAX_BYTES,
  classifyQQAttachment,
  downloadQQAttachment,
} from './media.js';
import {
  getCredsFilePath,
  loadCredentials,
  saveCredentials,
} from './accounts.js';
import { qrCodeLogin } from './login.js';
import {
  fetchAccessToken,
  fetchGatewayUrl,
  getApiBase,
  sendQQMessage,
} from './api.js';

/** QQ Bot OPENID format: exactly 32 uppercase hex chars (bot and sender OPENIDs). */
const QQ_OPENID_RE = /^[A-F0-9]{32}$/i;

export type DeliveryErrorCode =
  | 'RATE_LIMITED'
  | 'RETRY_EXHAUSTED'
  | 'FALLBACK_FAILED'
  | 'ACTIVE_MSG_DISABLED';

export class DeliveryError extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

interface QQReplyContext {
  chatId: string;
  msgId: string;
  timestamp: number;
}

/**
 * Why a send did not put its text on the wire. `transient` can resolve on a
 * later attempt (token refresh failure, empty token); `permanent` cannot
 * (channel disposed, unusable chatId, no chat type for the chat). Reported by
 * sendMessageWithReplyContext, which returns undefined when the text did reach
 * the wire (including a deliberate `<noreply>` suppression). Callers that
 * cannot treat "no exception" as delivered act on it; the streaming path
 * ignores it, preserving its silent-drop behaviour.
 */
type SendBlock = 'transient' | 'permanent';

/**
 * A persisted route as the session router reports it. `target` stays optional
 * because the purge scans whatever router object it was given: `getAll()` is
 * duck-typed and a route without one is still purgeable when its key matches
 * (ownership falls back to the key, see `ownsEntry`), never a reason to abort
 * the scan.
 */
interface RouterRoute {
  key: string;
  sessionId: string;
  target?: SessionTarget;
}

interface QQStreamState {
  chatId: string;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Reconnect generation the current timer handle was armed under. A handle
   * from an older generation still exists but its callback discards itself,
   * so the self-heal must not treat it as live; an unset value is not live.
   */
  timerReconnectId?: number;
  retryCount: number;
  replyContext?: QQReplyContext;
  sourceLabel?: string;
  /**
   * Per-session reply msgId captured for THIS stream entry. Anchors every
   * subsequent chunk/final segment of this session to the msgId of the
   * message that triggered it, so a concurrent message in the same chat
   * overwriting the chat-level replyMsgId entry cannot re-parent this
   * session's streaming chunks onto the other message (PR #8241).
   */
  msgId?: string;
  /**
   * Capture time of the anchor in `msgId` (the sessionReplyMsgId entry's
   * timestamp, written with it by createStreamState). Carried alongside
   * because an entry can outlive the 300s REPLY_MSG_ID_TTL_MS on the
   * deferred/parked paths; the flush and sealed-head read sites TTL-check
   * the override through this value so a stale anchor expires to an
   * unanchored active send instead of going out on an expired msg_id.
   */
  msgIdTimestamp?: number;
  /**
   * Turn generation this entry belongs to (see turnCounter). A leftover
   * entry from a previous turn (e.g. a deferred send parked the session
   * in pendingStreamDelete and a new turn started before it settled)
   * must never receive the new turn's chunks — onResponseChunk compares
   * its turn against the current counter and drops stale entries.
   */
  turn: number;
  /**
   * Sealed pre-boundary head carried across the onResponseChunk stash drain.
   * The drain folds the stash into `buffer`; if that drained send fails
   * permanently the buffer is dropped, and the bridge's cleared collection
   * means this sealed portion has no other copy. The permanent-failure branch
   * re-stashes it so onResponseComplete can still prepend it.
   */
  sealedPre?: string;
  /**
   * What a boundary that cleared the bridge's chunk collection while a flush for
   * this entry was in flight implies for a re-buffer: 'residual' when the
   * boundary stripped residual text from the live turn's own buffer — the text
   * itself is captured into `sealedPre` in the same call, so appending it can
   * never reuse the stale seal the payload carried — or 'payload' when there
   * was no such residual and only the in-flight payload is re-sealed.
   * `undefined` means no boundary cleared the collection during this flight, so
   * a re-buffer keeps the carried seal. Cleared when a flush chain starts.
   */
  boundaryClearedInFlight?: 'payload' | 'residual';
}

/**
 * A diverted turn's stashed head (see streamOrphanBuffer). `capDropped` and
 * `capLogged` bound the cap log: the first overflow writes one line, later
 * overflows only accumulate, and the cumulative total is reported once when
 * the stash leaves the buffer. Without them a permanently parked predecessor
 * (the divert window can last the process's life) writes one near-identical
 * line per chunk.
 */
interface QQOrphanStash {
  turn: number;
  text: string;
  pre?: string;
  sourceLabel?: string;
  capDropped?: number;
  capLogged?: number;
}

/** Validate chatId to prevent SSRF when constructing URLs. */
export function isValidChatId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
}

interface QQInboundMedia {
  attachment: QQMessageAttachment;
  kind: 'image' | 'video';
}

/** Attachments actually handled: the per-message cap applies everywhere. */
function cappedMedia(media: QQInboundMedia[]): QQInboundMedia[] {
  return media.slice(0, QQ_MAX_ATTACHMENTS);
}

/** Placeholder for a media-only message: images win when both are present. */
function mediaPlaceholder(media: QQInboundMedia[]): string {
  return cappedMedia(media).some((entry) => entry.kind === 'image')
    ? '(image)'
    : '(video)';
}

/** Truncate to a byte budget without splitting a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
}

function canonicalExtension(kind: 'image' | 'video', mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'video/mp4':
      return '.mp4';
    default:
      return kind === 'image' ? '.jpg' : '.mp4';
  }
}

/**
 * Build the on-disk name from the resolved MIME: the read tool classifies
 * media by extension, so a sender-supplied extension must never win. The stem
 * is capped by bytes, not code points, to stay under the 255-byte limit.
 */
function attachmentFileName(
  name: string | undefined,
  kind: 'image' | 'video',
  mimeType: string,
): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '_');
  const safeStem = truncateToBytes(cleaned, 200) || `qq_${kind}`;
  return `${safeStem}${canonicalExtension(kind, mimeType)}`;
}

export class QQChannel extends ChannelBase {
  private ws: WebSocket | null = null;
  private accessToken: string = '';
  private tokenExpiresAt: number = 0;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: number = 45000;
  private seq: number = 0;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number;
  /** QQ Bot session_id from READY, used for RESUME on reconnect. */
  private sessionId: string = '';
  /** Whether this connection attempt should try RESUME first. */
  private tryResume: boolean = false;
  private readonly qqConfig: QQChannelConfig;
  /** Set when server sends RECONNECT opcode — close handler uses this to force reconnect. */
  private serverRequestedReconnect: boolean = false;
  /** Pending connect promise reject — called when WebSocket closes before READY. */
  private connectReject: ((err: Error) => void) | null = null;
  /** Set to true when channel is disconnected — prevents orphaned connections. */
  private disposed: boolean = false;
  /** Deduplicate inbound messages on reconnect replay (messageId → timestamp). */
  private seenMessages: Map<string, number> = new Map();
  /** Cleanup timer for seenMessages TTL eviction. */
  private seenCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of last received HEARTBEAT_ACK, for zombie-connection detection. */
  private lastHeartbeatAck: number = 0;
  /** Debounce timer for saveQQState to avoid blocking event loop. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** beforeExit hook to flush state when the event loop drains naturally. Does NOT fire for SIGKILL, OOM kills, or uncaughtException. */
  private beforeExitHook: (() => void) | null = null;
  /** Timer for reconnectWithRetry fallback (unref'd so it doesn't block exit). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 30s READY timeout to prevent hanging on gateway without response. */
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Guard against parallel reconnectWithRetry chains from stale close events. */
  private isReconnecting: boolean = false;

  /** Track whether a chatId is a group or C2C for correct API routing. */
  private chatTypeMap: Map<string, 'c2c' | 'group'> = new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  private replyMsgId: Map<string, { msgId: string; timestamp: number }> =
    new Map();
  private replyContextByMessageId = new Map<string, QQReplyContext>();
  private inboundReplyContext = new AsyncLocalStorage<QQReplyContext>();
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();
  /**
   * Anchored sends currently in flight, keyed by the msgId whose msg_seq
   * counter they hold (refcounted: two sessions may send under one msgId).
   * Covers sends that own no streamState entry — the terminal send in
   * onResponseComplete and the stale-entry branch — which flushingSessions
   * (session-keyed) cannot see.
   */
  private inFlightMsgSeqSends: Map<string, number> = new Map();
  /** Periodic cleanup timer for expired replyMsgId entries. */
  private replyMsgIdCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 5-minute TTL for replyMsgId entries and seenMessages dedup. */
  private static readonly REPLY_MSG_ID_TTL_MS = 300_000;
  /** Idle-flush timeout: buffer is sent after this many ms of silence. */
  private static readonly IDLE_FLUSH_MS = 2000;
  /** Max consecutive send failures before the stream is abandoned. */
  private maxFlushRetries: number;
  /** Retry delay for subsequent attempts (backoff beyond first retry). */
  private static readonly IDLE_FLUSH_BACKOFF_MS = 4000;
  /**
   * Foreground ceiling for the completion-path final segment when
   * maxFlushRetries is the documented "unlimited" (<= 0). The fire-and-forget
   * flush paths may retry forever because no caller awaits them, but a
   * completion send is awaited inside the turn's try, so its readiness to give
   * up decides when that turn's finally runs and the session lock is released.
   */
  private static readonly FINAL_SEGMENT_ROUTE_ATTEMPTS = 3;
  /** Max buffer length before forcing an immediate flush. */
  private static readonly MAX_BUFFER_LENGTH = 4096;
  /** Purge records kept in the rescue file, oldest dropped first. */
  private static readonly MAX_PURGE_RECORDS = 20;

  // ── Group / cron fields ────────────────────────────────────────

  /** Per-group bot OPENID map for multi-group support. */
  private botOpenIdByGroup: Map<string, string> = new Map();
  /** Dedup set for unexpected senderOpenId format warnings (key: `${chatId}:${senderOpenId}`). */
  private warnedSenderOpenIds: Set<string> = new Set();
  /** Guard: set to true after first READY + session restore completes. */
  private _ready: boolean = false;
  /** Whether this process has never received READY (cold start). */
  private coldStart: boolean = true;
  /** Track per-group active message permission. */
  private groupActiveMsgEnabled: Map<string, boolean> = new Map();
  /** Lazy cache for compiled keyword trigger RegExp patterns.
   * Built lazily on first access; never invalidated — keywordTriggers is not modified at runtime. */
  private _keywordTriggerCache: RegExp[] | null = null;
  /** Rate-limit timestamps for keyword non-match log entries (chatId → last log ms). */
  private _lastKeywordNoMatchLog: Map<string, number> = new Map();

  /** Accumulation buffer for cron/non-prompt textChunk events. */
  private cronBuffer: Map<
    string,
    {
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
      pendingRetry?: string;
      retryCount?: number;
    }
  > = new Map();

  /** Named handler for permanent textChunk listener (cron/non-prompt). */
  private _cronTextHandler: ((sessionId: string, text: string) => void) | null =
    null;
  /** Gate: depth counter for cron-scheduled message flows. >0 means in-flow.
      Prevents phantom cronBuffer entries when textChunk fires during normal
      bridge.prompt() calls (ChannelBase has its own listener there).
      Using a counter instead of a boolean supports concurrent cron flows. */
  private _inCronFlow: number = 0;
  private cronTextHandlerAttached: boolean = false;
  /** Path to persisted QQ routing state: chatTypeMap, replyMsgId, msgSeqMap. */

  /**
   * Streaming state machine with per-session buffers.
   *
   * Three states for each session:
   *   active   — accumulating chunks in buffer (onResponseChunk extends timer)
   *   flushing — sendMessage() is in-flight (prevents parallel sends)
   *   idle     — waiting for next chunk (timer counting down to idleFlush)
   *
   * Transitions:
   *   active → flushing: idleFlush timer fires, or onToolCall cancels timer
   *   flushing → idle: send settles, idle timer restarts on retry
   *   any → done: onResponseComplete sends remaining content
   *
   * Guards:
   *   - flushingSessions prevents concurrent sends per session
   *   - pendingStreamDelete defers cleanup until in-flight send resolves
   *   - flushedSessions tracks already-sent sessions to skip final fullText
   */
  // ── Streaming state ───────────────────────────────────────────
  private streamState = new Map<string, QQStreamState>();
  /**
   * Per-session reply msgId anchor, kept across idle-flush buffer windows.
   * Set deterministically in onPromptStart from the triggering message's
   * id (the same event.id setReplyMsgId stores) and released when the
   * response completes, fails permanently, or the session dies. Entries
   * carry a timestamp so readers (onResponseChunk / onResponseComplete)
   * can drop anchors past the 5-minute TTL and fall back to the active
   * send path — a slow turn must never keep sending chunks with an
   * expired msg_id. Because it outlives individual streamState entries, a
   * concurrent message in the same chat that overwrites the chat-level
   * replyMsgId entry mid-stream cannot re-parent this session's later
   * chunks onto its own msg_id (see PR #6457 review).
   */
  private sessionReplyMsgId: Map<string, { msgId: string; timestamp: number }> =
    new Map();
  /**
   * Monotonic turn counter per session, bumped on every onPromptStart.
   * streamState entries carry the turn they were created in; when a new
   * prompt starts on a session whose previous turn left a streamState entry
   * behind (deferred send still settling), onResponseChunk uses this counter
   * to detect and drop the stale entry so the new turn's chunks cannot be
   * appended to the old turn's buffer or delivered under its msgId.
   */
  private turnCounter: Map<string, number> = new Map();
  private flushingSessions: Map<string, QQStreamState> = new Map();
  private pendingStreamDelete: Set<string> = new Set();
  private _reconnectId: number = 0;
  private flushedSessions: Set<string> = new Set();
  /**
   * Sessions with a prompt turn currently in flight, tracked via
   * onPromptStart/onPromptEnd.
   *
   * This is the discriminator the cron textChunk handler uses to tell
   * "prompt-response chunk" from "cron/non-prompt chunk". streamState
   * cannot serve that role (#6094): a residual entry from a finished
   * turn's unsettled flush silently blocks cron delivery. This set is
   * reliable because ChannelBase always brackets a prompt turn with
   * onPromptStart and onPromptEnd (onPromptEnd runs in the prompt path's
   * finally, even on error/cancel), independent of streaming config.
   */
  private activePromptSessions: Set<string> = new Set();
  /**
   * Side buffer for chunks arriving while a previous turn's deferred flush
   * chain still owns the session's streamState entry (the stale parked
   * early-return in onResponseChunk). Each entry records the turn that owns
   * its text, so a teardown can tell a live turn's stashed HEAD — which must
   * still be delivered — from a superseded turn's leftovers, which are
   * discarded with a log. The chunks are prepended to the owning turn's next
   * state entry once the chain settles and frees the entry, so the HEAD of a
   * reply is never silently dropped during the chain's settle window (up to
   * ~10s under rate-limit backoff). A teardown may only drop an entry whose
   * turn is not the live turn. The consumption sites are onResponseChunk
   * (the next turn's first chunk folds the stash in), onResponseComplete (the
   * owning turn's completion prepends the sealed `pre`), and onPromptEnd's two
   * branches: a cancelled turn merges the stash into its residual buffer, or —
   * when a parked chain can still deliver it — hands it to
   * deliverCancelledStash instead.
   * `pre` seals the portion accumulated before the most recent
   * responseBoundary: the bridge accumulates every textChunk and only a
   * boundary clears that collection, so at completion only that sealed
   * portion is missing from fullText — the post-boundary remainder is already
   * there and must not be prepended a second time. It is absent until a
   * boundary fires for the entry. Entries are cleared when the session dies
   * or the channel disconnects.
   */
  private streamOrphanBuffer: Map<string, QQOrphanStash> = new Map();
  /**
   * The turn whose onResponseComplete has already run, per session. The
   * completion that prepends a turn's stash cannot run a second time, so a
   * stash tagged with that turn has no guaranteed consumer, and
   * handOffSealedPre delivers its text directly instead of writing it. Dropped
   * when a new turn starts, on session death, and on disconnect; onPromptEnd's
   * terminal teardown drops it unless a chain still holds the session's flush
   * marker, and a flush chain's terminal settle drops it when it still owns the
   * generation (deleteTurnGenerationIfOwned). A teardown that finds a live
   * marker keeps the record so that chain's handOffSealedPre can still read it;
   * because that teardown also clears the marker, the chain's own .finally
   * returns on its ownership check and the record is instead dropped by the
   * next onPromptStart, onSessionDied, or disconnect.
   */
  private completedTurns: Map<string, number> = new Map();
  /**
   * Bridge-side `responseBoundary` observer. ChannelBase's own listener returns
   * early while a cancel is pending, so onResponseBoundary can miss a boundary
   * even though the bridge still cleared its chunk collection — the stash's
   * `pre` would then never be sealed and the diverted head would be absent from
   * both state.buffer and fullText. Observing the bridge event directly (the
   * same emit the bridge's clearChunks listens to) is ungated.
   */
  private _bridgeBoundarySeal = (sessionId: string): void => {
    this.sealOrphanStash(sessionId);
    // Ungated: ChannelBase suppresses the adapter hook while a cancel is
    // pending, but the bridge still clears its collection, so this path must
    // reach the same seal the hook would.
    this.captureBoundaryClear(sessionId);
  };
  private bridgeBoundarySealAttached = false;
  private readonly qqStatePath: string;
  /**
   * Path to the global sessions.json managed by start.ts.
   * start.ts deletes it on shutdown, so we back it up.
   */
  private readonly globalSessionsPath: string;
  /** Backup of sessions.json so conversations survive daemon restarts. */
  private readonly sessionsBackupPath: string;
  /**
   * Append-only rescue log of the routes the orphan purge deletes, written
   * immediately before the first deletion when `purgeLegacySessions` is on, so
   * an operator can restore a legacy conversation by hand.
   */
  private readonly sessionsPurgedPath: string;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    const safeName = name.replace(/[^A-Za-z0-9_-]/g, '_');
    const stateDir = join(getGlobalQwenDir(), 'channels');
    mkdirSync(stateDir, { recursive: true });
    const sessionsPath = join(stateDir, `${safeName}-sessions.json`);

    // groupAllPolicy 'keyword' or 'all' requires per-group shared context.
    // 'thread' is the only scope that gives it without collateral: it shares
    // each group's session (routing key = channel:chatId) while keeping every
    // direct message per-user. 'chat_thread' routes groups identically but
    // ChannelBase treats it as unconditionally shared, so every DM becomes a
    // shared session too (no operator can /clear it, and a DM tool call has no
    // answerer). 'single' is shared as well but collapses every group and every
    // DM into one `channel:__single__` context — the cross-group leakage issue
    // #8238 describes. 'user' fragments group messages per sender. We warn but
    // do NOT force the scope: forcibly flattening the user's multi-level
    // session isolation into a global single session was incorrect (see
    // PR #6457 review). The user's sessionScope choice wins.
    const qqCfg = config as unknown as QQChannelConfig;
    if (
      (qqCfg.groupAllPolicy === 'keyword' || qqCfg.groupAllPolicy === 'all') &&
      config.sessionScope !== 'thread'
    ) {
      process.stderr.write(
        `[QQ:${name}] WARNING: groupAllPolicy is '${qqCfg.groupAllPolicy}' but sessionScope is '${config.sessionScope}' (not 'thread'). groupAllPolicy keyword/all needs sessionScope: 'thread' for per-group shared context with each direct message kept private; 'chat_thread' routes groups the same but makes every direct message a shared session, and 'single' merges every group and direct message into one context. With 'user', group messages fragment per sender.\n`,
      );
    }

    // A shared-scope session is operated only by config.operators (see
    // ChannelBase.isSharedSessionOperator) — membership grants no
    // session-control rights. Warn whenever such a session exists and no
    // operator is configured: permission requests, the session-control
    // commands (/clear, /cancel, /who, /status, /loop, /btw, /approve*, /deny)
    // and steering an in-flight turn are then unreachable, with no other
    // signal. Group access is not required for the lockout: 'single' and
    // 'chat_thread' share direct-message sessions too, so a DM-only channel on
    // those scopes has the same dead end ('thread' shares only group sessions,
    // because a direct message is one chat with one sender).
    const sharedScope =
      config.sessionScope === 'thread' ||
      config.sessionScope === 'chat_thread' ||
      config.sessionScope === 'single';
    const dmSharedScope =
      config.sessionScope === 'single' || config.sessionScope === 'chat_thread';
    const groupAccess =
      config.groupPolicy !== undefined && config.groupPolicy !== 'disabled';
    if (
      sharedScope &&
      (groupAccess || dmSharedScope) &&
      (config.operators ?? []).length === 0
    ) {
      const where = groupAccess
        ? `group access is enabled with shared sessionScope '${config.sessionScope}'`
        : `sessionScope '${config.sessionScope}' makes every session shared, direct messages included`;
      process.stderr.write(
        `[QQ:${name}] WARNING: ${where}, but no operators are configured — no one can answer permission requests, run session-control commands, or steer an in-flight turn until 'operators' is set.\n`,
      );
    }

    const router =
      options?.router ??
      new SessionRouter(bridge, config.cwd, config.sessionScope, sessionsPath);

    super(name, config, bridge, {
      ...options,
      router,
      registerBridgeEvents: options?.registerBridgeEvents ?? !options?.router,
    });
    this.qqConfig = config as unknown as QQChannelConfig;
    this.maxReconnectAttempts = this.qqConfig.maxReconnectAttempts ?? 20;
    this.maxFlushRetries = this.qqConfig.maxFlushRetries ?? 3;
    const raw = this.qqConfig.bufferFlushLength;
    if (
      raw !== undefined &&
      (!Number.isInteger(raw) || raw <= 0 || raw > QQChannel.MAX_BUFFER_LENGTH)
    ) {
      process.stderr.write(
        `[QQ:${this.name}] WARNING: invalid bufferFlushLength=${raw}, using default ${QQChannel.MAX_BUFFER_LENGTH}\n`,
      );
      this.qqConfig.bufferFlushLength = QQChannel.MAX_BUFFER_LENGTH;
    }
    this.qqStatePath = join(stateDir, `${safeName}-state.json`);
    // In standalone mode (no external router), use the per-channel
    // sessions path so the channel owns its own session file.
    this.globalSessionsPath = options?.router
      ? join(stateDir, 'sessions.json')
      : sessionsPath;
    this.sessionsBackupPath = join(
      stateDir,
      `${safeName}-sessions-backup.json`,
    );
    this.sessionsPurgedPath = join(
      stateDir,
      `${safeName}-sessions-purged.json`,
    );

    // Permanent textChunk listener for cron/non-prompt messages.
    // ChannelBase's prompt-path textChunk listener is only alive during
    // bridge.prompt(). Cron messages bypass prompt() so their textChunk
    // events arrive without a listener. This permanent listener catches them.
    if (this.qqConfig['cron-msg-experimental']) {
      this._cronTextHandler = (sid, t) => this.handleCronTextChunk(sid, t);
      this.attachCronHandler();
    }
    // Seal a stashed head on every bridge boundary, including the ones
    // ChannelBase suppresses while a cancel is pending.
    this.attachBridgeBoundarySeal();
  }

  private handleCronTextChunk(sessionId: string, text: string): void {
    const wasInCronFlow = this._inCronFlow > 0;
    setImmediate(() => {
      if (!this._ready) {
        process.stderr.write(
          `[QQ:${this.name}] Cron text chunk dropped (not ready): ${sanitizeLogText(text, 64)} for session ${sanitizeLogText(sessionId, 32)}\n`,
        );
        return;
      }
      if (!wasInCronFlow) return;
      // Sessions with an active prompt turn belong to the prompt path
      // (which delivers the response itself) — never capture their chunks
      // into the cron buffer. Keyed on activePromptSessions rather than
      // streamState (#6094): streamState can linger after a turn ends,
      // which would silently drop cron chunks.
      if (this.activePromptSessions.has(sessionId)) return;
      let entry = this.cronBuffer.get(sessionId);
      if (!entry) {
        entry = { buffer: '', timer: null };
        this.cronBuffer.set(sessionId, entry);
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.pendingRetry) {
          entry.buffer = entry.pendingRetry + entry.buffer;
          entry.pendingRetry = '';
        }
      }
      entry.buffer += text;
      const limit =
        this.qqConfig.bufferFlushLength ?? QQChannel.MAX_BUFFER_LENGTH;
      const delay = entry.buffer.length >= limit ? 0 : 2000;
      entry.timer = setTimeout(() => {
        const toFlush = entry!.buffer;
        entry!.buffer = '';
        entry!.timer = null;
        if (toFlush) {
          const target = this.router.getTarget(sessionId);
          if (target) {
            this.sendMessageWithReplyContext(target.chatId, toFlush)
              .then(() => {
                if (!entry!.buffer && this.cronBuffer.get(sessionId) === entry)
                  this.cronBuffer.delete(sessionId);
              })
              .catch((err) => {
                const code = err instanceof DeliveryError ? err.code : null;
                const codeStr = code ? ` (${code})` : '';
                process.stderr.write(
                  `[QQ:${this.name}] Cron flush send error${codeStr}: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 200)}\n`,
                );
                if (
                  code === 'RETRY_EXHAUSTED' ||
                  code === 'ACTIVE_MSG_DISABLED' ||
                  code === 'FALLBACK_FAILED'
                ) {
                  this.cronBuffer.delete(sessionId);
                  return;
                }
                entry!.pendingRetry = toFlush;
                entry!.retryCount = 1;
                if (entry!.timer) {
                  clearTimeout(entry!.timer);
                }
                entry!.timer = setTimeout(() => {
                  entry!.timer = null;
                  entry!.pendingRetry = '';
                  // Guard: if cronBuffer entry was removed (e.g., group deleted),
                  // bail out instead of sending to a deleted group.
                  if (this.cronBuffer.get(sessionId) !== entry) {
                    return;
                  }
                  const retryTarget = this.router.getTarget(sessionId);
                  if (!retryTarget) {
                    process.stderr.write(
                      `[QQ:${this.name}] Cron flush dropped after retry: no target for session ${sanitizeLogText(sessionId, 32)}\n`,
                    );
                    this.cronBuffer.delete(sessionId);
                    return;
                  }
                  this.sendMessageWithReplyContext(retryTarget.chatId, toFlush)
                    .then(() => {
                      entry!.pendingRetry = '';
                      if (
                        !entry!.buffer &&
                        this.cronBuffer.get(sessionId) === entry
                      )
                        this.cronBuffer.delete(sessionId);
                    })
                    .catch((retryErr) => {
                      const retryCode =
                        retryErr instanceof DeliveryError
                          ? retryErr.code
                          : null;
                      const retryCodeStr = retryCode ? ` (${retryCode})` : '';
                      process.stderr.write(
                        `[QQ:${this.name}] Cron flush retry failed${retryCodeStr}: ${sanitizeLogText(retryErr instanceof Error ? retryErr.message : String(retryErr), 200)}\n`,
                      );
                      entry!.pendingRetry = '';
                      if (
                        retryCode === 'RETRY_EXHAUSTED' ||
                        retryCode === 'ACTIVE_MSG_DISABLED' ||
                        retryCode === 'FALLBACK_FAILED'
                      ) {
                        if (
                          !entry!.buffer &&
                          this.cronBuffer.get(sessionId) === entry
                        ) {
                          this.cronBuffer.delete(sessionId);
                        }
                        return;
                      }
                      // Transient error on retry (RATE_LIMITED, etc.) — re-schedule with backoff
                      entry!.retryCount = (entry!.retryCount ?? 1) + 1;
                      if (entry!.timer) {
                        clearTimeout(entry!.timer);
                      }
                      entry!.pendingRetry = toFlush;
                      entry!.timer = setTimeout(
                        () => {
                          entry!.timer = null;
                          entry!.pendingRetry = '';
                          if (this.cronBuffer.get(sessionId) !== entry) {
                            return;
                          }
                          const retryTarget2 = this.router.getTarget(sessionId);
                          if (!retryTarget2) {
                            process.stderr.write(
                              `[QQ:${this.name}] Cron flush dropped after retry: no target for session ${sanitizeLogText(sessionId, 32)}\n`,
                            );
                            this.cronBuffer.delete(sessionId);
                            return;
                          }
                          this.sendMessageWithReplyContext(
                            retryTarget2.chatId,
                            toFlush,
                          )
                            .then(() => {
                              entry!.pendingRetry = '';
                              if (
                                !entry!.buffer &&
                                this.cronBuffer.get(sessionId) === entry
                              )
                                this.cronBuffer.delete(sessionId);
                            })
                            .catch((err2) => {
                              const code2 =
                                err2 instanceof DeliveryError
                                  ? err2.code
                                  : null;
                              const code2Str = code2 ? ` (${code2})` : '';
                              process.stderr.write(
                                `[QQ:${this.name}] Cron flush re-retry failed${code2Str}: ${sanitizeLogText(err2 instanceof Error ? err2.message : String(err2), 200)}, toFlush=${toFlush.length}, session=${sanitizeLogText(sessionId, 32)}\n`,
                              );
                              entry!.pendingRetry = '';
                              if (
                                code2 === 'RETRY_EXHAUSTED' ||
                                code2 === 'ACTIVE_MSG_DISABLED' ||
                                code2 === 'FALLBACK_FAILED'
                              ) {
                                this.cronBuffer.delete(sessionId);
                                return;
                              }
                              // Transient error: retries exhausted after 3 total attempts
                              process.stderr.write(
                                `[QQ:${this.name}] Cron flush retries exhausted, dropped ${toFlush.length} chars for session ${sanitizeLogText(sessionId, 32)}\n`,
                              );
                              this.cronBuffer.delete(sessionId);
                            });
                        },
                        entry!.retryCount === 2 ? 10000 : 5000,
                      );
                      entry!.timer.unref();
                    });
                }, 5000);
                entry!.timer.unref();
              });
            return;
          }
        }
        process.stderr.write(
          `[QQ:${this.name}] Cron flush dropped: no target for session ${sanitizeLogText(sessionId, 32)}, lost ${toFlush.length} chars\n`,
        );
        this.cronBuffer.delete(sessionId);
      }, delay).unref();
    });
  }

  /**
   * Public gate for external cron/scheduler integration.
   * Wraps a cron message flow to activate `_inCronFlow` so that
   * `textChunk` events are captured into the cron accumulation buffer.
   * Uses a depth counter (not boolean) so concurrent cron flows
   * don't stomp each other's `_inCronFlow` state.
   * Always decrements `_inCronFlow` in a `finally` block.
   */
  async runCronFlow(fn: () => Promise<void>): Promise<void> {
    this._inCronFlow++;
    try {
      await fn();
    } finally {
      if (this._inCronFlow > 0) this._inCronFlow--;
    }
  }
  /**
   * Override setBridge to re-attach the permanent `_cronTextHandler`
   * after bridge crash-recovery.
   */
  override setBridge(bridge: ChannelAgentBridge): void {
    this.detachCronHandler();
    this.detachBridgeBoundarySeal();
    super.setBridge(bridge);
    this.attachCronHandler();
    this.attachBridgeBoundarySeal();
  }

  // ── ChannelBase interface ──────────────────────────────────────

  async connect(): Promise<void> {
    // Clear any pending reconnect timer from a previous disconnect/reconnect
    // chain — connect() is an explicit call and should not race with stale
    // reconnectWithRetry timeouts.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reconnectId++;
    this.disposed = false;
    this.reconnectAttempts = 0;
    this.serverRequestedReconnect = false;
    this.tryResume = false;
    if (!this.config.instructions) {
      const parts: string[] = [
        '## QQ Bot Channel',
        '',
        '你是通过 QQ Bot 与用户对话的 AI 助手。',
        '支持 Markdown 格式，回复自然流畅即可。',
        '消息前缀 [atMention=true] 表示该消息 @了你，[atMention=false] 表示未 @你。',
        '不想回复时只输出 <noreply> 即可，消息不会发出。',
        '',
        '以下规则仅适用于群聊消息。C2C 私聊中请始终正常回复。',
        '## 群聊唤醒与静默规则',
        '',
        '### 当 [atMention=false] — 未 @你',
        '由你自主判断当前聊天氛围是否适合插嘴：',
        '- 闲聊/调侃/玩梗 → 可以接茬，风趣即可',
        '- 严肃讨论/事务协商 → 保持沉默',
        '- 不确定 → 沉默',
        '',
        '### 当 [atMention=true] — @了你',
        '先去掉 @标签和你的名字，剩下的内容是对你的提问或指令吗？',
        '',
        '以下场景即使 @了你也必须沉默：',
        '1. 纯提及/陈述 — "QwenCode 好像变聪明了"',
        '2. 转述/引用 — "刚才 QwenCode 给的方案可以"',
        '3. 间接呼叫 — "@李四 你让 QwenCode 查下"',
        '4. 调侃/试探 — "这事 QwenCode 肯定不知道"',
        '',
        '### 回复准则',
        '- 被唤醒后直接做事，禁止"我在"等占位回复',
        '- 一条消息 @多人时，只有明确指派给你才接',
        '- 不确认时先沉默',
        '- 完成对话后立刻回归静默',
      ];
      // Only inject @mention format instructions when the operator has
      // opted in (default: enabled). When disabled, the model receives
      // no <@OPENID> tags and has no way to @mention, so the instructions
      // are unnecessary and would confuse the model.
      if (this.qqConfig.allowMention !== false) {
        parts.push(
          '',
          '## @提及格式',
          '',
          '消息内容中的 <@OPENID> 标签代表群成员的 QQ 标识。',
          '消息前缀 [昵称(OPENID)] 中紧邻 ] 之前的括号内是该发送者的 32 位十六进制 OPENID，可用 <@OPENID> 回复时 @他。',
          '注意：群成员昵称可能本身包含括号或特殊字符，昵称中的括号内容不是 OPENID，请勿使用。',
          '当其他群成员 @你（机器人）时，消息内容中会出现 <@你的BotOPENID> 标签，这代表该消息是 @给你的。机器人自己的 OPENID 将在连接建立后告知。',
          '你可以在回复中使用 <@OPENID> 格式来 @提及特定的群成员。',
          '例如：回复 "<@ABC123DEF456> 你好" 会在群里 @该成员。',
        );
      }
      this.config.instructions = parts.join('\n');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.fetchToken();
        await this.connectGateway();
        // Register beforeExit hook so the unref'd debounce timer's unflushed
        // state is persisted when the event loop drains naturally. Does NOT
        // fire for SIGKILL, OOM kills, or uncaughtException.
        if (this.beforeExitHook) {
          process.off('beforeExit', this.beforeExitHook);
        }
        this.beforeExitHook = () => this.flushQQState();
        process.on('beforeExit', this.beforeExitHook);
        this.startReplyMsgIdCleanup();
        return;
      } catch (e: unknown) {
        if (attempt < 2) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(
            `[QQ:${this.name}] Connect attempt ${attempt + 1} failed: ${sanitizeLogText(msg, 200)}, retrying...\n`,
          );
          await this.sleep(2000);
        } else {
          // Final attempt: wrap the connection error with sanitized text.
          // The sanitizeLogText path is exercised by the existing connect gateway
          // retry tests in send.test.ts (gateway reconnect timer block).
          throw new Error(
            sanitizeLogText(e instanceof Error ? e.message : String(e), 200),
            { cause: e },
          );
        }
      }
    }
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    const context = envelope.messageId
      ? this.replyContextByMessageId.get(envelope.messageId)
      : undefined;
    if (!context || context.chatId !== envelope.chatId) {
      await super.handleInbound(envelope);
      return;
    }
    await this.inboundReplyContext.run(context, () =>
      super.handleInbound(envelope),
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const inboundContext = this.inboundReplyContext.getStore();
    const latest = this.replyMsgId.get(chatId);
    const replyContext =
      inboundContext?.chatId === chatId
        ? inboundContext
        : latest
          ? { chatId, ...latest }
          : undefined;
    await this.sendMessageWithReplyContext(chatId, text, replyContext);
  }

  protected override async sendThreadMessage(
    chatId: string,
    _threadId: string | undefined,
    text: string,
    sourceLabel?: string,
  ): Promise<void> {
    const inboundContext = this.inboundReplyContext.getStore();
    const latest = this.replyMsgId.get(chatId);
    const replyContext =
      inboundContext?.chatId === chatId
        ? inboundContext
        : latest
          ? { chatId, ...latest }
          : undefined;
    await this.sendMessageWithReplyContext(
      chatId,
      text,
      replyContext,
      sourceLabel,
    );
  }

  /**
   * The reply context a session's next response would carry: the inbound
   * message the turn is answering, resolved through the turn-scoped
   * activePrompts entry. Read by sendResponseMessage and captured once by
   * deliverCancelledStash, which re-attempts a delivery after that entry may
   * already belong to a successor turn.
   */
  private resolveResponseReplyContext(
    sessionId: string,
  ): QQReplyContext | undefined {
    const messageId = this.getResponseMessageId(sessionId);
    return messageId ? this.replyContextByMessageId.get(messageId) : undefined;
  }

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
    sourceLabel?: string,
  ): Promise<void> {
    await this.sendMessageWithReplyContext(
      chatId,
      text,
      this.resolveResponseReplyContext(sessionId),
      sourceLabel ?? this.getResponseSourceLabel(sessionId),
    );
  }

  private async sendMessageWithReplyContext(
    chatId: string,
    text: string,
    replyContext?: QQReplyContext,
    sourceLabel?: string,
    msgIdOverride?: string,
    msgIdOverrideTimestamp?: number,
  ): Promise<SendBlock | undefined> {
    // <noreply> suppression
    if (text.trim() === '<noreply>') {
      process.stderr.write(
        `[QQ:${this.name}] <noreply> skipped for ${sanitizeLogText(chatId, 64)}\n`,
      );
      return undefined;
    }
    const outgoingText = this.formatMarkdownAttributedText(text, sourceLabel);
    const plainOutgoingText = this.formatAttributedText(text, sourceLabel);

    const route = await this.resolveRoute(chatId);
    // resolveRoute names the class next to the guard that produced it; the
    // caller only forwards it, so a new guard cannot silently default to a
    // retryable class here.
    if ('block' in route) return route.block;

    // msgIdOverride is the per-session reply anchor captured when a streaming
    // response started (PR #8241). It takes precedence over the reply context
    // so a concurrent message (same chat, other user) that overwrote the
    // chat-level entry mid-stream cannot re-parent this session's chunks onto
    // that message. When absent, use the explicit reply context — the
    // async-local inbound context, the active prompt's message, or the
    // chat-level latest entry resolved by the caller.
    //
    // The override is TTL-checked against its capture time, exactly like the
    // reply-context entry below: a streamState entry can outlive the 300s
    // window on the deferred/parked paths, and its anchor must then expire to
    // an unanchored active send (a slow turn must never keep sending chunks
    // with an expired msg_id). A supplied override always forces `entry`
    // undefined — an expired one must NOT fall back to the reply context or
    // the chat-level entry, which would re-parent the send onto the message
    // this parameter exists to avoid.
    const overrideFresh =
      msgIdOverride !== undefined &&
      msgIdOverrideTimestamp !== undefined &&
      Date.now() - msgIdOverrideTimestamp < QQChannel.REPLY_MSG_ID_TTL_MS;
    const entry =
      msgIdOverride !== undefined || replyContext?.chatId !== chatId
        ? undefined
        : replyContext;
    const msgId = overrideFresh
      ? msgIdOverride
      : entry && Date.now() - entry.timestamp < QQChannel.REPLY_MSG_ID_TTL_MS
        ? entry.msgId
        : undefined;
    if (msgIdOverride !== undefined && !overrideFresh) {
      process.stderr.write(
        `[QQ:${this.name}] per-session reply anchor expired for ${sanitizeLogText(chatId, 64)}, sending without msg_id\n`,
      );
    }
    if (entry && !msgId) {
      process.stderr.write(
        `[QQ:${this.name}] replyMsgId entry expired for ${sanitizeLogText(chatId, 64)}, reply context expired, sending without msg_id\n`,
      );
      // A streaming reply anchored to this msgId may still be in flight
      // (per-session msgId): deleteReplyContext keeps its msg_seq counter
      // alive while a live session is still anchored to it.
      this.deleteReplyContext(entry);
      this.saveQQState();
    }

    // Respect QQ Bot active-message toggle: when a group admin disables
    // active messages, drop outbound sends silently to avoid platform-policy
    // violations. Only applies to active sends (no msgId — passive replies
    // to @-bot messages must still be delivered).
    if (!msgId && this.groupActiveMsgEnabled.get(chatId) === false) {
      const cronCtx = this._inCronFlow ? ' (cron flow discarded)' : '';
      process.stderr.write(
        `[QQ:${this.name}] sendMessage blocked: active messages disabled for ${sanitizeLogText(chatId, 64)}${cronCtx}\n`,
      );
      throw new DeliveryError(
        'ACTIVE_MSG_DISABLED',
        `Active messages disabled for ${sanitizeLogText(chatId, 64)}`,
      );
    }

    let nextSeq = 0;
    let rollbackApplied = false;
    try {
      // ── STEP 1: Passive markdown attempt ──
      const passiveBody: Record<string, unknown> = {
        msg_type: 2,
        markdown: { content: outgoingText },
      };
      nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
      if (msgId) {
        this.msgSeqMap.set(msgId, nextSeq);
        passiveBody['msg_id'] = msgId;
        passiveBody['msg_seq'] = nextSeq;
      }

      const resp = await sendQQMessage(
        route.base,
        route.path,
        this.accessToken,
        passiveBody,
      );

      if (!resp.ok) {
        // Always consume response body to prevent undici resource leak
        const errBody = sanitizeLogText(await resp.text().catch(() => ''), 200);
        // Log diagnostic info for non-429 failures
        if (resp.status !== 429) {
          process.stderr.write(
            `[QQ:${this.name}] Send failed (HTTP ${resp.status}: ${errBody})\n
`,
          );
        }
        // 429 = rate-limited — do not retry, bail immediately
        if (resp.status === 429) {
          process.stderr.write(
            `[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on markdown attempt for ${sanitizeLogText(chatId, 64)}\n`,
          );
          if (msgId) {
            // Only roll back our own seq: a concurrent send under the same
            // msgId (two sessions can share one) may have advanced the counter
            // past ours, and restoring nextSeq - 1 would forget the seq that
            // send accepted, making later sends replay a pair QQ dedupes.
            if (this.msgSeqMap.get(msgId) === nextSeq) {
              this.msgSeqMap.set(msgId, nextSeq - 1);
            }
            this.saveQQState();
          }
          throw new DeliveryError(
            'RATE_LIMITED',
            `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
          );
        }

        // Passive markdown failed (non-429). If we have msgId, roll back
        // and try active retries (no msg_id/msg_seq).
        if (msgId) {
          // Conditional rollback: see the 429 branch above — a concurrent
          // anchored send may already have advanced the counter past ours.
          if (this.msgSeqMap.get(msgId) === nextSeq) {
            this.msgSeqMap.set(msgId, nextSeq - 1);
          }
          rollbackApplied = true;

          // Check if active messages are allowed for this chat
          if (this.groupActiveMsgEnabled.get(chatId) === false) {
            process.stderr.write(
              `[QQ:${this.name}] MESSAGE DROPPED: active messages disabled for ${sanitizeLogText(chatId, 64)}, cannot retry\n`,
            );
            this.saveQQState();
            throw new DeliveryError(
              'ACTIVE_MSG_DISABLED',
              `Active messages disabled for ${sanitizeLogText(chatId, 64)}`,
            );
          }

          // ── STEP 2: Active markdown (msg_type: 2, NO msg_id/msg_seq) ──
          const activeMdBody: Record<string, unknown> = {
            msg_type: 2,
            markdown: { content: outgoingText },
          };
          const activeMdResp = await sendQQMessage(
            route.base,
            route.path,
            this.accessToken,
            activeMdBody,
          );

          if (activeMdResp.ok) {
            process.stderr.write(
              `[QQ:${this.name}] Active markdown retry succeeded for ${sanitizeLogText(chatId, 64)}\n`,
            );
            this.saveQQState();
            await activeMdResp.text().catch(() => '');
            return undefined;
          }

          const mdErrBody = sanitizeLogText(
            await activeMdResp.text().catch(() => ''),
            200,
          );
          if (activeMdResp.status === 429) {
            process.stderr.write(
              `[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on active markdown retry for ${sanitizeLogText(chatId, 64)}\n`,
            );
            this.saveQQState();
            throw new DeliveryError(
              'RATE_LIMITED',
              `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
            );
          }
          process.stderr.write(
            `[QQ:${this.name}] Active markdown retry failed (HTTP ${activeMdResp.status}: ${mdErrBody}) for ${sanitizeLogText(chatId, 64)}\n`,
          );

          // ── STEP 3: Active plain-text (msg_type: 0, NO msg_id/msg_seq) ──
          const activeTextBody: Record<string, unknown> = {
            content: plainOutgoingText,
            msg_type: 0,
          };
          const activeTextResp = await sendQQMessage(
            route.base,
            route.path,
            this.accessToken,
            activeTextBody,
          );

          if (activeTextResp.ok) {
            process.stderr.write(
              `[QQ:${this.name}] Active text fallback succeeded for ${sanitizeLogText(chatId, 64)}\n`,
            );
            this.saveQQState();
            await activeTextResp.text().catch(() => '');
            return undefined;
          }

          const textErrBody = sanitizeLogText(
            await activeTextResp.text().catch(() => ''),
            200,
          );
          if (activeTextResp.status === 429) {
            process.stderr.write(
              `[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on active text fallback for ${sanitizeLogText(chatId, 64)}\n`,
            );
            this.saveQQState();
            throw new DeliveryError(
              'RATE_LIMITED',
              `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
            );
          }
          process.stderr.write(
            `[QQ:${this.name}] MESSAGE DROPPED: active text fallback failed (HTTP ${activeTextResp.status}: ${textErrBody}) for ${sanitizeLogText(chatId, 64)}\n`,
          );
          this.saveQQState();
          throw new DeliveryError(
            'FALLBACK_FAILED',
            `All delivery attempts exhausted for ${sanitizeLogText(chatId, 64)}`,
          );
        }

        // Plain-text fallback for pure active messages (no reply context)
        const plainBody: Record<string, unknown> = {
          content: plainOutgoingText,
          msg_type: 0,
        };
        const fallbackRes = await sendQQMessage(
          route.base,
          route.path,
          this.accessToken,
          plainBody,
        );

        if (!fallbackRes.ok) {
          const fbErrBody = await fallbackRes.text().catch(() => '');
          if (fallbackRes.status === 429) {
            process.stderr.write(
              `[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on plain-text fallback for ${sanitizeLogText(chatId, 64)}\n`,
            );
            throw new DeliveryError(
              'RATE_LIMITED',
              `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
            );
          }
          process.stderr.write(
            `[QQ:${this.name}] MESSAGE DROPPED: plain-text fallback failed (HTTP ${fallbackRes.status}: ${sanitizeLogText(fbErrBody, 200)}) for ${sanitizeLogText(chatId, 64)}\n`,
          );
          throw new DeliveryError(
            'FALLBACK_FAILED',
            `Plain-text fallback delivery failed for ${sanitizeLogText(chatId, 64)}`,
          );
        }

        process.stderr.write(
          `[QQ:${this.name}] Plain-text fallback succeeded for ${sanitizeLogText(chatId, 64)}\n`,
        );
        await fallbackRes.text().catch(() => '');
        return undefined;
      }

      await resp.text().catch(() => '');
      if (msgId) this.saveQQState();
    } catch (e) {
      // Rollback on failure if we haven't already
      if (msgId && !rollbackApplied) {
        // Conditional rollback: see the 429 branch above — a concurrent
        // anchored send may already have advanced the counter past ours.
        if (this.msgSeqMap.get(msgId) === nextSeq) {
          this.msgSeqMap.set(msgId, nextSeq - 1);
        }
      }
      if (msgId) this.saveQQState();
      // Note: sendQQMessage only throws on network/timeout errors, never HTTP status.
      // Rate-limit (429) handling is in the resp.status checks above.
      if (!(e instanceof DeliveryError)) {
        process.stderr.write(
          `[QQ:${this.name}] Send error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
      }
      throw e; // Re-throw for .catch() callers
    }
    return undefined;
  }

  /**
   * Resolve API routing: handles disposed check, token refresh, chatId validation,
   * sandbox detection, and C2C/group path selection. Returns null if any guard fails.
   */
  private async resolveRoute(
    chatId: string,
  ): Promise<{ base: string; path: string } | { block: SendBlock }> {
    // Each failure reports its own retry class, so this function is the single
    // place that decides what a retry could fix: the caller used to re-derive
    // the class from a mirrored copy of these guards, which meant a sixth
    // guard added here would silently default to 'transient' and be retried.
    if (this.disposed) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: channel disposed, dropping message to ${sanitizeLogText(chatId, 64)}\n`,
      );
      return { block: 'permanent' };
    }
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch (_e) {
        process.stderr.write(
          `[QQ:${this.name}] resolveRoute: token refresh failed (${sanitizeLogText(_e instanceof Error ? _e.message : String(_e), 120)}), dropping message to ${sanitizeLogText(chatId, 64)}\n`,
        );
        return { block: 'transient' };
      }
    }
    if (!this.accessToken) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: accessToken is empty after fetchToken\n`,
      );
      return { block: 'transient' };
    }
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: invalid chatId rejected (length=${chatId.length})\n`,
      );
      return { block: 'permanent' };
    }
    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const routeType = this.chatTypeFor(chatId);
    if (routeType !== 'group' && routeType !== 'c2c') {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: no chat type for ${sanitizeLogText(chatId, 64)}, dropping message\n`,
      );
      return { block: 'permanent' };
    }
    const path =
      routeType === 'group'
        ? `/v2/groups/${chatId}/messages`
        : `/v2/users/${chatId}/messages`;
    return { base, path };
  }

  /** The chat type recorded for a chat, if any (see resolveRoute). */
  private chatTypeFor(chatId: string): string | undefined {
    return this.chatTypeMap.get(chatId) || this.qqConfig.chatTypes?.[chatId];
  }

  disconnect(): void {
    this._reconnectId++;
    this.disposed = true;
    this._ready = false;
    this.stopHeartbeat();
    this.stopTokenRefresh();
    this.stopReplyMsgIdCleanup();
    if (this.seenCleanupTimer) {
      clearInterval(this.seenCleanupTimer);
      this.seenCleanupTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.beforeExitHook) {
      process.off('beforeExit', this.beforeExitHook);
      this.beforeExitHook = null;
    }
    // Clean up cron buffers (always, regardless of config flag)
    let droppedCount = 0;
    for (const [, entry] of this.cronBuffer) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.buffer) droppedCount++;
    }
    if (droppedCount > 0) {
      process.stderr.write(
        `[QQ:${this.name}] Disconnect: discarding ${droppedCount} buffered cron message(s)\n`,
      );
    }
    this.cronBuffer.clear();
    this._lastKeywordNoMatchLog.clear();
    this.flushQQState();
    this.backupGlobalSessions();
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    if (this.connectReject) {
      this.connectReject(new Error('Channel disconnected'));
      this.connectReject = null;
    }
    this.detachCronHandler();
    this.detachBridgeBoundarySeal();
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.replyContextByMessageId.clear();
    this.msgSeqMap.clear();
    this.botOpenIdByGroup.clear();
    this.warnedSenderOpenIds.clear();
    this.groupActiveMsgEnabled.clear();
    this.seenMessages.clear();
    this.coldStart = true;
    if (this._inCronFlow > 0) {
      process.stderr.write(
        `[QQ:${this.name}] resetRoutingState: orphaned cron flow (depth=${this._inCronFlow}) during disconnect\n`,
      );
    }
    this._inCronFlow = 0;
    for (const [, state] of this.streamState) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.streamState.clear();
    this.sessionReplyMsgId.clear();
    this.turnCounter.clear();
    this.flushingSessions.clear();
    this.pendingStreamDelete.clear();
    this.flushedSessions.clear();
    this.activePromptSessions.clear();
    // Report every divert-cap episode's cumulative total before dropping the
    // map: disconnect is the last release point for these sessions, so an
    // episode that accumulated drops after its first overflow line would
    // otherwise lose its `capDropped - capLogged` total silently. The held
    // text itself is discarded here too, so each entry's loss is logged the
    // same way the other teardown sites log theirs.
    for (const [sessionId, held] of this.streamOrphanBuffer) {
      this.reportOrphanStashCap(sessionId, held);
      if (held.text) {
        process.stderr.write(
          `[QQ:${this.name}] dropping ${held.text.length} chars of turn ${held.turn} stash on disconnect for ${sanitizeLogText(sessionId, 64)}\n`,
        );
      }
    }
    this.streamOrphanBuffer.clear();
    this.completedTurns.clear();
  }

  /**
   * QQ Bot API V2 does not provide a typing indicator endpoint, but these
   * hooks still maintain activePromptSessions — the cron textChunk
   * discriminator (see activePromptSessions). ChannelBase always pairs the
   * two calls per prompt turn (onPromptEnd runs in the prompt path's
   * finally, even on error/cancel).
   *
   * Set the per-session reply anchor deterministically from the triggering
   * message's id (ChannelBase passes envelope.messageId, which for QQ is
   * event.id — the same value setReplyMsgId stores in the chat-level entry).
   * This replaces the previous opportunistic capture on the first chunk,
   * which had a blind spot: a slow model turn could pass the chat entry's
   * 5-minute TTL before its first chunk, and the capture would then pick up
   * the msgId of a NEWER message in the same chat (another user's turn).
   * Anchoring at prompt start is immune — the anchor always refers to the
   * message that actually triggered this session's turn.
   *
   * Proactive turns (loop/webhook/cron) have no triggering message; their
   * replies must go out as active messages, so clear any stale anchor.
   */
  protected override onPromptStart(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.activePromptSessions.add(sessionId);
    // Bump the turn generation: streamState entries created by a previous
    // turn on this session (e.g. one left behind by a deferred send) are now
    // stale — onResponseChunk compares its turn against this counter and
    // drops them so this turn's chunks cannot leak into the old turn's state.
    const turn = (this.turnCounter.get(sessionId) ?? 0) + 1;
    this.turnCounter.set(sessionId, turn);
    // A new turn starts: a completion recorded for an earlier turn can never
    // match this generation again, and the counter restarts at 1 after a
    // teardown, so drop the record rather than let a reused number alias onto a
    // turn that has already finished. The number carries no generation of its
    // own, so this clear is the only guard against that alias.
    this.completedTurns.delete(sessionId);
    // A previous turn may have stashed chunks in the orphan buffer while its
    // deferred chain still owned the streamState entry; a fresh turn can
    // never own an existing entry, so anything left is dead text and must not
    // prepend to this turn's HEAD. The drop is logged so the loss is
    // observable rather than silent.
    const stashed = this.streamOrphanBuffer.get(sessionId);
    if (stashed) {
      this.dropOrphanStash(sessionId, stashed);
    }
    // Release the previous turn's reply anchor through the single release
    // path before overwriting: a raw set/delete here would skip the msgSeqMap
    // cascade and orphan the old msgId's msg_seq counter. No identity
    // expectation — this is the normal per-prompt overwrite (every prompt
    // runs onPromptStart), not a deferred chain settling, so releasing by
    // sessionId alone is safe. The release is idempotent for sessions that
    // never held an anchor (proactive turns).
    this.releaseSessionReplyAnchor(sessionId);
    if (messageId) {
      this.sessionReplyMsgId.set(sessionId, {
        msgId: messageId,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * ChannelBase invokes this unconditionally in a finally block — including
   * when the prompt was cancelled, in which case onResponseComplete is
   * skipped. That makes it the one reliable release point for per-session
   * streaming state: without it a cancelled turn would leave its reply
   * anchor in sessionReplyMsgId (and the next prompt on the same session
   * would overwrite it only at its own start, leaking the stale entry's
   * msg_seq orphan meanwhile).
   *
   * Deferred completions are exempt: when onResponseComplete parked the
   * session in pendingStreamDelete, a final flush is still in flight and
   * its promise chain owns the streamState lifecycle (it re-flushes the
   * residual buffer, then releases the anchor). Clearing state here would
   * trip the .then() identity guard and silently drop the residual buffer.
   */
  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    _messageId?: string,
  ): void {
    // Always clear the prompt-in-flight marker first: the PR #8241 teardown
    // below has early returns (deferred flush chains) that must not leave
    // this session marked as an active prompt for the cron discriminator.
    this.activePromptSessions.delete(sessionId);
    // A cancelled turn whose chunks were diverted into the side buffer while a
    // predecessor's deferred chain parked the session must still deliver its
    // HEAD: the early return below hands the whole teardown to that chain, but
    // the chain only services its own residual — it never reads the successor's
    // stash, and the next turn would drop it as superseded. Service this turn's
    // stash first, on this turn's own anchor; the park flag and the
    // predecessor's entry/buffer stay untouched so its chain can still settle
    // and release its own anchor.
    const parkedStash = this.streamOrphanBuffer.get(sessionId);
    if (
      this.pendingStreamDelete.has(sessionId) &&
      parkedStash &&
      parkedStash.turn === (this.turnCounter.get(sessionId) ?? 0)
    ) {
      this.reportOrphanStashCap(sessionId, parkedStash);
      this.streamOrphanBuffer.delete(sessionId);
      // Pass the stash's own label: by the time this delivery runs the
      // session's active prompt may already belong to a successor, and the
      // fallback lookup would then attribute this text to that turn.
      void this.deliverCancelledStash(
        chatId,
        sessionId,
        parkedStash.text,
        undefined,
        undefined,
        parkedStash.sourceLabel,
      );
    }
    if (this.pendingStreamDelete.has(sessionId)) {
      // Deferred completion (or a cancelled turn's flush below) owns the
      // teardown: the flush chain's terminal settle releases the anchor and
      // clears the turn counter / flush records when the state is still
      // current; if a successor turn replaced the state first, onPromptStart
      // (turn bump) or onSessionDied cleans them — bounded by the number of
      // live sessions, so no unbounded growth.
      return;
    }
    let state = this.streamState.get(sessionId);
    // A cancelled turn's stashed HEAD must still be delivered: while the
    // previous turn's deferred chain owned the entry, this turn's chunks went
    // to the side buffer, and a cancel never runs onResponseComplete. Merge
    // the stash into the residual buffer here — creating the state when the
    // chain already freed it — so the branches below park and flush it. A
    // stash is always older than the residual, so it is prepended.
    const stashed = this.streamOrphanBuffer.get(sessionId);
    if (stashed) {
      if (stashed.turn === (this.turnCounter.get(sessionId) ?? 0)) {
        this.reportOrphanStashCap(sessionId, stashed);
        this.streamOrphanBuffer.delete(sessionId);
        if (!state) {
          state = this.createStreamState(chatId, sessionId, '', stashed.turn);
          this.streamState.set(sessionId, state);
        }
        // The stash carries the diverted turn's attribution label (a
        // sub-agent/loop segment): without it the merged flush would go out
        // unattributed. An existing state's own label wins.
        if (
          state.sourceLabel === undefined &&
          stashed.sourceLabel !== undefined
        ) {
          state.sourceLabel = stashed.sourceLabel;
        }
        // The stash may carry a sealed pre-boundary prefix whose only other
        // copy the bridge cleared at a boundary: without it on the state, a
        // permanent failure of the flush below has nothing to hand off and the
        // opening is lost. Same merge as onResponseChunk's drain site.
        if (stashed.pre !== undefined) {
          state.sealedPre = stashed.pre + (state.sealedPre ?? '');
        }
        state.buffer = stashed.text + state.buffer;
      } else {
        this.dropOrphanStash(sessionId, stashed);
      }
    }
    // A send is in flight: defer like onResponseComplete does — the in-flight
    // chain owns the teardown. Clearing the stream entry here while
    // sendMessage is suspended (resolveRoute→fetchToken) would trip the
    // chain's identity guard, and releasing the anchor would reset the tail's
    // msg_seq to 1 after the first flush's (msg-A,1) — QQ dedupes on msg_id +
    // msg_seq and silently drops the tail. The chain's settle path performs
    // the release and state teardown exactly once.
    if (state && this.flushingSessions.has(sessionId)) {
      this.pendingStreamDelete.add(sessionId);
      return;
    }
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state && state.buffer) {
      // Cancelled turn with a buffered residual tail: onResponseComplete is
      // skipped on cancel, so the idle timer was the only path that would
      // have delivered this text — on origin/main the timer fired after
      // cancel and flushed it, and dropping it here is a silent reply loss.
      // Trigger the flush now (idleFlush → flushAndTrack keeps the full
      // sendMessage + reply-anchor + msg_seq chain), parking the session in
      // pendingStreamDelete so the chain's terminal settle performs the
      // release and state teardown. Clearing streamState before the flush
      // would trip the chain's identity guards and drop the buffer. This
      // method is sync and cannot await the async chain — ownership passes
      // to it, exactly like the deferred-completion path above.
      this.pendingStreamDelete.add(sessionId);
      this.idleFlush(sessionId, this._reconnectId);
      return;
    }
    // Release before the deletes: the release guard scans streamState +
    // flushingSessions for a live flush, so it must still see this session's
    // entry (and marker) or it would drop the msg_seq counter under a send
    // still in flight — QQ dedupes on msg_id + msg_seq and drops the tail.
    // Read the flush marker before the delete below erases it: the completion
    // record may only go once no chain can still consult it. The guard above
    // parks whenever a live stream entry has a marker, so this teardown sees
    // flushInFlight=true only when a chain holds the marker with no streamState
    // entry of its own. The deletes below clear that marker, so by the time the
    // chain settles its handOffSealedPre fails the ownsSession gate and never
    // reaches the record; the record is kept while the marker was live rather
    // than deleted beneath a settling chain, and the next onPromptStart,
    // onSessionDied, or disconnect drops it.
    const flushInFlight = this.flushingSessions.has(sessionId);
    this.releaseSessionReplyAnchor(sessionId);
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    this.turnCounter.delete(sessionId);
    if (!flushInFlight) this.completedTurns.delete(sessionId);
    this.streamOrphanBuffer.delete(sessionId);
  }

  /**
   * Deliver a cancelled turn's stashed HEAD on its OWN anchor. The session is
   * parked in pendingStreamDelete while a predecessor turn's deferred chain
   * settles, so ChannelBase skips onResponseComplete and onPromptEnd's park
   * early-return would otherwise leave this turn's stash for the next turn to
   * discard as superseded. Fire-and-forget — onPromptEnd is sync — and never
   * rejects, so a failed delivery cannot become an unhandled rejection. The
   * park flag and the predecessor's streamState entry/buffer are deliberately
   * untouched: that chain still owns them and must settle and release its own
   * anchor, and this text must not go out under the predecessor's msgId.
   *
   * This is the only delivery for a stash that onPromptEnd already deleted from
   * streamOrphanBuffer (or a sealed head handOffSealedPre cleared from
   * sealedPre), so a transient failure must not drop the text. RATE_LIMITED is
   * the one code the flush path classifies as transient, and no copy survives
   * for a later turn, so the send is re-attempted here under the same
   * maxFlushRetries bound flushAndTrack uses (<= 0 means unlimited). A
   * re-attempt is not routed through streamState/idleFlush: the turn is over,
   * so a state entry for it would be dropped as stale by the next prompt, and
   * the entry-less in-flight guard below would be lost. Every attempt
   * reuses the anchor, the attribution label and the reply context captured
   * before the first one.
   *
   * A send also fails to reach the wire without throwing when its route cannot
   * be resolved; sendMessageWithReplyContext reports that as transient (token
   * refresh failure) or permanent (disposed / unusable chatId / no chat type),
   * and the second class is dropped with a log immediately rather than spun on
   * the backoff forever. Permanent DeliveryErrors and exhaustion drop with a
   * log, as the other paths do.
   */
  private async deliverCancelledStash(
    chatId: string,
    sessionId: string,
    text: string,
    anchor?: string | null,
    anchorTimestamp?: number,
    sourceLabel?: string,
  ): Promise<void> {
    // Capture the anchor once, before the first attempt: a successor turn can
    // overwrite sessionReplyMsgId while a re-attempt is pending, and this
    // turn's text must not go out under the successor's anchor.
    const { entry: sessionAnchorEntry, msgId: sessionAnchor } =
      this.resolveSessionReplyAnchor(sessionId);
    // A caller that knows which turn this text belongs to overrides the lookup
    // above: by the time such a caller runs, a successor may already own the
    // session anchor. `null` means the caller knows there is none — deliver
    // unanchored rather than under the successor's msg_id.
    const captured =
      anchor === undefined ? sessionAnchor : (anchor ?? undefined);
    // The capture time the read site TTL-checks the override against. An anchor
    // this method resolved itself is already TTL-checked; an explicit one
    // carries the caller's timestamp (handOffSealedPre passes the state's), and
    // an expired override then goes unanchored instead of on a stale msg_id.
    const capturedTimestamp =
      anchor === undefined ? sessionAnchorEntry?.timestamp : anchorTimestamp;
    // The attribution label and the reply context are read from per-turn state
    // the successor turn replaces (activePrompts, and the reply context map via
    // getResponseMessageId), so both are captured for the same reason as the
    // anchor: a re-attempt must not describe this text as the successor's turn.
    // A caller that knows the text's own label (the stash / sealed-head sites,
    // which carry it from the turn that wrote the text) passes it explicitly;
    // the lookup is only the fallback for a caller with no such record.
    // An explicit `null` forbids the reply context too — it resolves through
    // that same successor-owned state, so using it would anchor the send to the
    // successor's msg_id, the one thing `null` rules out.
    const attributionLabel =
      sourceLabel ?? this.getResponseSourceLabel(sessionId);
    const replyContext =
      anchor === null ? undefined : this.resolveResponseReplyContext(sessionId);
    // Hold the msg_seq counter for the whole delivery, backoff sleeps included:
    // between attempts this session owns no streamState entry and no flush
    // marker, so a TTL sweep would otherwise reclaim the counter and the next
    // attempt would restart at msg_seq 1 — a pair QQ dedupes on (msg_id,
    // msg_seq) and drops silently.
    if (captured) this.beginMsgSeqSend(captured);
    let delivered = false;
    try {
      for (let attempt = 1; ; attempt++) {
        // Why the send did not reach the wire, if it did not. Read from the send
        // itself rather than probed beforehand: a probe's route can go stale
        // before the send resolves its own, which would drop the text silently,
        // and the probe would run outside the in-flight msg_seq guard below.
        let blocked: SendBlock | undefined = undefined;
        try {
          if (captured) {
            blocked = await this.sendMessageWithReplyContext(
              chatId,
              text,
              undefined,
              attributionLabel,
              captured,
              capturedTimestamp,
            );
          } else {
            // Same entry point sendResponseMessage uses, with the reply context
            // already captured: its own lookup would run against a successor's
            // activePrompts entry on a re-attempt.
            blocked = await this.sendMessageWithReplyContext(
              chatId,
              text,
              replyContext,
              attributionLabel,
            );
          }
          if (blocked === 'transient') {
            // A route that may resolve on a later attempt: feed the loop's
            // transient arm, which applies the same retry bound as a thrown
            // failure.
            throw new Error('outgoing route unresolved');
          }
        } catch (e: unknown) {
          // RETRY_EXHAUSTED / ACTIVE_MSG_DISABLED / FALLBACK_FAILED are permanent
          // (see flushAndTrack); everything else — RATE_LIMITED and a plain
          // network error — is transient and re-attempted under the bound.
          if (
            e instanceof DeliveryError &&
            (e.code === 'RETRY_EXHAUSTED' ||
              e.code === 'ACTIVE_MSG_DISABLED' ||
              e.code === 'FALLBACK_FAILED')
          ) {
            process.stderr.write(
              `[QQ:${this.name}] cancelled-stash delivery failed (${e.code}): ${sanitizeLogText(e.message, 200)}, dropping ${text.length} chars\n`,
            );
            return;
          }
          if (this.maxFlushRetries <= 0 || attempt < this.maxFlushRetries) {
            const delay =
              attempt > 1
                ? QQChannel.IDLE_FLUSH_BACKOFF_MS
                : QQChannel.IDLE_FLUSH_MS;
            process.stderr.write(
              `[QQ:${this.name}] cancelled-stash delivery failed (attempt ${attempt}): ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, retrying in ${delay}ms\n`,
            );
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              timer.unref?.();
            });
            continue;
          }
          process.stderr.write(
            `[QQ:${this.name}] cancelled-stash delivery failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, retries exhausted, dropping ${text.length} chars\n`,
          );
          return;
        }
        if (blocked === 'permanent') {
          // The route can never resolve (channel disposed, unusable chatId, no
          // chat type), so a retry cannot help even under `unlimited` retries:
          // drop it with a log rather than spinning the backoff forever.
          process.stderr.write(
            `[QQ:${this.name}] cancelled-stash delivery blocked (no usable route): dropping ${text.length} chars\n`,
          );
          return;
        }
        delivered = true;
        break;
      }
    } finally {
      if (captured) this.endMsgSeqSend(captured);
    }
    // Delivered. The release is synchronous and cannot throw (saveQQState
    // swallows write errors), it sits outside the retry try/catch so a throw
    // here can never be mistaken for a failed send and re-send text, and it
    // runs after the in-flight registration is gone so it can reclaim the
    // counter it owns.
    if (delivered && captured) {
      this.releaseSessionReplyAnchor(sessionId, captured);
    }
  }

  // ── Streaming (idle-flush with per-session buffers) ────────────

  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): void {
    const currentTurn = this.turnCounter.get(sessionId) ?? 0;
    let state = this.streamState.get(sessionId);
    if (state && state.turn !== currentTurn) {
      // A previous turn's deferred flush chain may still own this entry
      // (onPromptEnd parked the session in pendingStreamDelete with a live
      // timer that delivers its residual). It must stay untouched then: the
      // chain's identity guard (s === state) needs it to tear itself down —
      // dropping it here would strand the residual forever (its .then() sees
      // `current !== state` and returns). This chunk belongs to the new turn:
      // while the parked entry still holds a residual it is stashed in the side
      // buffer below (so this turn's opening survives the settle window),
      // otherwise it is consumed (dropped). Once the chain settles and the
      // stash has been drained, the map is empty and the next chunk starts
      // fresh.
      if (state.buffer && this.pendingStreamDelete.has(sessionId)) {
        // Stash this turn's chunks in a side buffer so the HEAD of this
        // turn's reply is not silently dropped while the old chain settles
        // (up to ~10s under rate-limit backoff); they are prepended to the
        // first fresh entry once the chain frees the slot. The entry records
        // this turn so a later teardown can tell a live stash from a
        // superseded one.
        const held = this.streamOrphanBuffer.get(sessionId);
        // This path has no flush outlet and a parked predecessor can keep it
        // parked for the process's life (`maxFlushRetries: 0` = unlimited), so
        // bound the stash like state.buffer is bounded. Keep the head — the
        // sealed opening — and log the dropped tail.
        const limit = this.streamBufferLimit(state);
        const stashed: QQOrphanStash =
          held && held.turn === currentTurn
            ? {
                turn: currentTurn,
                text: held.text + chunk,
                pre: held.pre,
                capDropped: held.capDropped,
                capLogged: held.capLogged,
                ...(segment?.sourceLabel !== undefined ||
                held.sourceLabel !== undefined
                  ? {
                      sourceLabel: segment?.sourceLabel ?? held.sourceLabel,
                    }
                  : {}),
              }
            : {
                turn: currentTurn,
                text: chunk,
                ...(segment?.sourceLabel !== undefined
                  ? { sourceLabel: segment.sourceLabel }
                  : {}),
              };
        if (stashed.text.length > limit) {
          const before = stashed.text.length;
          // Cap in UTF-16 units on code-point boundaries, so the cut cannot
          // split a surrogate pair.
          stashed.text = truncateUtf16Units(stashed.text, limit);
          const droppedText = before - stashed.text.length;
          // `pre` is a prefix of `text` and is what onResponseComplete
          // prepends, so trimming the tail must trim it too. Those characters
          // are the ones `droppedText` already counts (the prefix trim is a
          // subset of the text trim), so the trim is reported but never added
          // to the loss again — counting both would report characters that
          // were never in the stash a second time.
          let preTrimmed = false;
          if (stashed.pre && stashed.pre.length > stashed.text.length) {
            preTrimmed = true;
            stashed.pre = stashed.text;
          }
          // One line per episode, not per chunk: the divert window can stay
          // open for the process's life, so the first overflow reports the
          // loss immediately and every later chunk only accumulates. The
          // cumulative total is reported once when the stash leaves the buffer
          // (reportOrphanStashCap).
          stashed.capDropped = (stashed.capDropped ?? 0) + droppedText;
          if ((stashed.capLogged ?? 0) === 0) {
            stashed.capLogged = stashed.capDropped;
            process.stderr.write(
              `[QQ:${this.name}] dropping ${droppedText} chars of diverted turn ${currentTurn} stash` +
                (preTrimmed ? ` and its sealed pre` : '') +
                ` over the buffer limit for ${sanitizeLogText(sessionId, 64)}\n`,
            );
          }
        }
        this.streamOrphanBuffer.set(sessionId, stashed);
        // Self-heal: if the parked entry has no send in flight, its settle
        // chain can never run again (idleFlush discards on a reconnect
        // generation mismatch without clearing the handle), leaving
        // pendingStreamDelete armed for the rest of the process and diverting
        // every later turn out of the streaming path. Re-arm the idle flush
        // with the CURRENT generation so the residual can settle and un-park
        // the session. A handle already live under this generation must be
        // left alone: re-arming on every chunk would push the parked
        // residual's deadline out for as long as the successor streams.
        const timerLive =
          state.timer !== null && state.timerReconnectId === this._reconnectId;
        if (!this.flushingSessions.has(sessionId) && !timerLive) {
          if (state.timer) clearTimeout(state.timer);
          const reconnectId = this._reconnectId;
          state.timer = setTimeout(() => {
            this.idleFlush(sessionId, reconnectId);
          }, QQChannel.IDLE_FLUSH_MS);
          state.timerReconnectId = reconnectId;
          state.timer.unref?.();
        }
        return;
      }
      // Superseded turn (a deferred send parked the entry and the new prompt
      // started before the send settled): drop the entry so this turn's
      // chunks cannot append to the old buffer or go out under the old
      // msgId. Any chars still buffered belong to the dead turn and are
      // discarded — with a log so the loss is observable rather than silent.
      // The old chain is safe: its .then()/.catch() identity guards compare
      // the map entry against the captured state object, and the fresh entry
      // created below fails that guard, so the chain can release only its
      // own anchor (expectedMsgId) and never touch a successor's. The
      // parking/flush records must be cleared here: the old chain's guards
      // now fail against the fresh entry and would never delete them —
      // stranding the session so the new turn's onResponseComplete/
      // onPromptEnd both early-return and the buffer is never flushed
      // (silent reply loss). flushingSessions is left alone: it is
      // ownership-keyed, and clearing it here would let the new turn start a
      // second concurrent send while the old tail send is still awaited.
      if (state.buffer) {
        process.stderr.write(
          `[QQ:${this.name}] dropping ${state.buffer.length} chars of superseded turn ${state.turn} for ${sanitizeLogText(sessionId, 64)}\n`,
        );
      }
      // Disarm the entry before the release below: the release guard treats a
      // truthy timer handle or a non-empty buffer as a live flush and vetoes
      // the counter, but this block deletes the entry a few lines later, so no
      // path can ever re-drive that flush. clearTimeout leaves the handle
      // truthy, so null it explicitly. flushingSessions is deliberately left
      // set: a genuinely in-flight send must still veto the release.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.buffer = '';
      // The entry carries the sealed pre-boundary head, which the boundary
      // cleared from the bridge's collection — dropping it here would truncate
      // this turn's opening with no other copy. Hand it off before the delete,
      // like every other doomed-entry site — but ONLY when this state is not
      // the session's in-flight flush owner: that chain's payload
      // already carries the head, its success path clears sealedPre, and its
      // permanent-failure arm re-stashes an undelivered head. Handing off here
      // too would deliver the head twice; the guard alone would lose it if that
      // chain gives up, so its transient arm hands off whenever no retry was
      // scheduled for this state (the retryScheduled predicate below).
      if (this.flushingSessions.get(sessionId) !== state) {
        this.handOffSealedPre(state, sessionId);
      }
      // Release before the delete: the release guard scans streamState +
      // flushingSessions for a live flush, so it must still see this entry's
      // in-flight marker or it would drop the msg_seq counter under a send
      // still in flight — QQ dedupes on msg_id + msg_seq and silently drops
      // the tail. The expectedMsgId identity check keeps a successor turn's
      // anchor untouched while still cascading this turn's counter away.
      if (state.msgId !== undefined) {
        this.releaseSessionReplyAnchor(sessionId, state.msgId);
      }
      this.streamState.delete(sessionId);
      this.pendingStreamDelete.delete(sessionId);
      this.flushedSessions.delete(sessionId);
      state = undefined;
    }
    if (!state) {
      // createStreamState below reuses this session's reply anchor across
      // buffer windows and drops it past its TTL — the rationale lives there.
      const held = this.streamOrphanBuffer.get(sessionId);
      let sealedPre: string | undefined;
      if (held !== undefined) {
        if (held.turn === currentTurn) {
          // The previous turn's deferred chain has settled and freed the
          // streamState entry — prepend the stashed chunks so this turn's
          // reply HEAD is delivered in order.
          this.reportOrphanStashCap(sessionId, held);
          this.streamOrphanBuffer.delete(sessionId);
          // The sealed pre-boundary head has no other copy (the bridge cleared
          // its collection at the boundary), so carry it on the state until the
          // drained send settles: a permanent failure re-stashes it below.
          sealedPre = held.pre;
          chunk = held.text + chunk;
        } else {
          this.dropOrphanStash(sessionId, held);
        }
      }
      state = this.createStreamState(
        chatId,
        sessionId,
        chunk,
        currentTurn,
        segment,
      );
      if (sealedPre !== undefined) state.sealedPre = sealedPre;
      this.streamState.set(sessionId, state);
    } else {
      state.sourceLabel ??= segment?.sourceLabel;
      state.buffer += chunk;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    // Size-cap flush: reserve room for the independently rendered source
    // label and prevent concurrent sends.
    if (state.buffer.length >= this.streamBufferLimit(state)) {
      const buf = state.buffer;
      state.buffer = '';
      if (this.flushingSessions.has(sessionId)) {
        // Send in-flight — re-buffer and let the in-flight send's .then() pick it up
        state.buffer = buf + (state.buffer || '');
        const reconnectId = this._reconnectId;
        state.timer = setTimeout(() => {
          this.idleFlush(sessionId, reconnectId);
        }, QQChannel.IDLE_FLUSH_MS);
        state.timerReconnectId = reconnectId;
        state.timer.unref?.();
        return;
      }
      this.flushAndTrack(sessionId, buf, state, 'idleFlush');
      return;
    }
    const reconnectId = this._reconnectId;
    state.timer = setTimeout(() => {
      this.idleFlush(sessionId, reconnectId);
    }, QQChannel.IDLE_FLUSH_MS);
    state.timerReconnectId = reconnectId;
    state.timer.unref?.();
  }

  private idleFlush(sessionId: string, reconnectId: number): void {
    if (this._reconnectId !== reconnectId) {
      const parked = this.streamState.get(sessionId);
      if (this.pendingStreamDelete.has(sessionId) && parked?.buffer) {
        // The generation bumped while a residual was parked and no further
        // chunk will arrive to self-heal it, so discarding here would strand
        // the text and leave pendingStreamDelete armed forever. Re-arm under
        // the current generation; the re-armed timer carries that generation,
        // so it only re-arms again if another bump happens.
        if (parked.timer) clearTimeout(parked.timer);
        const currentReconnectId = this._reconnectId;
        parked.timer = setTimeout(() => {
          this.idleFlush(sessionId, currentReconnectId);
        }, QQChannel.IDLE_FLUSH_MS);
        parked.timerReconnectId = currentReconnectId;
        parked.timer.unref?.();
        process.stderr.write(
          `[QQ:${this.name}] idleFlush re-armed after reconnect session=${sanitizeLogText(sessionId, 32)}\n`,
        );
      } else {
        process.stderr.write(
          `[QQ:${this.name}] idleFlush discarded (reconnect) session=${sanitizeLogText(sessionId, 32)}\n`,
        );
      }
      return;
    }
    const state = this.streamState.get(sessionId);
    if (!state || !state.buffer) return;
    if (this.flushingSessions.has(sessionId)) {
      // Another send is in-flight — re-schedule the idle timer so we retry
      // later. The handle on state.timer may be our own expired-but-truthy
      // timer (it fired while still blocked): clear it so the re-arm below
      // is unconditional and the tail can never be stranded.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const retryReconnectId = this._reconnectId;
      state.timer = setTimeout(() => {
        this.idleFlush(sessionId, retryReconnectId);
      }, QQChannel.IDLE_FLUSH_MS);
      state.timerReconnectId = retryReconnectId;
      state.timer.unref?.();
      return;
    }
    const buffer = state.buffer;
    state.buffer = '';
    state.timer = null; // Clear expired one-shot timer reference
    this.flushAndTrack(sessionId, buffer, state, 'idleFlush');
  }

  /**
   * Shared send-and-track helper used by idleFlush and onToolCall.
   * Encapsulates .then() (cleanup on success) and .catch() (retry/re-buffer
   * on failure) logic to eliminate duplication.
   */
  private flushAndTrack(
    sessionId: string,
    buffer: string,
    state: QQStreamState,
    logLabel: string,
  ): void {
    this.flushingSessions.set(sessionId, state);
    // The seal this payload carries, if any. A boundary can seal NEW text while
    // this send is in flight (chunks keep arriving into state.buffer), and that
    // seal describes the residual, not this payload — read it once here so the
    // success path below clears only what this send actually delivered.
    const carriedSeal = state.sealedPre;
    // Scoped to this flight: the boundary hooks set this if a boundary clears
    // the bridge's collection before this send settles. A stale value from an
    // earlier flight would re-seal text this payload never carried.
    state.boundaryClearedInFlight = undefined;
    // Terminal release owed by this chain, performed in .finally() after the
    // ownership-keyed marker is cleared: releasing while the marker is still
    // set makes releaseSessionReplyAnchor's in-flight guard return early, and
    // the state entry is dropped just below, so the msg_seq counter would
    // otherwise leak forever.
    let deferredRelease: string | undefined;
    // sendMessage throws DeliveryError for delivery failures.
    // RETRY_EXHAUSTED, ACTIVE_MSG_DISABLED, and FALLBACK_FAILED are
    // permanent. RATE_LIMITED is transient and falls through to re-buffer/retry.
    this.sendMessageWithReplyContext(
      state.chatId,
      buffer,
      state.replyContext,
      state.sourceLabel,
      state.msgId,
      state.msgIdTimestamp,
    )
      .then(() => {
        // This send carried the sealed pre-boundary head (the drain folded it
        // into this buffer), so it must not be re-stashed by a later permanent
        // failure — onResponseComplete would prepend it and deliver a second
        // standalone copy. Clear it on both success paths (state current and
        // session died) because the head is out either way. Guarded on identity
        // and on the per-flight marker: a boundary that re-sealed the live
        // turn's residual during the flight wrote a seal that was never in this
        // payload and is that residual's only copy, so clearing it here would
        // drop the text when the residual's own flush fails permanently. The
        // seal text alone cannot tell the two apart — the residual may repeat
        // the carried seal byte for byte. 'payload' is not a re-seal: the
        // boundary stripped the delivery from fullText without rewriting
        // sealedPre, so this send still carried that seal.
        if (
          state.sealedPre === carriedSeal &&
          state.boundaryClearedInFlight !== 'residual'
        ) {
          state.sealedPre = undefined;
        }
        // #3: Guard — if session died during in-flight send, touch nothing
        // of the entry's, but do release the anchor: no later settle can run
        // for this state, so otherwise its msg_seq counter is stranded.
        const current = this.streamState.get(sessionId);
        if (current !== state) {
          if (state.msgId !== undefined) {
            this.releaseSessionReplyAnchor(sessionId, state.msgId);
          }
          return;
        }
        current.retryCount = 0;
        this.flushedSessions.add(sessionId);

        if (this.pendingStreamDelete.has(sessionId)) {
          this.pendingStreamDelete.delete(sessionId);
          // #2: Flush immediately — idle timer would add unnecessary delay
          // onResponseComplete already fired. When a residual buffer is still
          // queued, do NOT release the per-session reply anchor here: the
          // re-flush's sendMessage reads msg_seq from msgSeqMap, and dropping
          // the counter now would reset msg_seq to 1 (QQ dedupes on msg_id +
          // msg_seq and silently drops the tail). Re-arm the pending flag so
          // whichever branch settles the re-flush chain (its .then() success
          // path, or .catch() retry/exhaustion) performs the release exactly
          // once.
          const s = this.streamState.get(sessionId);
          if (s === state && s.buffer) {
            this.pendingStreamDelete.add(sessionId);
            // Don't clear buffer or retryCount — idleFlush will pick them up.
            // Clear any stale timer handle first so idleFlush's blocked-branch
            // re-arm is unconditional.
            if (s.timer) {
              clearTimeout(s.timer);
              s.timer = null;
            }
            this.idleFlush(sessionId, this._reconnectId);
            // Don't return — let .finally() clear flushingSessions
            // so deferred idleFlush can proceed.
          } else {
            // No own anchor (proactive turn / expired TTL) — nothing to
            // release, and an unconditional release here would delete a
            // successor turn's anchor. See .catch() release points.
            deferredRelease = state.msgId;
            if (s === state) {
              // Terminal settle of a deferred/cancelled turn while this state
              // is still current: the turn is fully over, so drop the flush
              // record and turn counter that onResponseComplete/onPromptEnd
              // would otherwise have cleaned. Guarded by `s === state` — a
              // successor turn that replaced the state owns its own
              // turnCounter/flushedSessions and must be left untouched.
              this.flushedSessions.delete(sessionId);
              this.deleteTurnGenerationIfOwned(state, sessionId);
            }
          }
        }

        // #8: Clean up streamState only if no content arrived during send.
        // NOTE: does NOT release sessionReplyMsgId here — a mid-response
        // window gap (no onResponseComplete yet) must keep the anchor so the
        // next window's fresh state entry reuses it.
        const s = this.streamState.get(sessionId);
        if (s === state && !s.buffer) {
          this.streamState.delete(sessionId);
        }
      })
      .catch((e: unknown) => {
        if (
          e instanceof DeliveryError &&
          (e.code === 'RETRY_EXHAUSTED' ||
            e.code === 'ACTIVE_MSG_DISABLED' ||
            e.code === 'FALLBACK_FAILED')
        ) {
          // The text that accumulated into state.buffer while this send was in
          // flight is dropped with the entry below, so the loss log must report
          // it too: the payload count alone under-reports what the operator
          // loses. Except the residual a boundary captured: captureBoundaryClear
          // copies exactly that text into sealedPre and flags the flight
          // 'residual', and the handoff seal below preserves and delivers it
          // separately, so counting it here would report the same characters
          // twice. Only the buffer beyond the captured residual is lost here.
          //
          // The same holds for the payload itself in the branch below that
          // folds it into the handoff seal (`boundaryClearedInFlight` set while
          // this entry still owns the live turn): the seal is then delivered or
          // re-stashed, so those characters are preserved, not dropped, and
          // counting them would report the payload as lost while the operator
          // still receives it. Only the in-flight text beyond the captured
          // residual is genuinely lost in that branch. Gated on ownsSession
          // like the handoff itself: an unowned entry's seal is dropped (and
          // logged) by handOffSealedPre, so its whole payload is a real loss.
          const payloadFoldedIntoSeal =
            state.boundaryClearedInFlight !== undefined &&
            this.ownsLiveTurn(sessionId, state) &&
            this.ownsSession(sessionId, state);
          // The else arm of the handoff below preserves the seal this send
          // carried: the payload's own head when the drain folded the stash's
          // `pre` in front of its text (a boundary between a chunk and the idle
          // flush is a normal sequence, and it leaves exactly that seal on the
          // entry). handOffSealedPre re-stashes or delivers it, so those
          // characters are preserved while the rest of the payload is not —
          // charging the whole payload reports delivered text as lost. No
          // carried seal preserves nothing, so the whole payload stays a real
          // loss. Gated on ownsSession like the handoff itself: an unowned
          // entry's seal is dropped (and logged) by handOffSealedPre.
          const payloadPreservedBySeal =
            !payloadFoldedIntoSeal &&
            carriedSeal !== undefined &&
            this.ownsSession(sessionId, state)
              ? Math.min(carriedSeal.length, buffer.length)
              : 0;
          const preservedInFlight = payloadFoldedIntoSeal
            ? buffer.length
            : payloadPreservedBySeal;
          const droppedInFlight =
            state.buffer.length - this.capturedResidual(state).length;
          const droppedParts: string[] = [];
          const lostInFlight = buffer.length - preservedInFlight;
          if (lostInFlight > 0) {
            droppedParts.push(`${lostInFlight} chars`);
          }
          if (droppedInFlight > 0) {
            droppedParts.push(`${droppedInFlight} chars buffered in flight`);
          }
          process.stderr.write(
            `[QQ:${this.name}] ${logLabel} delivery failed (${e.code}): ${sanitizeLogText(e.message, 200)}, ` +
              (droppedParts.length > 0
                ? `dropping ${droppedParts.join(' plus ')}`
                : preservedInFlight > 0
                  ? `dropping nothing (${preservedInFlight} chars preserved in the handoff seal)`
                  : 'dropping nothing') +
              '\n',
          );
          // RETRY_EXHAUSTED / ACTIVE_MSG_DISABLED / FALLBACK_FAILED = permanent failure.
          // Drop everything — including any residual buffer that arrived concurrently.
          const current = this.streamState.get(sessionId);
          // Hand the sealed pre-boundary head off BEFORE any delete and outside
          // the identity guard below: this entry carries the only copy,
          // and the boundary cleared the bridge's collection so it is absent
          // from fullText. The handoff is itself gated on session ownership
          // inside handOffSealedPre (ownsSession), which drops the seal when the
          // session was torn down or replaced outright. A superseded state
          // reached here precisely because the superseded branch left the head
          // in place for the in-flight owner — when this send is that owner and
          // it fails permanently, this arm is the only remaining chance to
          // re-stash it; a parked turn with no successor delivers it on its own
          // anchor. handOffSealedPre is idempotent (it clears sealedPre at
          // its top), so a state that already handed off is a no-op. The seal
          // this send carried is passed too: a boundary may have re-sealed the
          // state while it was in flight, and only this chain knows the older
          // head ever existed. When such a boundary cleared the collection
          // during the flight, the entry's seal is widened to the whole payload
          // first (folded in, so the merge below is not applied twice) — but
          // only while this state still owns the live turn: a superseded
          // entry's text is abandoned with its permanent failure and must not
          // be injected into a successor's reply.
          if (payloadFoldedIntoSeal) {
            state.sealedPre = this.sealClearedPayload(
              buffer,
              this.capturedResidual(state),
            );
            this.handOffSealedPre(state, sessionId);
          } else {
            this.handOffSealedPre(state, sessionId, undefined, carriedSeal);
          }
          if (current === state) {
            this.streamState.delete(sessionId);
          }
          // Release only when the settle is terminal (the session was parked
          // for teardown) or this entry was superseded by a later turn. While
          // this state is still the session's live turn, the anchor belongs to
          // the reply still streaming: releasing it now cascades the
          // msgSeqMap counter away, and the next chunk re-resolves the same
          // msg_id from replyContextByMessageId and restarts msg_seq at 1 —
          // a pair QQ already accepted, which it dedupes and silently drops.
          // onResponseComplete's terminal release reclaims it at turn end.
          const turnStillLive =
            this.ownsLiveTurn(sessionId, state) &&
            !this.pendingStreamDelete.has(sessionId);
          if (!turnStillLive && state.msgId !== undefined) {
            this.releaseSessionReplyAnchor(sessionId, state.msgId);
          }
          // Only consume the park/flush records when this chain still owns
          // the session's entry: a successor turn that parked its own
          // residual must keep its flags.
          if (current === state && this.pendingStreamDelete.has(sessionId)) {
            this.pendingStreamDelete.delete(sessionId);
            this.flushedSessions.delete(sessionId);
            this.deleteTurnGenerationIfOwned(state, sessionId);
          }
          return;
        }

        process.stderr.write(
          `[QQ:${this.name}] ${logLabel} send failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
        // #1: Never undo previously-succeeded flush records on failure
        //
        // The sealed pre-boundary head must be handed off exactly when
        // this chain gives up on delivering it, and the chain gives up when it
        // neither succeeded nor scheduled a retry FOR THIS STATE. The predicate
        // is therefore "scheduled a retry", NOT "msgId present": a state with
        // no msgId (session anchor expired mid-turn, or a proactive turn) still
        // carries a head, and gating the handoff on msgId drops it. Every
        // branch below that arms a retry for `current === state` sets this
        // flag; every other transient path falls through to the handoff at the
        // end of this arm, which covers pending/non-pending x current/not.
        let retryScheduled = false;

        if (this.pendingStreamDelete.has(sessionId)) {
          // Session is ending - retry up to MAX_FLUSH_RETRIES. When a retry is
          // scheduled, re-arm the pending flag so whichever branch settles the
          // retry chain (its .then() success path, or exhaustion below)
          // performs the anchor release exactly once — releasing earlier would
          // reset msg_seq for the retried tail send (see .then() above).
          const current = this.streamState.get(sessionId);
          // Only consume the park flag when this chain still owns the
          // session's entry: a successor turn that parked its own residual
          // must keep its flag.
          if (current === state) {
            this.pendingStreamDelete.delete(sessionId);
            // Prepend the failed send's text to whatever accumulated during
            // the in-flight send (same order as the non-pending branch) so
            // neither portion is silently dropped.
            current.buffer = buffer + (current.buffer || '');
            // The failed payload is buffer-resident again and must be sealed.
            // A boundary that cleared the bridge's collection while this send
            // was in flight removed the payload's whole text from fullText —
            // the seal it carried may cover only a prefix — so the whole
            // payload is re-sealed, plus the residual it sealed itself (flagged
            // deterministically, not by comparing seal text). Only a chain that
            // still owns the live turn may write the seal: a superseded
            // entry's payload is abandoned with its failure and must not be
            // injected into a successor's reply. The carried-seal
            // branch is the backstop for a re-seal whose boundary marker was
            // missed.
            this.resealOnRebuffer(
              sessionId,
              state,
              current,
              buffer,
              carriedSeal,
            );
            current.retryCount++;
            if (
              this.maxFlushRetries <= 0 ||
              current.retryCount < this.maxFlushRetries
            ) {
              this.pendingStreamDelete.add(sessionId);
              const reconnectId = this._reconnectId;
              const delay =
                current.retryCount > 1
                  ? QQChannel.IDLE_FLUSH_BACKOFF_MS
                  : QQChannel.IDLE_FLUSH_MS;
              current.timer = setTimeout(() => {
                this.idleFlush(sessionId, reconnectId);
              }, delay);
              current.timerReconnectId = reconnectId;
              current.timer.unref?.();
              // Retry armed for this state — this chain still owns the head.
              retryScheduled = true;
            } else {
              // The entry carries the sealed pre-boundary head; hand it off
              // before the delete drops the only copy (see handOffSealedPre).
              // This branch consumed the park flag above, so it states the
              // turn is over explicitly — otherwise the handoff would re-stash
              // into a turn whose counter it is about to drop.
              this.handOffSealedPre(state, sessionId, true);
              this.streamState.delete(sessionId);
              if (state.msgId !== undefined) {
                this.releaseSessionReplyAnchor(sessionId, state.msgId);
              }
              // #2: Clean up flushedSessions on retry exhaustion
              this.flushedSessions.delete(sessionId);
              // Deferred turn fully abandoned — drop its turn-generation
              // records only when they still belong to this turn.
              this.deleteTurnGenerationIfOwned(state, sessionId);
              process.stderr.write(
                `[QQ:${this.name}] ${logLabel} retries exhausted for ${sanitizeLogText(sessionId, 64)}\n`,
              );
            }
          }
        } else {
          // Not ending - re-buffer and retry
          const current = this.streamState.get(sessionId);
          // #6: Identity guard — only operate on the same state reference
          if (current === state) {
            current.buffer = buffer + (current.buffer || '');
            // Same re-seal and turn-ownership rule as the parked branch above
            // (see resealOnRebuffer for why the whole payload is sealed and
            // `carriedSeal` is the backstop).
            this.resealOnRebuffer(
              sessionId,
              state,
              current,
              buffer,
              carriedSeal,
            );
            // #3: If re-buffer exceeds max length, flush immediately
            if (current.buffer.length >= this.streamBufferLimit(current)) {
              current.retryCount++;
              if (
                this.maxFlushRetries > 0 &&
                current.retryCount >= this.maxFlushRetries
              ) {
                // Hand the sealed pre-boundary head off before the delete
                // drops the only copy (see handOffSealedPre).
                this.handOffSealedPre(state, sessionId);
                this.streamState.delete(sessionId);
                // No release here: the turn is not over (onResponseComplete
                // has not fired) — the anchor still belongs to this reply,
                // and onResponseComplete's terminal release cleans it up.
                // Releasing now would make later chunks fall back to the
                // racy chat-level entry.
                this.flushedSessions.delete(sessionId);
                process.stderr.write(
                  `[QQ:${this.name}] ${logLabel} retries exhausted (buffer exceeds limit) for ${sanitizeLogText(sessionId, 64)}\n`,
                );
              } else {
                // Retry armed for this state (idleFlush re-flushes now, or
                // re-arms while a send is in flight): this chain owns the head.
                retryScheduled = true;
                this.idleFlush(sessionId, this._reconnectId);
              }
            } else {
              current.retryCount++;
              if (
                this.maxFlushRetries <= 0 ||
                current.retryCount < this.maxFlushRetries
              ) {
                if (!current.timer) {
                  const reconnectId = this._reconnectId;
                  const delay =
                    current.retryCount > 1
                      ? QQChannel.IDLE_FLUSH_BACKOFF_MS
                      : QQChannel.IDLE_FLUSH_MS;
                  current.timer = setTimeout(() => {
                    this.idleFlush(sessionId, reconnectId);
                  }, delay);
                  current.timerReconnectId = reconnectId;
                  current.timer.unref?.();
                }
                // Retry armed (or already pending) for this state — this chain
                // still owns the head.
                retryScheduled = true;
              } else {
                // Hand the sealed pre-boundary head off before the delete
                // drops the only copy (see handOffSealedPre).
                this.handOffSealedPre(state, sessionId);
                this.streamState.delete(sessionId);
                // No release here — same rationale as the buffer-over-limit
                // branch above: the turn has not ended, so the anchor is
                // still this reply's and onResponseComplete's terminal
                // release will clean it up.
                // #2: Clean up flushedSessions on retry exhaustion
                this.flushedSessions.delete(sessionId);
                process.stderr.write(
                  `[QQ:${this.name}] ${logLabel} retries exhausted for ${sanitizeLogText(sessionId, 64)}\n`,
                );
              }
            }
          } else if (state.msgId !== undefined) {
            // The entry was destroyed while this send was in flight (session
            // death or a successor turn). Nothing will settle for this state,
            // so release its anchor here — expectedMsgId keeps a successor's
            // anchor untouched. The sealed head is NOT handled here:
            // ownership passes on by the retryScheduled check at the end of
            // this arm, whose predicate is "no retry armed for this state",
            // not "msgId present".
            this.releaseSessionReplyAnchor(sessionId, state.msgId);
          }
        }
        // No branch above armed a retry for this state, so this chain
        // has given up on delivering the sealed pre-boundary head — pass its
        // ownership on. handOffSealedPre is idempotent (it clears sealedPre at
        // its top), so the exhaustion arms that already handed off are
        // unaffected. Deliberately not gated on msgId: the head's ownership is
        // independent of the reply anchor.
        if (!retryScheduled) {
          this.handOffSealedPre(state, sessionId);
        }
      })
      .finally(() => {
        // Ownership-keyed release: only the chain that still owns the marker
        // may clear it, so a superseded chain cannot unblock a successor's
        // concurrent send.
        if (this.flushingSessions.get(sessionId) !== state) return;
        this.flushingSessions.delete(sessionId);
        if (deferredRelease !== undefined) {
          this.releaseSessionReplyAnchor(sessionId, deferredRelease);
        }
        // A successor turn can only park while this chain's marker is live
        // (onResponseComplete/onPromptEnd test .has(), not identity), so every
        // settle path above guards on the state reference and never reaches
        // the park flag. Service it here — the one place that knows the marker
        // just became free — by handing the residual to a fresh idle timer;
        // the re-flush's own settle then consumes the flag.
        if (this.pendingStreamDelete.has(sessionId)) {
          const parked = this.streamState.get(sessionId);
          if (parked && parked !== state) {
            if (parked.buffer) {
              if (parked.timer) clearTimeout(parked.timer);
              const reconnectId = this._reconnectId;
              parked.timer = setTimeout(() => {
                this.idleFlush(sessionId, reconnectId);
              }, QQChannel.IDLE_FLUSH_MS);
              parked.timerReconnectId = reconnectId;
              parked.timer.unref?.();
            } else {
              // No residual to deliver — the turn is over, so run the terminal
              // teardown now rather than leaving the park flag to outlive it.
              // Clear the timer first: the release guard scans this entry for a
              // live handle and would otherwise keep the msg_seq counter for a
              // turn that is already gone.
              if (parked.timer) {
                clearTimeout(parked.timer);
                parked.timer = null;
              }
              if (parked.msgId !== undefined) {
                this.releaseSessionReplyAnchor(sessionId, parked.msgId);
              }
              this.pendingStreamDelete.delete(sessionId);
              this.flushedSessions.delete(sessionId);
              this.deleteTurnGenerationIfOwned(parked, sessionId);
              if (this.streamState.get(sessionId) === parked) {
                this.streamState.delete(sessionId);
              }
            }
          }
        }
      });
  }

  /**
   * Drop the session's turn-generation records — the turn counter and the
   * completion record completedTurns — only when they still belong to the
   * settling turn. A successor turn that started while this chain was in flight
   * bumped the counter and cleared the completion record already (see
   * onPromptStart); deleting them here would reset the successor's stale-state
   * detection to 0 and let a stale completion record alias onto its turn.
   */
  private deleteTurnGenerationIfOwned(
    state: { turn: number },
    sessionId: string,
  ): void {
    if (state.turn !== (this.turnCounter.get(sessionId) ?? 0)) return;
    this.turnCounter.delete(sessionId);
    if (this.completedTurns.get(sessionId) === state.turn) {
      this.completedTurns.delete(sessionId);
    }
  }

  override onToolCall(_chatId: string, event: ToolCallEvent): void {
    const state = this.streamState.get(event.sessionId);
    if (!state || !state.buffer) return;
    if (this.flushingSessions.has(event.sessionId)) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const buffer = state.buffer;
    state.buffer = '';
    this.flushAndTrack(event.sessionId, buffer, state, 'toolCallFlush');
  }

  protected override onResponseBoundary(
    _chatId: string,
    sessionId: string,
  ): void {
    const state = this.streamState.get(sessionId);
    const currentTurn = this.turnCounter.get(sessionId) ?? 0;
    // The bridge's collection is cleared here, in-flight payload included: seal
    // the live turn's residual and record what a re-buffer must re-seal. The
    // ungated bridge observer reaches the same seal when this hook is
    // suppressed. The bridge's chunk collection is cleared on every boundary,
    // so a stash accumulated before this point is no longer part of any later
    // fullText and must still be prepended when the turn completes. Seal that
    // portion separately: chunks arriving after the boundary append to `text`
    // but are already in fullText and must not be prepended too.
    this.captureBoundaryClear(sessionId);
    this.sealOrphanStash(sessionId);
    // A stale entry belongs to an earlier turn; when the deletes below drop it
    // its parked flush chain can never settle again, so its reply anchor has
    // to be released here (expectedMsgId-gated, so a live turn's own anchor is
    // untouched). A stale entry kept by the branch below must NOT release: it
    // still needs the anchor to deliver its residual.
    const staleMsgId =
      state && state.turn !== currentTurn ? state.msgId : undefined;
    if (
      state &&
      (state.buffer ||
        this.flushingSessions.has(sessionId) ||
        this.pendingStreamDelete.has(sessionId))
    ) {
      // An unflushed residual must survive the boundary. The bridge emits this
      // boundary immediately before the tool-call/permission event that
      // QQChannel.onToolCall flushes that very buffer with, so deleting the
      // entry here silently destroys the pre-tool text. A send still in flight
      // or a turn parked for teardown has the same claim on its residual — no
      // other path can re-deliver it. Keep the entry; the tool-call event (or
      // the idle timer below) delivers it.
      // Do NOT arm pendingStreamDelete: for the in-flight case that flag means
      // "the turn is over", and for the parked case it is already armed. This
      // is a mid-turn window gap, so hand the residual to the idle timer
      // instead — idleFlush's blocked branch re-arms while the send is live.
      if (state.buffer) {
        // The live turn's prefix is already sealed above by
        // captureBoundaryClear, which applies the same live-turn gate.
        // Leave a handle already live under this generation alone: a parked
        // retry's backoff timer is already going to deliver this residual, and
        // re-arming at the shorter idle cadence on every boundary would
        // collapse that tier and push the parked residual's deadline out. Same
        // guard as the divert self-heal below.
        const timerLive =
          state.timer !== null && state.timerReconnectId === this._reconnectId;
        if (!timerLive) {
          if (state.timer) clearTimeout(state.timer);
          const reconnectId = this._reconnectId;
          state.timer = setTimeout(() => {
            this.idleFlush(sessionId, reconnectId);
          }, QQChannel.IDLE_FLUSH_MS);
          state.timerReconnectId = reconnectId;
          state.timer.unref?.();
        }
      }
      return;
    }
    // The entry is being dropped: disarm its timer before the delete.
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    if (staleMsgId !== undefined) {
      this.releaseSessionReplyAnchor(sessionId, staleMsgId);
    }
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): Promise<void> {
    const state = this.streamState.get(sessionId);
    const currentTurn = this.turnCounter.get(sessionId) ?? 0;
    // This turn's completion has run — the deferred branch below counts too.
    // It will not run again for this turn, so a stash tagged with it would have
    // no guaranteed consumer: record that for handOffSealedPre.
    this.completedTurns.set(sessionId, currentTurn);
    if (state && state.turn !== currentTurn) {
      // Stale entry owned by a previous turn's deferred flush chain — it
      // will deliver its own residual and tear itself down. Send this turn's
      // text through the base path so it is neither lost nor mixed with the
      // old turn's anchor.
      // This turn's own anchor (set by onPromptStart) may still be valid —
      // use it instead of falling back to the racy chat-level entry, which
      // this PR exists to avoid re-parenting onto.
      // A live turn's stashed pre-boundary text is prepended only when a
      // boundary has cleared the bridge's chunk collection since it was
      // taken; otherwise fullText already carries those chunks and prepending
      // would deliver the head twice. A superseded stash is dropped
      // with a log.
      let replyText = fullText;
      const held = this.streamOrphanBuffer.get(sessionId);
      if (held !== undefined) {
        if (held.turn === currentTurn) {
          this.reportOrphanStashCap(sessionId, held);
          this.streamOrphanBuffer.delete(sessionId);
          if (held.pre) {
            replyText = held.pre + fullText;
          }
        } else {
          this.dropOrphanStash(sessionId, held);
        }
      }
      const { entry: capturedEntry, msgId: captured } =
        this.resolveSessionReplyAnchor(sessionId);
      try {
        if (captured) {
          // Keep the [sender · task] attribution: sendMessage hardcodes an
          // undefined sourceLabel, so the anchored send goes through the
          // reply-context helper. The stale entry's own sourceLabel belongs to
          // the old turn, so only this turn's label is used.
          // Mark the send in flight for the release guard: the surviving
          // streamState entry carries the OLD turn's msgId, so the
          // streamState/flushingSessions check cannot see this send.
          this.beginMsgSeqSend(captured);
          try {
            await this.sendFinalSegmentChecked(sessionId, held, () =>
              this.sendMessageWithReplyContext(
                chatId,
                replyText,
                undefined,
                segment?.sourceLabel ?? this.getResponseSourceLabel(sessionId),
                captured,
                capturedEntry?.timestamp,
              ),
            );
          } finally {
            this.endMsgSeqSend(captured);
          }
        } else {
          // super.onResponseComplete types as void and dispatches to the QQ
          // sendResponseMessage override, which drops the SendBlock — an
          // anchorless stale completion (this turn's own reply anchor absent or
          // past REPLY_MSG_ID_TTL_MS) would look delivered to the catch below,
          // which only sees throws. Send what the base path sends and route the
          // block through the checked helper.
          await this.sendFinalSegmentChecked(sessionId, held, () =>
            this.sendMessageWithReplyContext(
              chatId,
              replyText,
              this.resolveResponseReplyContext(sessionId),
              this.getResponseSourceLabel(sessionId),
            ),
          );
        }
      } catch (e: unknown) {
        this.logLostSealedHead(held?.pre, sessionId, e);
        throw e;
      } finally {
        // Release for both outcomes. onPromptEnd cannot cover this branch: the
        // predecessor's park flag makes it early-return, and on a throw the
        // in-try release used to be skipped, leaving this turn's anchor (and
        // its msg_seq counter) behind an in-flight-send veto forever. The
        // `finally` runs after endMsgSeqSend, so the counter this send owns is
        // reclaimable. Identity-gated either way: `captured` for a live anchor,
        // the raw entry's msgId for one that expired — /clear deletes the
        // session queue, so a successor turn can install its own anchor while a
        // wedged send is still in flight, and an unguarded release would delete
        // it. With no anchor of this turn's at all there is nothing to release.
        if (captured) {
          this.releaseSessionReplyAnchor(sessionId, captured);
        } else if (capturedEntry) {
          this.releaseSessionReplyAnchor(sessionId, capturedEntry.msgId);
        }
      }
      return;
    }
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state && this.flushingSessions.has(sessionId)) {
      this.pendingStreamDelete.add(sessionId);
      process.stderr.write(
        `[QQ:${this.name}] onResponseComplete deferred (flush in-flight) session=${sanitizeLogText(sessionId, 32)}\n`,
      );
      return;
    }
    const wasFlushed = this.flushedSessions.has(sessionId);
    // A streamState entry's buffer is authoritative whenever the entry exists:
    // an empty one means the turn's text already went out as flushed segments.
    // fullText is only the fallback for a turn that never created an entry and
    // never flushed, so a buffered residual shadows the daemon task output the
    // bridge picks.
    let remaining = state?.buffer ?? (wasFlushed ? '' : fullText);
    // A live turn's stashed pre-boundary text must go out with the final text
    // only when a boundary cleared the bridge's collection since it was taken —
    // state.buffer and fullText both miss it then. Without a boundary, fullText
    // already carries the diverted chunks, and prepending would double the HEAD.
    // The entry is removed here, before the send, so a chunk arriving
    // during the send cannot drain the same stash into a fresh entry and
    // duplicate the HEAD. A superseded entry is dropped with a log.
    const held = this.streamOrphanBuffer.get(sessionId);
    if (held !== undefined) {
      if (held.turn === currentTurn) {
        this.reportOrphanStashCap(sessionId, held);
        this.streamOrphanBuffer.delete(sessionId);
        if (held.pre) {
          remaining = held.pre + remaining;
        }
      } else {
        this.dropOrphanStash(sessionId, held);
      }
    }
    const sourceLabel =
      segment?.sourceLabel ??
      state?.sourceLabel ??
      this.getResponseSourceLabel(sessionId);
    // TTL-check the anchor like onResponseChunk does: a final segment sent
    // after the anchor expired must go out as an active message instead of
    // with a stale msg_id.
    const { entry: anchorEntry, msgId: capturedMsgId } =
      this.resolveSessionReplyAnchor(sessionId);
    this.streamState.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    // This path just took over a parked deferred flush and delivered the
    // residual itself, so the park flag must go with the entry. Left behind,
    // onPromptEnd early-returns on it and the NEXT turn's first successful
    // flush consumes it mid-turn and runs the terminal settle, which clears
    // flushedSessions and makes onResponseComplete re-send that turn's text.
    this.pendingStreamDelete.delete(sessionId);
    if (remaining) {
      try {
        if (capturedMsgId) {
          // Final segment keeps this session's reply anchor (per-session msgId),
          // consistent with how idleFlush/flushAndTrack send mid-stream chunks,
          // and keeps the [sender · task] attribution: sendMessage hardcodes an
          // undefined sourceLabel, so the anchored send goes through the
          // reply-context helper instead (msgIdOverride still wins over the
          // reply context, so the anchor is unchanged).
          // Mark the send in flight for the release guard: the streamState
          // entry was deleted above, so nothing else can tell the guard that
          // this msgId's counter is still being used.
          this.beginMsgSeqSend(capturedMsgId);
          try {
            await this.sendFinalSegmentChecked(sessionId, held, () =>
              this.sendMessageWithReplyContext(
                chatId,
                remaining,
                undefined,
                sourceLabel,
                capturedMsgId,
                anchorEntry?.timestamp,
              ),
            );
          } finally {
            this.endMsgSeqSend(capturedMsgId);
          }
        } else {
          if (anchorEntry) {
            // The anchor existed but outlived its TTL — a long turn whose final
            // segment arrived late. Fall back to the session-aware base path
            // (active send) and say so: a silent fallback here is what made the
            // final segment race the chat-level entry in the first place.
            process.stderr.write(
              `[QQ:${this.name}] per-session reply anchor expired for final segment of ${sanitizeLogText(sessionId, 64)}\n`,
            );
          }
          await this.sendFinalSegmentChecked(sessionId, held, () =>
            this.sendMessageWithReplyContext(
              chatId,
              remaining,
              this.resolveResponseReplyContext(sessionId),
              sourceLabel,
            ),
          );
        }
      } catch (e: unknown) {
        this.logLostSealedHead(held?.pre, sessionId, e);
        throw e;
      }
    }
    // Release the anchor only AFTER the final segment went out. Releasing
    // first would drop the msgSeqMap counter for capturedMsgId (when no other
    // session is anchored to it and the chat entry has moved on), making the
    // final sendMessage above resolve nextSeq = 1 — QQ dedupes on msg_id +
    // msg_seq and would silently drop the reply tail. If sendMessage throws,
    // ChannelBase's finally still runs onPromptEnd, which releases the anchor
    // (idempotent — a second release here is a no-op).
    // Identity-gated: /clear deletes the session queue, so a successor turn can
    // install its own anchor while a wedged final send is still in flight;
    // releasing by sessionId alone would delete the successor's anchor. Pass
    // this turn's resolved msgId (the raw entry's for an expired anchor) so
    // only an anchor that still belongs to this turn is removed. With no anchor
    // of this turn's, there is nothing to release.
    const releaseMsgId = capturedMsgId ?? anchorEntry?.msgId;
    if (releaseMsgId !== undefined) {
      this.releaseSessionReplyAnchor(sessionId, releaseMsgId);
    }
  }

  /**
   * A stash's sealed head has no other copy — the bridge cleared it from its
   * collection at the boundary — so a delivery that fails after the entry was
   * consumed must report the loss (length and error) instead of dropping it
   * silently. Delete-before-send is deliberate: it stops a chunk arriving
   * mid-send from draining the same stash twice.
   */
  private logLostSealedHead(
    head: string | undefined,
    sessionId: string,
    error: unknown,
  ): void {
    if (!head) return;
    process.stderr.write(
      `[QQ:${this.name}] dropping ${head.length} chars of sealed head: delivery failed (${sanitizeLogText(error instanceof Error ? error.message : String(error), 160)}) for ${sanitizeLogText(sessionId, 64)}\n`,
    );
  }

  /**
   * Act on the route class a completion-path send reports. A blocked send never
   * reached the wire but throws nothing, so without this the final segment is
   * indistinguishable from a delivered one: the sealed head's loss log is
   * bypassed and the turn is reported delivered. A transient block (token
   * refresh failure) can clear on a later attempt, so it is re-attempted; a
   * permanent block, or exhaustion, reports the sealed head this path consumed
   * instead of dropping it silently. Exhaustion is bounded by maxFlushRetries
   * when that is positive, and by FINAL_SEGMENT_ROUTE_ATTEMPTS when
   * maxFlushRetries is the documented "unlimited" (<= 0): this send is awaited
   * inside the turn, so unlike the fire-and-forget flush paths it cannot be
   * allowed to retry forever — the turn's finally (and with it the session's
   * turn lock) would never run. The caller holds the msg_seq counter across the
   * whole call and releases the anchor only after it returns, so a re-attempt
   * cannot restart at seq 1 (QQ dedupes on msg_id + msg_seq).
   */
  private async sendFinalSegmentChecked(
    sessionId: string,
    held: QQOrphanStash | undefined,
    send: () => Promise<SendBlock | undefined>,
  ): Promise<void> {
    const bound =
      this.maxFlushRetries > 0
        ? this.maxFlushRetries
        : QQChannel.FINAL_SEGMENT_ROUTE_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      const blocked = await send();
      if (blocked === undefined) return;
      if (blocked === 'permanent' || attempt >= bound) {
        this.logLostSealedHead(
          held?.pre,
          sessionId,
          new Error(
            blocked === 'permanent'
              ? 'outgoing route permanently blocked'
              : 'outgoing route blocked, retries exhausted',
          ),
        );
        return;
      }
      const delay =
        attempt > 1 ? QQChannel.IDLE_FLUSH_BACKOFF_MS : QQChannel.IDLE_FLUSH_MS;
      process.stderr.write(
        `[QQ:${this.name}] final segment blocked by unresolved route (attempt ${attempt}), retrying in ${delay}ms for ${sanitizeLogText(sessionId, 64)}\n`,
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
    }
  }

  private streamBufferLimit(state: QQStreamState): number {
    const configured =
      this.qqConfig.bufferFlushLength ?? QQChannel.MAX_BUFFER_LENGTH;
    if (!state.sourceLabel) return configured;
    const attributed = this.formatMarkdownAttributedText(
      'x',
      state.sourceLabel,
    );
    return Math.max(1, configured - (attributed.length - 1));
  }

  /**
   * Build a fresh streamState entry for a session's first chunk, resolving
   * the session's reply anchor (TTL-checked) and the segment's reply context.
   * Shared by onResponseChunk's fresh-entry path and onPromptEnd's delivery
   * of a cancelled turn's stashed head.
   */
  private createStreamState(
    chatId: string,
    sessionId: string,
    chunk: string,
    currentTurn: number,
    segment?: ChannelOutputSegmentContext,
  ): QQStreamState {
    // Reuse the session's reply anchor across buffer windows (a single
    // response may flush several times, each creating a fresh state entry).
    // The anchor was set deterministically by onPromptStart from the
    // triggering message's id; drop it when stale (past the 5-minute TTL)
    // so a long stream's later windows fall back to the active send path
    // instead of sending chunks with an expired msg_id.
    let anchor: string | undefined;
    let anchorTimestamp: number | undefined;
    const { entry: anchorEntry, msgId: freshAnchor } =
      this.resolveSessionReplyAnchor(sessionId);
    if (anchorEntry) {
      if (freshAnchor !== undefined) {
        anchor = freshAnchor;
        // Carry the capture time so the flush/sealed-head read sites can
        // expire this anchor when the entry outlives the TTL.
        anchorTimestamp = anchorEntry.timestamp;
      } else {
        // Drop the stale anchor through the release path so its orphaned
        // msg_seq counter is purged too (a raw delete would leave it behind).
        process.stderr.write(
          `[QQ:${this.name}] per-session reply anchor expired for ${sanitizeLogText(sessionId, 64)}, falling back to active send\n`,
        );
        this.releaseSessionReplyAnchor(sessionId);
      }
    }
    const messageId =
      segment?.messageId ?? this.getResponseMessageId(sessionId);
    const replyContext = messageId
      ? this.replyContextByMessageId.get(messageId)
      : undefined;
    return {
      chatId,
      buffer: chunk,
      timer: null,
      retryCount: 0,
      msgId: anchor,
      ...(anchorTimestamp !== undefined
        ? { msgIdTimestamp: anchorTimestamp }
        : {}),
      turn: currentTurn,
      ...(replyContext ? { replyContext } : {}),
      ...(segment?.sourceLabel ? { sourceLabel: segment.sourceLabel } : {}),
    };
  }

  /**
   * Report the tail a capped divert episode accumulated after its first
   * overflow line. See the cap branch in onResponseChunk: the first drop is
   * logged immediately so the loss is visible, later chunks only count, and
   * this emits the cumulative total once per episode when the stash leaves
   * the side buffer. `capDropped` counts characters, not fields: the sealed
   * pre's own trim is a subset of the text trim and is not charged again.
   */
  private reportOrphanStashCap(sessionId: string, held: QQOrphanStash): void {
    const total = held.capDropped ?? 0;
    const logged = held.capLogged ?? 0;
    if (total <= logged) return;
    process.stderr.write(
      `[QQ:${this.name}] diverted turn ${held.turn} stash capped: ${total - logged} further chars dropped (${total} total) for ${sanitizeLogText(sessionId, 64)}\n`,
    );
  }

  /**
   * Drop a side-buffer entry that cannot be delivered (it belongs to a
   * superseded turn, or a fresh turn is starting and can never own it) and
   * log the discarded text so the loss is observable.
   */
  private dropOrphanStash(sessionId: string, held: QQOrphanStash): void {
    this.reportOrphanStashCap(sessionId, held);
    this.streamOrphanBuffer.delete(sessionId);
    if (held.text) {
      process.stderr.write(
        `[QQ:${this.name}] dropping ${held.text.length} chars of superseded turn ${held.turn} for ${sanitizeLogText(sessionId, 64)}\n`,
      );
    }
  }

  /**
   * The seal a failed payload needs when a boundary cleared the bridge's
   * collection while the send was in flight: the payload's whole text is now
   * absent from fullText, so it is sealed outright rather than only by the seal
   * the send carried, which may cover just a prefix. `residual` is the text the
   * boundary stripped from the live turn, captured by the boundary hooks ('' =
   * nothing), and is appended after the payload — no string comparison against
   * the carried seal, so a residual whose text repeats it still counts.
   */
  private sealClearedPayload(payload: string, residual: string): string {
    return residual ? payload + residual : payload;
  }

  /**
   * Re-seal a failed payload that a transient re-buffer puts back on `current`:
   * a boundary that cleared the bridge's collection while the send was in
   * flight removed the payload's whole text from fullText, so the entire
   * payload is sealed, plus the residual the boundary captured (flagged
   * deterministically, not by comparing seal text). Only a chain that still
   * owns the live turn may write the seal — a superseded entry's payload is
   * abandoned with its failure and must not be injected into a successor's
   * reply. `carriedSeal` is the backstop for a re-seal whose boundary marker
   * was missed. Shared by the parked and non-parked re-buffer arms; the two
   * must stay identical because they encode the same rule.
   */
  private resealOnRebuffer(
    sessionId: string,
    state: QQStreamState,
    current: QQStreamState,
    payload: string,
    carriedSeal: string | undefined,
  ): void {
    if (!this.ownsLiveTurn(sessionId, state)) return;
    if (state.boundaryClearedInFlight !== undefined) {
      current.sealedPre = this.sealClearedPayload(
        payload,
        this.capturedResidual(state),
      );
    } else if (carriedSeal !== undefined && current.sealedPre !== carriedSeal) {
      current.sealedPre = carriedSeal + (current.sealedPre ?? '');
    }
  }

  /**
   * Whether a settling flush chain still owns the session: its entry is the
   * live streamState entry, or the chain still holds the flush marker. The
   * marker is cleared only by `.finally()` after the settle arms, so this stays
   * true while those arms hand state off; a session torn down by onSessionDied
   * (or replaced outright) owns neither, and its chain must not write shared
   * per-session state.
   */
  private ownsSession(sessionId: string, state: QQStreamState): boolean {
    return (
      this.streamState.get(sessionId) === state ||
      this.flushingSessions.get(sessionId) === state
    );
  }

  /**
   * Whether this entry is still the turn that owns the session's counter. A
   * superseded entry's text is abandoned with its failure and must not be
   * sealed into a successor's reply.
   */
  private ownsLiveTurn(sessionId: string, state: QQStreamState): boolean {
    return state.turn === (this.turnCounter.get(sessionId) ?? 0);
  }

  /**
   * Hand a doomed entry's sealed pre-boundary head to whatever can still
   * deliver it, before the entry carrying the only copy is dropped. The
   * boundary cleared the bridge's chunk collection, so this text is absent
   * from fullText: dropping it truncates the reply's opening with no log.
   *
   * A later settle of this turn (onResponseComplete has not run yet), or a
   * successor turn that owns the counter now, can still prepend it — re-stash,
   * merging into an existing stash. A fresh entry is tagged with the turn that
   * owns the counter, never the doomed one: every consumer gates on the entry
   * turn matching the live turn, so a doomed tag is dropped as superseded by
   * the successor's first chunk and the head is lost anyway. The merge branch
   * keeps the existing entry's turn, which a stash always carries as the turn
   * that wrote it. `pre` carries the sealed head alone and is never widened to
   * the whole dropped buffer: the post-boundary text is still in fullText and
   * prepending it again would deliver it twice.
   *
   * Otherwise the turn is already over — completion returned and parked the
   * session, or the caller is the park-consuming exhaustion branch, which
   * clears the flag before reaching here — and this turn still owns the
   * counter, so the block that drops the entry also drops the counter and a
   * stash would be discarded as superseded. Deliver the sealed head on this
   * turn's own anchor instead — the same path onPromptEnd already uses for a
   * parked cancelled turn's HEAD. The same delivery is taken when the turn
   * being tagged has already run its completion (see completedTurns): its
   * completion is the reader that would prepend the stash, it will not run
   * again, and a stash it cannot consume is dropped by the next onPromptStart.
   *
   * `turnIsOver` defaults to the park flag, which is still armed at the four
   * sites that reach here while it is; the pending-exhaustion branch has
   * already consumed it, so it passes the fact explicitly.
   *
   * `carriedSeal` is the seal a permanently-failed send captured when it
   * started (flushAndTrack). A later boundary can re-seal the same state's
   * residual while that send is in flight, overwriting `sealedPre`; the failed
   * send carried the older head, which then has no other copy. Both are
   * recovered here — the older first, since the seal always covers a later
   * buffer window.
   */
  private handOffSealedPre(
    state: QQStreamState,
    sessionId: string,
    turnIsOver = this.pendingStreamDelete.has(sessionId),
    carriedSeal?: string,
  ): void {
    // A chain whose session was torn down (onSessionDied) or replaced outright
    // owns neither map: its seal has no consumer left, and re-writing the side
    // buffer here would later prepend a dead turn's head to an unrelated
    // successor reply. A superseded chain that still holds the flush
    // marker legitimately hands off, which is why both maps are consulted.
    if (!this.ownsSession(sessionId, state)) {
      // The seal is dropped here, so log it like every other loss: nothing else
      // observes this path.
      if (state.sealedPre !== undefined) {
        process.stderr.write(
          `[QQ:${this.name}] dropping ${state.sealedPre.length} chars of sealed head for unowned session ${sanitizeLogText(sessionId, 64)}\n`,
        );
      }
      return;
    }
    const liveSeal = state.sealedPre;
    const sealed =
      carriedSeal !== undefined && carriedSeal !== liveSeal
        ? carriedSeal + (liveSeal ?? '')
        : liveSeal;
    if (sealed === undefined) return;
    state.sealedPre = undefined;
    // The turn this text ends up tagged with: the one an existing stash already
    // carries when the two are merged, since the write below keeps that tag.
    const existing = this.streamOrphanBuffer.get(sessionId);
    const taggedTurn =
      existing?.turn ?? this.turnCounter.get(sessionId) ?? state.turn;
    // A successor that ended by cancel can never read a re-stash either:
    // onPromptStart marks the session active and onPromptEnd clears it, while
    // completedTurns is only written by onResponseComplete, so the cancel path
    // is invisible to the record. With no prompt active there is no completion
    // left that could consume the stash, and the next onPromptStart would drop
    // it as dead text — deliver on this turn's own anchor instead.
    const noSuccessorCanConsume =
      (turnIsOver && (this.turnCounter.get(sessionId) ?? 0) === state.turn) ||
      !this.activePromptSessions.has(sessionId);
    // That turn has already run its own onResponseComplete, so a re-stash is a
    // write with no guaranteed consumer: the next onPromptStart drops it as
    // superseded and the sealed opening is lost. Deliver it on this turn's
    // anchor instead.
    const completionAlreadyRan =
      this.completedTurns.get(sessionId) === taggedTurn;
    if (noSuccessorCanConsume || completionAlreadyRan) {
      // The sealed text belongs to this state's turn, so anchor it there: a
      // successor may already own the session anchor by the time this runs.
      // Its attribution label is passed for the same reason — the fallback
      // lookup resolves against a possibly-successor active prompt.
      void this.deliverCancelledStash(
        state.chatId,
        sessionId,
        sealed,
        state.msgId ?? null,
        state.msgIdTimestamp,
        state.sourceLabel,
      );
      return;
    }
    const limit = this.streamBufferLimit(state);
    // This is the second write site for the side buffer. The sealed head is the
    // reason this handoff exists, so it is kept whole and only the successor's
    // contribution is capped. The stash is therefore at most
    // max(streamBufferLimit(state), sealed.length); `sealed` is itself bounded —
    // a carried seal plus a boundary seal, each derived from a capped buffer —
    // so this write site cannot grow without bound.
    const room = Math.max(0, limit - sealed.length);
    let merged: QQOrphanStash = { turn: taggedTurn, text: sealed, pre: sealed };
    if (existing !== undefined) {
      const successorText = truncateUtf16Units(existing.text, room);
      const dropped = existing.text.length - successorText.length;
      merged = {
        turn: existing.turn,
        text: sealed + successorText,
        pre: sealed + truncateUtf16Units(existing.pre ?? '', room),
        // Carry the cap accounting across the merge. This site reports its own
        // drop below, so that count is marked logged as well: the later
        // summary must not repeat it. Left off entirely when the episode never
        // hit the cap, so the stash keeps its plain shape.
        ...(existing.capDropped !== undefined || dropped > 0
          ? {
              capDropped: (existing.capDropped ?? 0) + dropped,
              capLogged: (existing.capLogged ?? 0) + dropped,
            }
          : {}),
        ...(existing.sourceLabel !== undefined
          ? { sourceLabel: existing.sourceLabel }
          : {}),
      };
      // `pre` is a prefix of `text` and is what onResponseComplete prepends, so
      // it must never outrun the kept text; the trims above keep that true, and
      // this stays as the safety net.
      if (merged.pre !== undefined && merged.pre.length > merged.text.length) {
        merged.pre = merged.text;
      }
      if (dropped > 0) {
        process.stderr.write(
          `[QQ:${this.name}] dropping ${dropped} chars of successor stash over the buffer limit, sealed head kept, for ${sanitizeLogText(sessionId, 64)}\n`,
        );
      }
    }
    this.streamOrphanBuffer.set(sessionId, merged);
  }

  override onSessionDied(sessionId: string): void {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // Disarm the residual too, for the same reason as onResponseChunk's
    // superseded branch: the release below must not veto on state this block
    // destroys, or the dead session's counter orphans with nothing left to
    // reclaim it. flushingSessions stays set — a genuine in-flight send still
    // owns that marker.
    if (state) state.buffer = '';
    // Release before the deletes so the release guard still sees this
    // session's in-flight marker (flushingSessions) and can keep the msg_seq
    // counter while a live flush owns it — a delete-then-release order would
    // drop the counter under an in-flight send and its tail would re-resolve
    // msg_seq from 1 (QQ dedupes on msg_id + msg_seq).
    this.releaseSessionReplyAnchor(sessionId);
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    this.activePromptSessions.delete(sessionId);
    this.turnCounter.delete(sessionId);
    // The stash is head text the bridge already cleared at a boundary, so its
    // loss must be observable like every other drop rather than silent.
    const heldStash = this.streamOrphanBuffer.get(sessionId);
    if (heldStash) this.dropOrphanStash(sessionId, heldStash);
    this.completedTurns.delete(sessionId);
    super.onSessionDied(sessionId);
  }
  // ── State Persistence (cross-server context continuation) ──────

  private serializeQQState(): string {
    return JSON.stringify({
      chatTypeMap: Array.from(this.chatTypeMap.entries()),
      replyMsgId: Array.from(this.replyMsgId.entries()),
      msgSeqMap: Array.from(this.msgSeqMap.entries()),
      groupActiveMsgEnabled: Array.from(this.groupActiveMsgEnabled.entries()),
      botOpenIdByGroup: Array.from(this.botOpenIdByGroup.entries()),
    });
  }

  /** Debounced state persistence with atomic write. */
  private saveQQState(): void {
    // NOTE: guarded here; flushQQState() is intentionally NOT — disconnect()
    // sets disposed=true *before* calling it, so it must still write final state.
    if (this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.disposed) return;
      const tmpPath = this.qqStatePath + '.tmp';
      try {
        writeFileSync(tmpPath, this.serializeQQState(), { mode: 0o600 });
        renameSync(tmpPath, this.qqStatePath);
      } catch (e) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort cleanup */
        }
        process.stderr.write(
          `[QQ:${this.name}] saveQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n
`,
        );
      }
    }, 500);
    this.saveTimer.unref();
  }

  /**
   * Attach the permanent textChunk handler for cron/non-prompt messages
   * to the current bridge. No-op if already attached or if cron is disabled.
   */
  private attachCronHandler(): void {
    if (
      this.qqConfig['cron-msg-experimental'] &&
      this._cronTextHandler &&
      !this.cronTextHandlerAttached
    ) {
      this.bridge.on?.('textChunk', this._cronTextHandler);
      this.cronTextHandlerAttached = true;
    }
  }

  private _checkGroupAllPolicyRequireMention(): void {
    const policy = this.qqConfig.groupAllPolicy;
    if (policy !== 'keyword' && policy !== 'all') return;
    const groups = this.config.groups;
    const anyFalse =
      groups && Object.values(groups).some((g) => g.requireMention === false);
    if (!anyFalse) {
      process.stderr.write(
        `[QQ:${this.name}] WARNING: groupAllPolicy is '${policy}' but requireMention is true (default). Non-@-bot messages passing keyword/all policy will be silently dropped by GroupGate. Set 'groups': { '*': { 'requireMention': false } } in channel config.\n`,
      );
    }
  }

  /**
   * Detach the permanent textChunk handler from the current bridge.
   * No-op if not attached or if cron is disabled.
   */
  private detachCronHandler(): void {
    if (
      this.qqConfig['cron-msg-experimental'] &&
      this._cronTextHandler &&
      this.cronTextHandlerAttached
    ) {
      this.bridge.off?.('textChunk', this._cronTextHandler);
      this.cronTextHandlerAttached = false;
    }
  }

  /**
   * Attach the ungated `responseBoundary` observer to the current bridge.
   * No-op if already attached.
   */
  private attachBridgeBoundarySeal(): void {
    if (this.bridgeBoundarySealAttached) return;
    this.bridge.on?.('responseBoundary', this._bridgeBoundarySeal);
    this.bridgeBoundarySealAttached = true;
  }

  /** Detach the boundary observer. No-op if not attached. */
  private detachBridgeBoundarySeal(): void {
    if (!this.bridgeBoundarySealAttached) return;
    this.bridge.off?.('responseBoundary', this._bridgeBoundarySeal);
    this.bridgeBoundarySealAttached = false;
  }

  /**
   * Seal the pre-boundary portion of a stashed head. Called from both the
   * adapter hook and the bridge's own boundary event: ChannelBase suppresses
   * the hook while a cancel is pending, but the bridge clears its chunk
   * collection on every boundary it emits, so only the ungated observer can
   * guarantee `pre` is set before the turn completes.
   */
  private sealOrphanStash(sessionId: string): void {
    const stashed = this.streamOrphanBuffer.get(sessionId);
    if (stashed) stashed.pre = stashed.text;
  }

  /**
   * A boundary clears the bridge's chunk collection. Seal the live turn's
   * buffer-resident prefix for the completion path, and record on the
   * entry whose flush is in flight what its re-buffer must re-seal: the payload
   * the boundary stripped from fullText, always, plus that residual when the
   * flushed entry is the live turn's own. Called by the adapter hook and by the
   * ungated bridge observer — the observer is the only signal when ChannelBase
   * suppresses the hook (cancel pending) — and both run on a normal boundary,
   * where the assignments are idempotent. Keyed off the in-flight marker rather
   * than streamState, so a successor turn replacing the entry cannot hide the
   * chain whose payload is still in the air.
   */
  private captureBoundaryClear(sessionId: string): void {
    const state = this.streamState.get(sessionId);
    const currentTurn = this.turnCounter.get(sessionId) ?? 0;
    // Seal ONLY the live turn's buffer-resident prefix: a stale/parked
    // predecessor's buffer is delivered by its own chain on its own anchor, and
    // sealing it would let the permanent-failure arm re-stash that text into a
    // successor turn's reply.
    const liveResidual =
      state !== undefined && state.turn === currentTurn && state.buffer
        ? state.buffer
        : undefined;
    if (state !== undefined && liveResidual !== undefined) {
      state.sealedPre = liveResidual;
    }
    const flushing = this.flushingSessions.get(sessionId);
    if (!flushing) return;
    // A boundary always strips the in-flight payload from fullText. The
    // residual rides along only when it belongs to the flushed entry itself,
    // whose `sealedPre` was just set to it — never a successor's buffer, and
    // never the stale carried seal. A later boundary may upgrade 'payload' to
    // 'residual', never the reverse.
    if (flushing === state && liveResidual !== undefined) {
      flushing.boundaryClearedInFlight = 'residual';
    } else if (flushing.boundaryClearedInFlight === undefined) {
      flushing.boundaryClearedInFlight = 'payload';
    }
  }

  /**
   * The residual text a boundary captured for this entry, or '' when it
   * recorded none. The text lives in `sealedPre`, written by
   * captureBoundaryClear in the same call that sets the marker, so it is always
   * a real residual and never the seal the failed payload carried.
   */
  private capturedResidual(state: QQStreamState): string {
    return state.boundaryClearedInFlight === 'residual'
      ? (state.sealedPre ?? '')
      : '';
  }

  /** Flush pending state writes immediately (called on disconnect). */
  private flushQQState(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmpPath = this.qqStatePath + '.tmp';
    try {
      writeFileSync(tmpPath, this.serializeQQState(), { mode: 0o600 });
      renameSync(tmpPath, this.qqStatePath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      process.stderr.write(
        `[QQ:${this.name}] flushQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n
`,
      );
    }
  }

  /**
   * Restore QQ routing state from disk.
   *
   * Validates all restored state extensively — type checks, length bounds,
   * and sanity filters — so a corrupted file produces clean empty maps
   * rather than propagating invalid data.
   */
  private restoreQQState(): boolean {
    try {
      if (!existsSync(this.qqStatePath)) return false;
      const raw = JSON.parse(readFileSync(this.qqStatePath, 'utf-8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        process.stderr.write(
          `[QQ:${this.name}] Invalid QQ state file (not an object), ignoring\n`,
        );
        return false;
      }

      if (raw.chatTypeMap) {
        const arr = raw.chatTypeMap as Array<[string, unknown]>;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.chatTypeMap = new Map(
          Array.isArray(arr)
            ? arr.filter(
                ([k, v]) =>
                  typeof k === 'string' &&
                  k.length <= 256 &&
                  (v === 'c2c' || v === 'group'),
              )
            : [],
        ) as Map<string, 'c2c' | 'group'>;
        if (this.chatTypeMap.size < totalRaw) {
          process.stderr.write(
            `[QQ:${this.name}] restoreQQState: accepted ${this.chatTypeMap.size} chatTypeMap entries (rejected ${totalRaw - this.chatTypeMap.size})\n`,
          );
        }
      }
      if (raw.replyMsgId) {
        const arr = raw.replyMsgId as Array<[string, unknown]>;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.replyMsgId = new Map(
          Array.isArray(arr)
            ? arr
                .filter(([k]) => typeof k === 'string' && k.length <= 256)
                .filter(([, v]) => {
                  if (typeof v === 'string' && v.length <= 128) return true;
                  if (v === null || typeof v !== 'object') return false;
                  const o = v as Record<string, unknown>;
                  return (
                    typeof o['msgId'] === 'string' &&
                    (o['msgId'] as string).length <= 128 &&
                    typeof o['timestamp'] === 'number' &&
                    Number.isFinite(o['timestamp']) &&
                    o['timestamp'] >=
                      Date.now() - QQChannel.REPLY_MSG_ID_TTL_MS &&
                    o['timestamp'] <= Date.now() + QQChannel.REPLY_MSG_ID_TTL_MS
                  );
                })
                .map(([k, v]) => [
                  k,
                  typeof v === 'string'
                    ? { msgId: v, timestamp: Date.now() }
                    : (v as { msgId: string; timestamp: number }),
                ])
            : [],
        );
        if (this.replyMsgId.size < totalRaw) {
          process.stderr.write(
            `[QQ:${this.name}] restoreQQState: accepted ${this.replyMsgId.size} replyMsgId entries (rejected ${totalRaw - this.replyMsgId.size})\n`,
          );
        }
      }
      this.replyContextByMessageId = new Map(
        Array.from(this.replyMsgId, ([chatId, entry]) => [
          entry.msgId,
          { chatId, ...entry },
        ]),
      );
      if (raw.msgSeqMap) {
        const arr = raw.msgSeqMap as Array<[string, unknown]>;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.msgSeqMap = new Map(
          Array.isArray(arr)
            ? arr.filter(
                ([k, v]) =>
                  typeof k === 'string' &&
                  k.length <= 256 &&
                  typeof v === 'number' &&
                  Number.isSafeInteger(v) &&
                  v >= 0,
              )
            : [],
        ) as Map<string, number>;
        if (this.msgSeqMap.size < totalRaw) {
          process.stderr.write(
            `[QQ:${this.name}] restoreQQState: accepted ${this.msgSeqMap.size} msgSeqMap entries (rejected ${totalRaw - this.msgSeqMap.size})\n`,
          );
        }
      }
      for (const msgId of this.msgSeqMap.keys()) {
        if (!this.replyContextByMessageId.has(msgId)) {
          this.msgSeqMap.delete(msgId);
        }
      }
      if (raw.groupActiveMsgEnabled) {
        const arr = raw.groupActiveMsgEnabled as Array<[string, unknown]>;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.groupActiveMsgEnabled = new Map(
          Array.isArray(arr)
            ? arr.filter(
                ([k, v]) =>
                  typeof k === 'string' &&
                  k.length <= 256 &&
                  typeof v === 'boolean',
              )
            : [],
        ) as Map<string, boolean>;
        if (this.groupActiveMsgEnabled.size < totalRaw) {
          process.stderr.write(
            `[QQ:${this.name}] restoreQQState: accepted ${this.groupActiveMsgEnabled.size} groupActiveMsgEnabled entries (rejected ${totalRaw - this.groupActiveMsgEnabled.size})\n`,
          );
        }
      }
      if (raw.botOpenIdByGroup) {
        const arr = raw.botOpenIdByGroup as Array<[string, unknown]>;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.botOpenIdByGroup = new Map(
          Array.isArray(arr)
            ? arr.filter(
                ([k, v]) =>
                  typeof k === 'string' &&
                  k.length <= 256 &&
                  typeof v === 'string' &&
                  QQ_OPENID_RE.test(v),
              )
            : [],
        ) as Map<string, string>;
        if (this.botOpenIdByGroup.size < totalRaw) {
          process.stderr.write(
            `[QQ:${this.name}] restoreQQState: accepted ${this.botOpenIdByGroup.size} botOpenIdByGroup entries (rejected ${totalRaw - this.botOpenIdByGroup.size})\n`,
          );
        }
      }
      return true;
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] Failed to restore QQ state: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      );
      return false;
    }
  }

  /**
   * Backup the global sessions.json before start.ts deletes it on shutdown.
   * Restored on next connect so conversations survive daemon restarts.
   */
  private backupGlobalSessions(): void {
    try {
      if (existsSync(this.globalSessionsPath)) {
        const data = readFileSync(this.globalSessionsPath, 'utf-8');
        if (data.trim())
          writeFileSync(this.sessionsBackupPath, data, { mode: 0o600 });
      }
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] backupGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n
`,
      );
    }
  }

  private restoreGlobalSessions(): void {
    try {
      if (
        !existsSync(this.globalSessionsPath) &&
        existsSync(this.sessionsBackupPath)
      ) {
        writeFileSync(
          this.globalSessionsPath,
          readFileSync(this.sessionsBackupPath, 'utf-8'),
          { mode: 0o600 },
        );
      }
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] restoreGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n
`,
      );
    }
  }

  /**
   * Compatibility repair for legacy restored session state where older router
   * code could keep an empty session id after bridge.loadSession() failed to
   * return a session_id.
   *
   * **Fragile**: accesses SessionRouter's private `toSession`/`toTarget`/`toCwd`
   * maps via type coercion. If SessionRouter internals change, this breaks
   * silently. The only signal will be cross-server conversations failing to
   * restore after daemon restart — no crash, no log.
   *
   * Keep this while old persisted files may still exist.
   */
  private fixRestoredSessions(): void {
    try {
      if (!existsSync(this.globalSessionsPath)) return;
      const raw = JSON.parse(readFileSync(this.globalSessionsPath, 'utf-8'));
      const r = this.router as unknown as Record<string, unknown>;
      const tm = r['toSession'] as Map<string, string> | undefined;
      const tt = r['toTarget'] as Map<string, unknown> | undefined;
      const tc = r['toCwd'] as Map<string, string> | undefined;
      if (!tm || !tt) return;

      for (const [key, sid] of tm) {
        if (sid) continue;
        const entry = raw[key] as
          | { sessionId?: string; target?: unknown; cwd?: string }
          | undefined;
        if (!entry?.sessionId) continue;
        const correctId: string = entry.sessionId;
        const target = entry.target;
        tm.set(key, correctId);
        tt.delete(undefined as unknown as string);
        tt.set(correctId, target);
        if (tc) {
          tc.delete(undefined as unknown as string);
          tc.set(correctId, entry.cwd || '');
        }
      }
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] fixRestoredSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n
`,
      );
    }
  }

  /**
   * Purge orphaned session mappings left over from older scope eras:
   * `<channel>:__single__` keys (single-scope era, see PR #6457) and this
   * channel's own three-part user-scope keys.
   *
   * `<channel>:__single__` is the live routing key under an explicit 'single'
   * sessionScope, so it is an orphan only under any other scope. There it can
   * never be routed to again and is dead weight in the router maps and the
   * persisted sessions file — and worse, restore re-attaches it via
   * bridge.loadSession on every restart, silently resetting continuity.
   *
   * User-scope keys (`<channel>:<sender>:<chat>`) are unroutable under every
   * scope other than 'user' (including 'single'): SessionRouter's
   * thread/chat_thread routing key is `<channel>:<chatId>` and its 'single'
   * key is `<channel>:__single__`, while resolve() is a bare map lookup with
   * no shape fallback. This channel's own user-scope entries are therefore
   * purged under every recognized non-'user' scope; an unrecognized scope
   * fails closed (see knownScope below). A sibling channel's are left alone,
   * decided by target ownership, never by key prefix. The purge runs after
   * restore, so on the first boot those keys are still re-attached once by
   * bridge.loadSession and then released here; afterwards they are gone from
   * the persisted file.
   *
   * The destructive half is opt-in via `purgeLegacySessions` (default false):
   * the default scope changing is not the operator asking to delete persisted
   * conversations. With it off, the doomed routes are only counted and
   * reported, and nothing is released. With it on, before the first deletion
   * the doomed routes are appended to `<name>-sessions-purged.json` in the
   * channel state directory so an operator can restore a legacy conversation
   * by hand; if that write fails, nothing is deleted. Each record carries the
   * route's `cwd` when the router's persisted route store still has it, so a
   * restored route resolves to the same workspace. The file accumulates purge
   * records and is never read back automatically.
   *
   * Runs AFTER restoreSessions(): SessionRouter exposes no public API to drop
   * persisted entries before restore (readPersistedEntries/deleteByKey are
   * private), and rewriting the persist file from here would be fragile and
   * race-prone. The orphan is therefore re-attached by bridge.loadSession
   * during restore and then released here — both the router mapping and the
   * daemon-side session (see bridge.discardSession below) are torn down.
   */
  private purgeSingleScopeOrphans(): void {
    const scope: string = this.config.sessionScope;
    // Fail closed on an unrecognized scope. SessionRouter.routingKey() switches
    // on scope with `case 'user': default:`, so any value outside the
    // SessionScope union still builds LIVE `<channel>:<sender>:<chat>` keys.
    // Testing orphanhood with `scope !== 'user'` therefore treats an operator
    // typo (or a value written by a different version) as "every live route is
    // an orphan" and discards all of the channel's persisted sessions on each
    // cold start. Only a scope this code can reason about may authorise a
    // destructive purge.
    const knownScope =
      scope === 'user' ||
      scope === 'thread' ||
      scope === 'chat_thread' ||
      scope === 'single';
    const singleScope = scope === 'single';
    if (!knownScope) {
      // Fail closed, but not silently: the operator asked for a cleanup (or at
      // least has a scope this build cannot reason about) and must know that
      // nothing was counted or purged.
      process.stderr.write(
        `[QQ:${this.name}] purgeSingleScopeOrphans skipped: unrecognized sessionScope '${sanitizeLogText(scope, 32)}' — refusing to guess which keys a scope would build, so nothing was purged\n`,
      );
      return;
    }
    try {
      // Optional-call like the READY path: an externally supplied router may
      // not expose getAll; fall back to an empty list rather than crash.
      const all =
        (
          this.router as unknown as {
            getAll?: () => RouterRoute[];
          }
        ).getAll?.() ?? [];
      // Phase 1: collect what would be deleted, with the predicate that doomed
      // it. Nothing is torn down yet — the rescue copy below must reach disk
      // before the first removeSessionId(), because that call persists.
      // getAll() reports no cwd, so the only source for a doomed route's cwd is
      // the store the router persists to, which records entry.cwd verbatim
      // (SessionRouter.persist). In daemon mode that is the shared router's own
      // routes.json, not this channel's sessions.json, so resolve the path off
      // the router and fall back to globalSessionsPath only for a supplied
      // router that exposes no persistPath (external/duck-typed). The fallback
      // cannot serve standalone mode: there the internally built router's own
      // persistPath is the per-channel file and wins, so the fallback reads the
      // shared sessions.json. Read it once, best-effort: a missing, empty, or
      // unparsable file — or a key absent from it — must leave cwd off the
      // record rather than fall back to the router default, which would point a
      // hand-restored route at the wrong workspace.
      const routerPersistPath = (
        this.router as unknown as Record<string, unknown>
      )['persistPath'];
      const cwdStorePath =
        typeof routerPersistPath === 'string' && routerPersistPath.length > 0
          ? routerPersistPath
          : this.globalSessionsPath;
      // A message route persists its key as a fixed wrapper around its
      // chat-level key (SessionRouter.routingKey), so an entry's base key has
      // to be unwrapped before the orphan predicates can match it. The unwrap
      // lives next to the wrap in channels/base, so the two cannot drift apart
      // and leave this purge matching a shape the router no longer writes.
      type PersistedRouteMeta = {
        cwd?: string;
        isolation?: 'worktree';
        workspaceCwd?: string;
        turns?: number;
        startedAt?: number;
      };
      const persistedCwdByKey = new Map<string, PersistedRouteMeta>();
      try {
        if (existsSync(cwdStorePath)) {
          const raw: unknown = JSON.parse(readFileSync(cwdStorePath, 'utf-8'));
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(
              raw as Record<string, unknown>,
            )) {
              const entry = value as Record<string, unknown> | null;
              const meta: PersistedRouteMeta = {};
              if (
                typeof entry?.['cwd'] === 'string' &&
                entry['cwd'].length > 0
              ) {
                meta.cwd = entry['cwd'];
              }
              if (entry?.['isolation'] === 'worktree') {
                meta.isolation = 'worktree';
              }
              if (
                typeof entry?.['workspaceCwd'] === 'string' &&
                entry['workspaceCwd'].length > 0
              ) {
                meta.workspaceCwd = entry['workspaceCwd'];
              }
              if (typeof entry?.['turns'] === 'number') {
                meta.turns = entry['turns'];
              }
              if (typeof entry?.['startedAt'] === 'number') {
                meta.startedAt = entry['startedAt'];
              }
              if (Object.keys(meta).length > 0) {
                persistedCwdByKey.set(key, meta);
              }
            }
          }
        }
      } catch (e) {
        // Best-effort: a rescue record without cwd is still restorable by hand.
        process.stderr.write(
          `[QQ:${this.name}] purgeSingleScopeOrphans route metadata read failed, rescue copies omit cwd/isolation: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
      }
      const doomed: Array<
        RouterRoute & { kind: 'single' | 'user' } & PersistedRouteMeta
      > = [];
      for (const entry of all) {
        // Match only this channel's own keys, on the entry's base key (a
        // message route wraps it, see unwrapMessageRoutingKey):
        // in daemon mode the router is shared across
        // channels, so a suffix match on ':__single__' would also hit sibling
        // channels' live single-scope routing state and silently reset their
        // sessions. Orphan keys from the single-scope era are
        // `<thisChannel>:__single__`, so the base-key match still cleans up
        // this channel's orphans without touching sibling routes — but only
        // when the current scope is not 'single', where this key is the live
        // one. Gated on knownScope too, and there the purge is suppressed
        // deliberately (with a log): an unrecognized scope cannot tell us which
        // keys a scope would build, so even a currently unreachable
        // `__single__` route is left for the operator rather than guessed at.
        // Key equality alone is not ownership: channel names are unrestricted
        // user config and may contain colons, so a sibling named `<ourName>:x`
        // can route `chatId: 'x', threadId: '__single__'` (or `senderId: 'x',
        // chatId: '__single__'` under 'user') to the same base string. Apply
        // the target check here too; a target-less entry still has to be
        // purgeable, which is why the check permits `undefined`.
        // Legacy user-scope routes of THIS channel are unroutable under every
        // non-'user' scope (including 'single', whose key is
        // `<channel>:__single__`), so a persisted user-era key there can never
        // resolve again. Ownership comes from the entry's target, not from a
        // key prefix, so a sibling channel whose name prefixes ours is never
        // touched. The base key is compared against the exact string the
        // router builds for 'user' scope rather than being split on ':' — the
        // channel name is unrestricted user config and may itself contain
        // colons, so the part count does not identify the scope.
        const baseKey = unwrapMessageRoutingKey(entry.key);
        const ownsEntry =
          entry.target === undefined || entry.target.channelName === this.name;
        const isSingleOrphan =
          knownScope &&
          !singleScope &&
          baseKey === singleScopeRoutingKey(this.name) &&
          ownsEntry;
        const isOwnLegacyUserKey =
          knownScope &&
          scope !== 'user' &&
          entry.target?.channelName === this.name &&
          baseKey ===
            `${entry.target.channelName}:${entry.target.senderId}:${entry.target.chatId}`;
        if (isSingleOrphan || isOwnLegacyUserKey) {
          doomed.push({
            kind: isSingleOrphan ? 'single' : 'user',
            key: entry.key,
            sessionId: entry.sessionId,
            target: entry.target,
            ...(persistedCwdByKey.get(entry.key) ?? {}),
          });
        }
      }
      if (doomed.length > 0 && this.qqConfig.purgeLegacySessions !== true) {
        // A default changing is not an operator request to delete persisted
        // conversations, so the destructive half is opt-in.
        process.stderr.write(
          `[QQ:${this.name}] Left ${doomed.length} orphaned session route(s) in place (nothing removed); set "purgeLegacySessions": true to delete them\n`,
        );
        return;
      }
      if (doomed.length > 0) {
        // Append to any earlier record instead of truncating it: it is the
        // only copy of routes a previous purge already deleted. A file that
        // cannot be read, or does not hold a records list, is quarantined
        // rather than replaced, so a torn-but-hand-recoverable copy survives
        // the new record.
        let earlier: unknown[] = [];
        let unreadable: string | undefined;
        try {
          if (existsSync(this.sessionsPurgedPath)) {
            const raw: unknown = JSON.parse(
              readFileSync(this.sessionsPurgedPath, 'utf-8'),
            );
            if (Array.isArray(raw)) {
              earlier = raw;
            } else if (
              raw !== null &&
              typeof raw === 'object' &&
              Array.isArray((raw as { routes?: unknown }).routes)
            ) {
              // An earlier build of this branch wrote a single record as a bare
              // object. It is the only copy of routes that purge already
              // deleted, so keep it as one prior record rather than discard it.
              earlier = [raw];
            } else {
              unreadable = 'is not a purge-record list';
            }
          }
        } catch (e) {
          unreadable = `unreadable: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}`;
        }
        if (unreadable !== undefined) {
          // Quarantine on the same pattern SessionRouter uses for its persist
          // file: keep the damaged copy instead of letting the write below
          // destroy whatever an operator could still salvage by hand.
          const quarantinePath = `${this.sessionsPurgedPath}.corrupt-${Date.now()}`;
          try {
            renameSync(this.sessionsPurgedPath, quarantinePath);
            process.stderr.write(
              `[QQ:${this.name}] purgeSingleScopeOrphans rescue file ${unreadable}, quarantined to ${quarantinePath}\n`,
            );
          } catch (e) {
            process.stderr.write(
              `[QQ:${this.name}] purgeSingleScopeOrphans rescue file ${unreadable}, quarantine failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
            );
          }
        }
        // Self-describing so an operator can restore a route by hand; there is
        // no automatic restore, and no other path writes this file.
        const tmpPath = `${this.sessionsPurgedPath}.tmp`;
        try {
          // Write a sibling temp file then rename it over the rescue file: an
          // in-place truncating write that fails (ENOSPC/EIO, a kill mid-write)
          // would erase the earlier records just read, and `{ mode: 0o600 }`
          // does not tighten an existing 0o644 file the way a fresh rename does.
          writeFileSync(
            tmpPath,
            JSON.stringify(
              [
                ...earlier,
                {
                  purgedAt: new Date().toISOString(),
                  sessionScope: scope,
                  routes: doomed,
                },
              ].slice(-QQChannel.MAX_PURGE_RECORDS),
              null,
              2,
            ),
            { mode: 0o600 },
          );
          renameSync(tmpPath, this.sessionsPurgedPath);
          process.stderr.write(
            `[QQ:${this.name}] Saved ${doomed.length} session route(s) about to be purged to ${this.sessionsPurgedPath}\n`,
          );
        } catch (e) {
          // A failed write can leave a partial sibling behind; drop it
          // best-effort so a failed purge leaves no garbage, never masking the
          // original error.
          try {
            unlinkSync(tmpPath);
          } catch {
            /* best-effort cleanup */
          }
          // Fail closed: without the rescue copy the deletions are not
          // recoverable by hand, so nothing is removed.
          process.stderr.write(
            `[QQ:${this.name}] purgeSingleScopeOrphans rescue write failed, leaving ${doomed.length} session route(s) in place: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
          );
          return;
        }
      }
      // Phase 2: perform the deletions exactly as before, one entry at a time.
      let singlePurged = 0;
      let userPurged = 0;
      for (const entry of doomed) {
        // Release the daemon-side session too: restoreSessions() already
        // re-attached it via bridge.loadSession, so without this the orphan
        // stays alive in the daemon until the process ends. removeSessionId
        // below only clears the router maps. Best-effort — a bridge without
        // discardSession (or a failed discard) must not break the purge.
        // No binding token: the orphan is no longer routed to, and purge
        // runs before any new route can reference it.
        try {
          void this.bridge
            .discardSession?.(entry.sessionId)
            .catch(() => undefined);
        } catch {
          // Best-effort cleanup must not abort the purge.
        }
        if (this.router.removeSessionId(entry.sessionId)) {
          if (entry.kind === 'single') singlePurged++;
          else userPurged++;
        }
      }
      // Report the two kinds separately: the user-scope branch deletes persisted
      // conversations that a reader may still want to recover, so it must not be
      // reported as single-scope housekeeping.
      if (singlePurged > 0) {
        process.stderr.write(
          `[QQ:${this.name}] Purged ${singlePurged} orphaned single-scope session mapping(s)\n`,
        );
      }
      if (userPurged > 0) {
        process.stderr.write(
          `[QQ:${this.name}] Purged ${userPurged} orphaned user-scope session mapping(s)\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] purgeSingleScopeOrphans failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      );
    }
  }

  // ── ReplyMsgId helpers ────────────────────────────────────────

  /**
   * Resolve a session's reply anchor, returning both the raw entry and the
   * msgId only while the entry is still inside REPLY_MSG_ID_TTL_MS. Callers
   * that just need a usable anchor take `.msgId`; callers that must tell an
   * absent anchor from an expired one (the final-segment fallback logs the
   * expired case) branch on `.entry`. One site, so the freshness rule cannot
   * drift between the flush, cancelled-stash, completion and create paths.
   */
  private resolveSessionReplyAnchor(sessionId: string): {
    entry: { msgId: string; timestamp: number } | undefined;
    msgId: string | undefined;
  } {
    const entry = this.sessionReplyMsgId.get(sessionId);
    const fresh =
      entry !== undefined &&
      Date.now() - entry.timestamp < QQChannel.REPLY_MSG_ID_TTL_MS;
    return { entry, msgId: fresh ? entry.msgId : undefined };
  }

  /**
   * Release a session's reply anchor, cascading to msgSeqMap when the
   * anchored msgId is no longer referenced by any live session or by the
   * chat's current replyMsgId entry. Idempotent — safe to call on sessions
   * that never held an anchor. This is the single release path for
   * sessionReplyMsgId so every release point (flush completion, permanent
   * delivery failure, retry exhaustion, onResponseComplete, onSessionDied,
   * onPromptEnd, group removal) also cleans up msg_seq counters whose msgId
   * can never be used again — otherwise they accumulate forever in memory
   * and in the persisted QQ state.
   *
   * When expectedMsgId is given, the map entry is only removed if it still
   * points at that msgId. A deferred send chain may settle after the next
   * prompt on the same session has already overwritten the anchor with a new
   * msgId; releasing by sessionId alone would delete the *successor's* anchor
   * (the exact defect this parameter guards). The msgSeqMap cascade still
   * runs for expectedMsgId so the superseded turn's counter cannot orphan.
   */
  private releaseSessionReplyAnchor(
    sessionId: string,
    expectedMsgId?: string,
  ): void {
    const current = this.sessionReplyMsgId.get(sessionId);
    if (expectedMsgId === undefined) {
      // Caller has no identity expectation — preserve legacy behavior and
      // drop whatever anchor the session currently holds.
      this.sessionReplyMsgId.delete(sessionId);
    } else if (current !== undefined && current.msgId === expectedMsgId) {
      // Still this turn's anchor — safe to remove.
      this.sessionReplyMsgId.delete(sessionId);
    }
    // Otherwise (expectedMsgId given but the current entry is missing or has
    // been overwritten by a successor turn) leave the map entry untouched —
    // it no longer belongs to this turn. The cascade below still runs for
    // expectedMsgId so this turn's msg_seq counter cannot orphan.
    const target = expectedMsgId ?? current?.msgId;
    if (target === undefined) return;
    // Derived reclamation: the predicate now covers every holder —
    // another session's anchor, the chat-level anchor that used to be scanned
    // inline here, a live stream entry, an in-flight send — so this one call
    // replaces the veto + scan + delete. Releasing while a holder remains
    // would drop the counter and the tail's sendMessage would resolve
    // nextSeq = 1 after the first flush's (msg-A,1); QQ dedupes on msg_id +
    // msg_seq and silently drops the tail.
    this.reclaimMsgSeq(target);
  }

  /**
   * Whether a msgId's msg_seq counter is still needed: another session is
   * anchored to it, the chat-level replyMsgId entry still points at it, a
   * streamState entry holds it with a pending residual or an in-flight flush,
   * an anchored send under it is in flight (including the entry-less sends
   * flushingSessions cannot see), or the replyContextByMessageId routing map
   * still names it. The single predicate for every msgSeqMap reclamation site,
   * so the release veto and the TTL/teardown reclaimers cannot disagree and
   * drop a counter under a live send. It errs toward retaining: a counter that
   * survives too long only makes a later send under the same msgId start at a
   * higher msg_seq, which QQ accepts, while reclaiming it early loses the tail
   * (QQ dedupes on msg_id + msg_seq).
   */
  private isMsgSeqStillInUse(msgId: string): boolean {
    if (this.isMsgIdAnchoredBySession(msgId)) return true;
    // Chat-level anchor: this scan used to live inline in
    // releaseSessionReplyAnchor only, so the TTL/teardown reclaimers could
    // drop a counter the chat entry still named. Folding it in gives every
    // site the same holder set.
    for (const [, entry] of this.replyMsgId) {
      if (entry.msgId === msgId) return true;
    }
    for (const [sid, s] of this.streamState) {
      if (
        s.msgId === msgId &&
        (s.buffer || s.timer || this.flushingSessions.has(sid))
      )
        return true;
    }
    if ((this.inFlightMsgSeqSends.get(msgId) ?? 0) > 0) return true;
    // Routing map: replyContextByMessageId is the structure a send
    // actually resolves its outgoing msg_id from (sendResponseMessage,
    // sendMessageWithReplyContext, handleInbound), so a counter it still names
    // is still reachable by a send even when no anchor/stream/in-flight holder
    // remains. Plain presence, not a TTL check: this predicate must err toward
    // retaining, and it cannot leak — the sweep's first loop already evicts
    // expired entries through deleteReplyContext before the orphan pass runs.
    return this.replyContextByMessageId.has(msgId);
  }

  /**
   * Drop a msgId's msg_seq counter once no holder remains. Derived,
   * not decided per call site: a release site that vetoes reclamation while a
   * holder still exists never gets a second chance once that holder later
   * disappears, so every site routes through isMsgSeqStillInUse and the sweep
   * re-checks the counter map itself. Returns whether the counter was dropped;
   * the drop is persisted so a cold restart cannot resurrect it.
   */
  private reclaimMsgSeq(msgId: string): boolean {
    if (this.isMsgSeqStillInUse(msgId)) return false;
    if (!this.msgSeqMap.delete(msgId)) return false;
    this.saveQQState();
    return true;
  }

  /**
   * Safety net that reclaims a msg_seq counter once its last holder is gone:
   * the iteration domain is the counter map itself, so a
   * counter whose only *naming* entry (session anchor, chat anchor,
   * replyContextByMessageId routing entry, stream entry) was already deleted
   * is still visited. It cannot make orphaning impossible — a counter can
   * outlive its last holder between two 60s ticks — but it guarantees the
   * counter is dropped on the next tick instead of leaking forever. Deleting
   * from a Map while iterating its keys is safe. Returns whether anything was
   * reclaimed.
   */
  private reclaimOrphanMsgSeqCounters(): boolean {
    let reclaimed = false;
    for (const msgId of this.msgSeqMap.keys()) {
      if (this.reclaimMsgSeq(msgId)) reclaimed = true;
    }
    return reclaimed;
  }

  /** Mark an anchored send under msgId in flight for the release guard. */
  private beginMsgSeqSend(msgId: string): void {
    this.inFlightMsgSeqSends.set(
      msgId,
      (this.inFlightMsgSeqSends.get(msgId) ?? 0) + 1,
    );
  }

  /** Clear the matching beginMsgSeqSend once the send has settled. */
  private endMsgSeqSend(msgId: string): void {
    const remaining = (this.inFlightMsgSeqSends.get(msgId) ?? 1) - 1;
    if (remaining > 0) this.inFlightMsgSeqSends.set(msgId, remaining);
    else this.inFlightMsgSeqSends.delete(msgId);
  }

  /** Whether any live session is still anchored to this msgId. */
  private isMsgIdAnchoredBySession(msgId: string): boolean {
    // for...of instead of [...values()].some(...) — this is called inside
    // cleanupExpiredReplyMsgIds' interval loop, so avoid allocating an array
    // on every call.
    for (const a of this.sessionReplyMsgId.values()) {
      if (a.msgId === msgId) return true;
    }
    return false;
  }

  /**
   * Set replyMsgId for a chat, replacing any previous entry. The previous
   * msgId's msg_seq counter is deliberately NOT dropped here (see the NOTE
   * below): it is left to the TTL sweep, which reclaims it only once no
   * holder remains.
   */
  private setReplyMsgId(chatId: string, msgId: string): void {
    const timestamp = Date.now();
    // NOTE: main's #10145 (session-aware delivery) deliberately does NOT drop
    // the previous msgId's msg_seq counter here; counters are reclaimed by TTL
    // through deleteReplyContext / startReplyMsgIdCleanup. PR #8241's eager,
    // session-guarded delete is therefore not applied: main's TTL path (now
    // itself guarded by isMsgIdAnchoredBySession) supersedes it.
    this.replyMsgId.set(chatId, { msgId, timestamp });
    this.replyContextByMessageId.set(msgId, { chatId, msgId, timestamp });
    this.saveQQState();
  }

  private deleteReplyContext(context: QQReplyContext): void {
    this.replyContextByMessageId.delete(context.msgId);
    // Drop the chat-level naming entry BEFORE the reclaim: while it is still
    // present it is itself a holder, so reclaiming first would always veto and
    // the counter would linger until the next 60s tick.
    if (this.replyMsgId.get(context.chatId)?.msgId === context.msgId) {
      this.replyMsgId.delete(context.chatId);
    }
    // A streaming reply anchored to this msgId may still be in flight
    // (per-session msgId, PR #8241): reclaimMsgSeq keeps its msg_seq counter
    // alive while any remaining holder still needs it — a session anchor, the
    // chat-level anchor, a buffered or in-flight stream entry, an anchored send
    // in flight, or the replyContextByMessageId routing entry (the full set
    // lives in isMsgSeqStillInUse).
    this.reclaimMsgSeq(context.msgId);
  }

  /**
   * Start periodic cleanup of expired replyMsgId entries.
   * Evicts entries older than 5 minutes every 60 seconds, and cascades
   * to msgSeqMap.
   */
  private startReplyMsgIdCleanup(): void {
    this.stopReplyMsgIdCleanup();
    this.replyMsgIdCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - QQChannel.REPLY_MSG_ID_TTL_MS;
      let dirty = false;
      // Whether any of the tick's steps reclaimed a counter, so the explicit
      // save below only runs for a tick that evicted entries without dropping
      // one (reclaimMsgSeq persists internally).
      let reclaimed = false;
      for (const context of this.replyContextByMessageId.values()) {
        if (context.timestamp < cutoff) {
          this.deleteReplyContext(context);
          dirty = true;
        }
      }
      for (const [chatId, entry] of this.replyMsgId) {
        if (entry.timestamp < cutoff) {
          // Drop the naming entry BEFORE the reclaim, like deleteReplyContext:
          // while it is still present it is itself a holder, so reclaiming
          // first would always veto. A still-live holder (session anchor,
          // stream entry, in-flight send, routing map) vetoes as before.
          // Pre-reorder, that first call was a self-vetoed no-op and this
          // tick's orphan pass below reclaimed the counter anyway, so the
          // ordering has no observable difference (accepted zero coverage).
          this.replyMsgId.delete(chatId);
          if (this.reclaimMsgSeq(entry.msgId)) reclaimed = true;
          dirty = true;
        }
      }
      // TTL safety net for orphaned per-session anchors: every release path
      // cleans its own entry, but any missed release would otherwise leak
      // the anchor (and its msgSeqMap counter) forever. The release helper
      // guards on the streamState entry, so an expired anchor still held by
      // a live stream is left alone — and a long stream's anchor, once
      // expired, was already dropped by onResponseChunk's TTL check, so
      // nothing here can double-release.
      // No dirty flag here: releaseSessionReplyAnchor already persists
      // internally when it actually drops the msgSeqMap counter — marking
      // dirty unconditionally would force a full serialization every 60s
      // tick while an expired anchor is present.
      for (const [sessionId, entry] of this.sessionReplyMsgId) {
        if (entry.timestamp < cutoff) {
          this.releaseSessionReplyAnchor(sessionId, entry.msgId);
        }
      }
      // Derived reclamation: the iteration domain is the counter
      // map itself, so a counter whose only naming entry was already deleted —
      // earlier in this tick or on a previous one — is still visited, and one
      // that outlived its last holder between two ticks is dropped here rather
      // than leaking. reclaimMsgSeq persists internally when it drops a counter,
      // which already covers the TTL evictions above; the explicit save below
      // is only needed for a tick that evicted entries without dropping one.
      if (this.reclaimOrphanMsgSeqCounters()) reclaimed = true;
      if (dirty && !reclaimed) this.saveQQState();
    }, 60_000);
    this.replyMsgIdCleanupTimer.unref();
  }

  private stopReplyMsgIdCleanup(): void {
    if (this.replyMsgIdCleanupTimer) {
      clearInterval(this.replyMsgIdCleanupTimer);
      this.replyMsgIdCleanupTimer = null;
    }
  }

  // ── Token ──────────────────────────────────────────────────────

  private async fetchToken(): Promise<void> {
    const safeName = this.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const credsFile = getCredsFilePath(safeName);

    let appID = this.qqConfig.appID;
    let appSecret = this.qqConfig.appSecret;

    if (!appID || !appSecret) {
      const saved = loadCredentials(credsFile);
      if (saved) {
        appID = saved.appId;
        appSecret = saved.appSecret;
        this.qqConfig.appID = appID;
        this.qqConfig.appSecret = appSecret;
      }
    }

    if (!appID || !appSecret) {
      process.stderr.write(
        `[QQ:${this.name}] No credentials, scan QR code with QQ...\n`,
      );
      const creds = await qrCodeLogin();
      appID = creds.appId;
      appSecret = creds.appSecret;
      this.qqConfig.appID = appID;
      this.qqConfig.appSecret = appSecret;
      saveCredentials(credsFile, appID, appSecret);
    }

    const token = await fetchAccessToken(appID, appSecret);
    this.accessToken = token.accessToken;
    this.tokenExpiresAt = Date.now() + token.expiresIn * 1000;
    this.scheduleTokenRefresh();
  }

  private scheduleTokenRefresh(): void {
    if (this.disposed) return;
    this.stopTokenRefresh();
    const ttl = Math.max(0, this.tokenExpiresAt - Date.now());
    // Refresh at 80% of TTL, at least 10s before expiry, at most ttl-30s
    const delay = Math.min(ttl * 0.8, Math.max(ttl - 30_000, 10_000));
    if (delay > 0) {
      const tokenReconnectId = this._reconnectId;
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          if (this.disposed || this._reconnectId !== tokenReconnectId) return;
          process.stderr.write(
            `[QQ:${this.name}] Token refresh failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, will retry\n
`,
          );
          // Retry up to 10 times at 60s intervals, then give up.
          // Token refresh failure after 10 attempts (10 min) indicates
          // a persistent issue (revoked credentials, DNS, firewall) that
          // won't resolve by retrying — disconnect and reconnect so the
          // fresh connection re-fetches the token, preventing zombie-state
          // where the WS stays connected but outbound messages are dropped.
          let retryCount = 0;
          const retry = () => {
            if (this.disposed || this._reconnectId !== tokenReconnectId) return;
            if (++retryCount > 10) {
              process.stderr.write(
                `[QQ:${this.name}] FATAL: token refresh exhausted, reconnecting\n
`,
              );
              this.isReconnecting = true;
              this.disconnect();
              const postDisconnectReconnectId = this._reconnectId;
              this.reconnectTimer = setTimeout(() => {
                if (this._reconnectId !== postDisconnectReconnectId) return;
                this.isReconnecting = false;
                this.disposed = false;
                // Use reconnectWithRetry instead of bare connect() —
                // gives exponential backoff + maxReconnectAttempts guard,
                // preventing zombie state where the channel is permanently
                // offline after token exhaustion.
                this.reconnectWithRetry();
              }, 1000);
              this.reconnectTimer.unref?.();
              return;
            }
            this.tokenRefreshTimer = setTimeout(() => {
              this.fetchToken().catch((e2) => {
                if (this.disposed || this._reconnectId !== tokenReconnectId)
                  return;
                process.stderr.write(
                  `[QQ:${this.name}] Token refresh retry failed (attempt ${retryCount}): ${sanitizeLogText(e2 instanceof Error ? e2.message : String(e2), 200)}\n
`,
                );
                retry();
              });
            }, 60_000);
            this.tokenRefreshTimer.unref?.();
          };
          retry();
        });
      }, delay);
      this.tokenRefreshTimer.unref?.();
    }
  }

  private stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  // ── WebSocket Gateway ──────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    if (this.disposed) throw new Error('Channel disposed');
    const url = await fetchGatewayUrl(
      this.accessToken,
      Boolean(this.qqConfig.sandbox),
    );

    return new Promise<void>((resolve, reject) => {
      this.connectReject = reject;
      this.dialGateway(url, resolve, reject);
    });
  }

  private dialGateway(
    url: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    this.ws = new WebSocket(url);
    const dialed = this.ws;

    // 30-second READY timeout — if the gateway never sends READY,
    // close the connection so connect() rejects instead of hanging.
    this.readyTimeout = setTimeout(() => {
      if (this.ws !== dialed) return;
      process.stderr.write(
        `[QQ:${this.name}] READY timeout after 30s, closing\n`,
      );
      this.ws?.close(4002, 'READY timeout');
      reject(new Error(`[QQ:${this.name}] READY timeout after 30s`));
    }, 30_000);
    this.readyTimeout.unref?.();

    this.ws.on('open', () => {
      process.stderr.write(`[QQ:${this.name}] WebSocket connected\n`);
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleGatewayMessage(msg, resolve);
      } catch (e) {
        process.stderr.write(
          `[QQ:${this.name}] Malformed gateway message: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
      }
    });

    this.ws.on('close', (code: number) => {
      if (this.ws !== dialed) return;
      process.stderr.write(
        `[QQ:${this.name}] WebSocket closed (code=${code})\n`,
      );
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.stopHeartbeat();
      this.ws = null;
      this._ready = false;

      const shouldReconnect =
        this.serverRequestedReconnect ||
        (code !== 1000 &&
          (this.maxReconnectAttempts <= 0 ||
            this.reconnectAttempts < this.maxReconnectAttempts));

      this.serverRequestedReconnect = false;

      // Non-1000 close codes (e.g. 4009) imply the server-side session is
      // gone; skip the RESUME attempt and go straight to IDENTIFY.
      if (code !== 1000 && code !== 4000) {
        this.tryResume = false;
        this.flushQQState();
        this.coldStart = true;
      }
      if (shouldReconnect && this.connectReject) {
        this.connectReject(
          new Error(`WebSocket closed before READY (code=${code})`),
        );
        this.connectReject = null;
      } else if (shouldReconnect) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
        process.stderr.write(
          `[QQ:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}${this.maxReconnectAttempts > 0 ? `/${this.maxReconnectAttempts}` : ''})\n`,
        );
        if (!this.isReconnecting) {
          this.reconnectTimer = setTimeout(
            () => this.reconnectWithRetry(),
            delay,
          );
          this.reconnectTimer.unref();
        }
      } else if (
        this.maxReconnectAttempts > 0 &&
        this.reconnectAttempts >= this.maxReconnectAttempts
      ) {
        process.stderr.write(
          `[QQ:${this.name}] FATAL: reconnect exhausted after ${this.maxReconnectAttempts} attempts. Bot is offline until daemon restart.\n`,
        );
        if (this.connectReject) {
          this.connectReject(
            new Error(
              `WebSocket closed (max reconnect attempts, code=${code})`,
            ),
          );
          this.connectReject = null;
        }
      } else {
        if (this.connectReject) {
          this.connectReject(
            new Error(`WebSocket closed before READY (code=${code})`),
          );
          this.connectReject = null;
        }
      }
    });

    this.ws.on('error', (e: Error) => {
      process.stderr.write(
        `[QQ:${this.name}] WebSocket error: ${sanitizeLogText(e.message, 200)}\n`,
      );
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(e);
      }
    });
  }

  /**
   * Finalize READY state across cold-start and warm-reconnect paths.
   * Extracted to eliminate triplication in the READY handler.
   */
  private finalizeReady(): void {
    if (!this.ws || this.disposed) return;
    this._ready = true;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.coldStart = false;
    this.attachCronHandler();
    this.attachBridgeBoundarySeal();
  }

  private handleGatewayMessage(
    msg: Record<string, unknown>,
    onReady: () => void,
  ): void {
    const op = msg['op'] as number;

    switch (op) {
      case OpCode.HELLO: {
        this.heartbeatInterval = Math.max(
          ((msg['d'] as Record<string, unknown> | undefined)?.[
            'heartbeat_interval'
          ] as number) || 45000,
          5000,
        );
        this.sendIdentify();
        break;
      }
      case OpCode.DISPATCH: {
        const t = msg['t'] as string;
        const s = msg['s'] as number | undefined;
        if (s !== undefined) this.seq = s;

        if (t === 'READY') {
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.sessionId =
            ((msg['d'] as Record<string, unknown> | undefined)?.[
              'session_id'
            ] as string) || '';
          this.tryResume = true;

          this.connectReject = null;
          this.startHeartbeat();
          if (this.coldStart) {
            this.restoreGlobalSessions();
            if (!this.restoreQQState()) {
              process.stderr.write(
                `[QQ:${this.name}] WARNING: QQ state restore failed — routing maps are empty, group messages may be misrouted\n`,
              );
            }
            this.router
              .restoreSessions()
              .then(() => {
                this.fixRestoredSessions();
                this.purgeSingleScopeOrphans();
                const all = (
                  this.router as unknown as {
                    getAll?: () => Array<{
                      target?: { chatId?: string };
                      sessionId?: string;
                    }>;
                  }
                ).getAll?.();
                const count = all?.length ?? 0;
                process.stderr.write(
                  `[QQ:${this.name}] Ready (${count} sessions)\n`,
                );
                this.finalizeReady();
                this._checkGroupAllPolicyRequireMention();
                onReady();
              })
              .catch(() => {
                this.fixRestoredSessions();
                // A partial restore attached orphans too (each loaded session
                // is exactly what the purge releases), so the repair branch
                // must run the same purge as the success branch.
                this.purgeSingleScopeOrphans();
                process.stderr.write(
                  `[QQ:${this.name}] WARNING: router session restore failed — cron messages will be dropped until sessions re-establish\n`,
                );
                this.finalizeReady();
                this._checkGroupAllPolicyRequireMention();
                onReady();
              });
          } else {
            process.stderr.write(
              `[QQ:${this.name}] Ready (warm reconnect, skipping state restore)\n`,
            );
            this.finalizeReady();
            this._checkGroupAllPolicyRequireMention();
            onReady();
          }
        } else if (t === 'C2C_MESSAGE_CREATE') {
          this.handleC2C(msg['d'] as unknown as QQMessageEvent);
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroup(msg['d'] as unknown as QQGroupMessageEvent);
        } else if (t === 'GROUP_MESSAGE_CREATE') {
          this.handleGroupAll(msg['d'] as unknown as QQGroupMessageEvent);
        } else if (t === 'GROUP_ADD_ROBOT') {
          this.handleGroupAddRobot(msg['d'] as unknown as GroupAddRobotEvent);
        } else if (t === 'GROUP_DEL_ROBOT') {
          this.handleGroupDelRobot(msg['d'] as unknown as GroupDelRobotEvent);
        } else if (t === 'GROUP_MSG_REJECT') {
          this.handleGroupMsgToggle(
            msg['d'] as unknown as GroupMsgToggleEvent,
            false,
          );
        } else if (t === 'GROUP_MSG_RECEIVE') {
          this.handleGroupMsgToggle(
            msg['d'] as unknown as GroupMsgToggleEvent,
            true,
          );
        } else if (t === 'RESUMED') {
          // RESUME success — the process did NOT restart, all in-memory
          // session state, QQ routing state, and global sessions.json are
          // still intact. Calling restoreSessions() would drop and re-attach
          // every session, aborting in-flight LLM prompts.
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.connectReject = null;
          this.finalizeReady();
          this.startHeartbeat();
          onReady();
        }
        break;
      }
      case OpCode.HEARTBEAT_ACK:
        this.lastHeartbeatAck = Date.now();
        break;
      case OpCode.RECONNECT:
        this.serverRequestedReconnect = true;
        this.ws?.close(4000);
        break;
      case OpCode.INVALID_SESSION:
        process.stderr.write(
          `[QQ:${this.name}] Server sent INVALID_SESSION, falling back to IDENTIFY\n`,
        );
        this.tryResume = false;
        // Cancel any pending debounced save to prevent a TOCTOU race
        // between saveQQState and the coldStart restore on the next READY.
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
        // Flush state first to persist any debounced updates before
        // coldStart=true triggers a full restore on the next READY.
        this.flushQQState();
        // Mark not ready to prevent concurrent processors from calling
        // saveQQState() during the INVALID_SESSION recovery window.
        this._ready = false;
        // Trigger full state restore on the next READY — the gateway
        // assigned a new session_id, so in-memory routing state
        // (chatTypeMap, replyMsgId, msgSeqMap) must be reloaded.
        this.coldStart = true;
        // Note: intentionally NOT refreshing token here. The server's
        // INVALID_SESSION is more likely from gateway-side session reset
        // than from token expiry. If the token IS expired, the re-IDENTIFY
        // will fail with a WS close, and the reconnect path will refresh
        // the token before the next attempt.
        this.sendIdentify();
        // Guard the re-IDENTIFY READY with a fresh timeout. The initial
        // readyTimeout was cleared by the first READY handler; without this,
        // an INVALID_SESSION re-IDENTIFY that never gets a response will
        // hang forever with no timeout to trigger a reconnect.
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        this.readyTimeout = setTimeout(() => {
          if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN ||
              this.ws.readyState === WebSocket.CONNECTING)
          ) {
            this.ws.close(4002);
            if (this.connectReject) {
              this.connectReject(new Error('Timed out waiting for READY'));
              this.connectReject = null;
            }
          }
        }, 30_000);
        this.readyTimeout.unref?.();
        break;
      default:
        break;
    }
  }

  private sendIdentify(): void {
    if (!this.ws) return;
    if (this.tryResume && this.sessionId) {
      process.stderr.write(
        `[QQ:${this.name}] Sending RESUME (session: ${this.sessionId})\n`,
      );
      this.ws.send(
        JSON.stringify({
          op: OpCode.RESUME,
          d: {
            token: `QQBot ${this.accessToken}`,
            session_id: this.sessionId,
            seq: this.seq,
          },
        }),
      );
      return;
    }
    // Include GROUP_MESSAGE intent when groupAllPolicy requires it
    const needsGroupMsg =
      this.qqConfig.groupAllPolicy === 'keyword' ||
      this.qqConfig.groupAllPolicy === 'all' ||
      this.qqConfig.groupAllPolicy === 'log';
    this.ws.send(
      JSON.stringify({
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents:
            Intent.C2C_MESSAGE |
            Intent.GROUP_AT_MESSAGE |
            (needsGroupMsg ? Intent.GROUP_MESSAGE : 0),
          shard: [0, 1],
          properties: {},
        },
      }),
    );
  }

  /**
   * Reconnect loop with retry on gateway fetch failures.
   * Refreshes token before each attempt, and retries GW HTTP failures
   * with exponential backoff. Keeps retrying until success.
   */
  private async reconnectWithRetry(): Promise<void> {
    if (this.disposed) return;
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    try {
      const myReconnectId = this._reconnectId;

      const maxGwRetries = this.qqConfig.maxGwRetries ?? 5;
      const unlimitedRetries = maxGwRetries <= 0;
      for (
        let attempt = 0;
        unlimitedRetries || attempt < maxGwRetries;
        attempt++
      ) {
        if (this.disposed || this._reconnectId !== myReconnectId) return;

        this.reconnectAttempts++;

        if (
          this.maxReconnectAttempts > 0 &&
          this.reconnectAttempts >= this.maxReconnectAttempts
        ) {
          process.stderr.write(
            `[QQ:${this.name}] RC: reconnect attempts exhausted, giving up\n`,
          );
          return;
        }

        try {
          try {
            await this.fetchToken();
          } catch {
            process.stderr.write(
              `[QQ:${this.name}] RC: token refresh failed, retrying...\n`,
            );
            await this.sleep(2000);
            if (this.disposed) return;
            continue;
          }
          await this.connectGateway();
          this.startReplyMsgIdCleanup();
          return;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const backoff = Math.min(1000 * 2 ** (attempt + 1), 30000);
          process.stderr.write(
            `[QQ:${this.name}] RC: ${sanitizeLogText(msg, 200)} (retry in ${backoff}ms, attempt ${attempt + 1}${unlimitedRetries ? '' : `/${maxGwRetries}`})\n`,
          );
          if (unlimitedRetries || attempt < maxGwRetries - 1)
            await this.sleep(backoff);
        }
      }
      process.stderr.write(
        `[QQ:${this.name}] RC: exhausted ${unlimitedRetries ? '∞' : maxGwRetries} reconnect retries, will retry in 60s\n`,
      );
      this.tryResume = false;
    } finally {
      this.isReconnecting = false;
    }
    this.reconnectTimer = setTimeout(() => this.reconnectWithRetry(), 60000);
    this.reconnectTimer.unref();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatAck = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const elapsed = Date.now() - this.lastHeartbeatAck;
      if (elapsed > this.heartbeatInterval * 2) {
        process.stderr.write(
          `[QQ:${this.name}] Heartbeat ACK timeout (${elapsed}ms), forcing reconnect\n`,
        );
        this.ws?.close(4001);
        return;
      }
      this.ws.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq }));
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Bot OpenID extraction ──────────────────────────────────────

  private extractBotOpenId(
    mentions: QQGroupMessageEvent['mentions'],
    chatId?: string,
  ): string {
    const selfMention = mentions?.find((m) => m.is_you);
    if (!selfMention) return '';
    const botOpenId = selfMention.member_openid || selfMention.id || '';
    if (!QQ_OPENID_RE.test(botOpenId)) {
      process.stderr.write(
        `[QQ:${this.name}] Invalid botOpenId format: ${sanitizeLogText(botOpenId, 64)}\n`,
      );
      return '';
    }
    if (chatId) {
      this.botOpenIdByGroup.set(chatId, botOpenId);
      this.saveQQState();
    }
    return botOpenId;
  }

  // ── Message Handlers ───────────────────────────────────────────

  /** Check if a message ID was already processed (reconnect replay dedup). */
  private isDuplicate(eventId: string): boolean {
    if (this.seenMessages.has(eventId)) return true;
    const now = Date.now();
    this.seenMessages.set(eventId, now);
    if (!this.seenCleanupTimer) {
      this.seenCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - QQChannel.REPLY_MSG_ID_TTL_MS;
        for (const [id, ts] of this.seenMessages) {
          if (ts < cutoff) this.seenMessages.delete(id);
        }
        if (this.seenMessages.size === 0) {
          clearInterval(this.seenCleanupTimer!);
          this.seenCleanupTimer = null;
        }
      }, 60_000).unref();
    }
    return false;
  }
  /**
   * Extract common group-message fields shared by handleGroup and handleGroupAll.
   * Returns null when the message has no meaningful text after @-tag stripping.
   */
  private prepareGroupMessage(
    event: QQGroupMessageEvent,
    chatId: string,
    { forceAtMention }: { forceAtMention?: boolean } = {},
  ): {
    isAtBot: boolean;
    isSlash: boolean;
    safeName: string;
    cleanText: string;
    commandText: string;
    routeText: string;
    body: string;
    text: string;
    senderName: string;
  } | null {
    // Keep identity values out of the display-name position. In particular,
    // falling back to member_openid would expose a full mentionable OPENID
    // even when allowMention is disabled and duplicate it when enabled.
    const senderName = event.author?.username || 'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const senderOpenId =
      event.author?.member_openid || event.author?.user_openid || '';
    const senderIdentity = senderOpenId || event.author?.id || '';

    const content = (event.content || '').trim();
    const cleanText = content.replace(/<@[^>]{1,64}>/g, '').trim();
    let mentionIndex = 0;
    const displayContent = content
      .replace(/<@[^>]{1,64}>/g, (mention) =>
        event.mentions?.[mentionIndex++]?.is_you ? '' : mention,
      )
      .trim();
    // Strip trusted tags that could be forged by users
    const safeCleanText = cleanText
      .replace(/\[atMention=[^\]]*]/g, '')
      .replace(/\[botOpenId:[^\]]*]/g, '')
      .replace(/\[bot]/g, '')
      .trim();
    const safeDisplayText = displayContent
      .replace(/\[atMention=[^\]]*]/g, '')
      .replace(/\[botOpenId:[^\]]*]/g, '')
      .replace(/\[bot]/g, '')
      .trim();
    const isAtBot = event.mentions?.some((m) => m.is_you) ?? false;

    // Extract bot's own OPENID from mentions (per-group) — must come
    // BEFORE the cleanText guard so pure @-bot messages still populate
    // the per-group OPENID cache.
    if (isAtBot && !this.botOpenIdByGroup.has(chatId)) {
      this.extractBotOpenId(event.mentions, chatId);
    }

    if (!cleanText && this.inboundMedia(event).length === 0) return null;

    const effectiveIsAtBot = forceAtMention ?? isAtBot;

    const rawCommandText = safeCleanText.replace(/<@[^>]{1,64}>/g, '').trim();
    const isSlash = effectiveIsAtBot && rawCommandText.startsWith('/');
    const commandText = sanitizePromptText(rawCommandText);

    // Deliberately NOT hard-blocking bot messages — QQ Bot API may deliver
    // self-echoes or other bot messages. Instead, tag with [bot] prefix so the
    // model can judge relevance and decide whether to respond. Hard-blocking
    // would prevent intentional bot-to-bot interactions that the operator
    // explicitly configures. The [bot] prefix gives the model enough context
    // to ignore irrelevant bot traffic.
    // NOTE: Both callers (handleGroup, handleGroupAll) guard against bot
    // messages before reaching prepareGroupMessage, so isBot is always false
    // here. The check is retained as defense-in-depth in case a future
    // caller skips the guard.

    const groupBotOpenId = this.botOpenIdByGroup.get(chatId);
    const openIdSuffix =
      this.qqConfig.allowMention !== false && groupBotOpenId
        ? ` [botOpenId:${groupBotOpenId}]`
        : '';
    const suffixFromBotOpenId =
      this.qqConfig.allowMention !== false && groupBotOpenId
        ? `\n机器人 OPENID: ${groupBotOpenId}`
        : '';
    // Full sender OPENID is only exposed when mention support is enabled
    // and the value is a well-formed 32-hex OPENID.
    const showSenderOpenId =
      this.qqConfig.allowMention !== false &&
      !!senderOpenId &&
      QQ_OPENID_RE.test(senderOpenId);
    // Warn once per (chatId, senderOpenId) about malformed OPENIDs, and only
    // when mention support is enabled (with allowMention=false the 8-char
    // fragment below surfaces the value instead, so a warning is noise).
    // Bounded: reset the set past 500 entries so unusual chatId/senderOpenId
    // combos can't accumulate without limit. `showSenderOpenId` is exactly
    // `allowMention !== false && senderOpenId && QQ_OPENID_RE.test(...)`, so
    // this condition is equivalent to the old explicit re-test, without the
    // duplicate regex evaluation.
    if (
      !showSenderOpenId &&
      this.qqConfig.allowMention !== false &&
      senderOpenId
    ) {
      // chatId is already validated and bounded. Cap only the remote-controlled
      // sender component so different senders in a long chatId remain distinct.
      const dedupKey = `${chatId}:${truncateCodePoints(senderOpenId, 64)}`;
      if (!this.warnedSenderOpenIds.has(dedupKey)) {
        this.warnedSenderOpenIds.add(dedupKey);
        if (this.warnedSenderOpenIds.size > 500) {
          this.warnedSenderOpenIds.clear();
        }
        process.stderr.write(
          `[QQ:${this.name}] Unexpected senderOpenId format: ${sanitizeLogText(senderOpenId, 64)}\n`,
        );
      }
    }
    // Unified fallback: whenever the full OPENID can't be shown (mention
    // support off, the value failing the 32-hex shape, or only a legacy author
    // ID being available), surface a short 8-code-point identity fragment +
    // ellipsis so same-nickname senders stay distinguishable without exposing
    // a constructible full <@OPENID>.
    // Truncation is code-point aware (truncateCodePoints), so an emoji-laden
    // malformed id can't be split mid-surrogate-pair into a lone surrogate.
    const senderTag = showSenderOpenId
      ? `(${senderOpenId})`
      : senderIdentity
        ? `(${truncateCodePoints(sanitizeSenderName(senderIdentity), 8)}…)`
        : '';
    const head = `[atMention=${effectiveIsAtBot}]${openIdSuffix} [${safeName}${senderTag}]: `;
    const body = sanitizePromptText(
      this.qqConfig.allowMention !== false ? safeDisplayText : safeCleanText,
    );
    const text = isSlash
      ? sanitizePromptText(safeCleanText)
      : `${head}${body}${suffixFromBotOpenId}`;

    return {
      isAtBot: effectiveIsAtBot,
      isSlash,
      safeName,
      cleanText,
      commandText,
      routeText: sanitizePromptText(safeDisplayText),
      body,
      text,
      senderName,
    };
  }

  /** All supported attachments of a message, in event order. */
  private inboundMedia(event: QQMessageEvent): QQInboundMedia[] {
    return (event.attachments ?? [])
      .map((attachment) => ({
        attachment,
        kind: classifyQQAttachment(attachment.content_type),
      }))
      .filter((entry): entry is QQInboundMedia => entry.kind !== undefined);
  }

  private dispatchInbound(
    envelope: Envelope,
    media: QQInboundMedia[],
  ): Promise<void> {
    if (media.length === 0) return this.handleInbound(envelope);
    return this.prepareThenHandleInbound(envelope, () =>
      this.attachInboundMedia(envelope, media),
    );
  }

  private async attachInboundMedia(
    envelope: Envelope,
    media: QQInboundMedia[],
  ): Promise<void> {
    const selected = cappedMedia(media);
    if (selected.length < media.length) {
      process.stderr.write(
        `[QQ:${this.name}] skipping ${media.length - selected.length} attachment(s): over the per-message limit of ${QQ_MAX_ATTACHMENTS}\n`,
      );
    }
    const attachments: Attachment[] = [];
    for (const { attachment, kind } of selected) {
      try {
        const { buffer, mimeType } = await downloadQQAttachment(
          attachment.url,
          kind === 'image' ? QQ_IMAGE_MAX_BYTES : QQ_VIDEO_MAX_BYTES,
          attachment.content_type,
        );
        const fileName = attachmentFileName(
          attachment.filename,
          kind,
          mimeType,
        );
        const dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const filePath = join(dir, fileName);
        await writeFile(filePath, buffer, { mode: 0o600 });
        if (kind === 'image') {
          // The image entry carries the picture for an image-capable model; the
          // file entry only exists so a text-only model still gets a path.
          attachments.push({
            type: 'image',
            data: buffer.toString('base64'),
            mimeType,
            fileName,
          });
          attachments.push({ type: 'file', filePath, mimeType, fileName });
          continue;
        }
        attachments.push({ type: 'video', filePath, mimeType, fileName });
      } catch (err) {
        process.stderr.write(
          `[QQ:${this.name}] skipping ${kind} attachment: ${sanitizeLogText(
            err instanceof Error ? err.message : String(err),
            160,
          )}\n`,
        );
      }
    }
    if (attachments.length > 0) envelope.attachments = attachments;
    if (envelope.syntheticText && attachments.length === 0) {
      envelope.text = '(User sent media but download failed)';
    }
  }

  private handleC2C(event: QQMessageEvent): void {
    if (this.isDuplicate(event.id)) return;
    const media = this.inboundMedia(event);
    const rawContent = event.content ?? '';
    if (!rawContent.trim() && media.length === 0) return;
    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] C2C message dropped: missing author\n`,
      );
      return;
    }
    if (event.author.bot) {
      process.stderr.write(`[QQ:${this.name}] Bot C2C message dropped\n`);
      return;
    }
    const chatId = event.author.user_openid || event.author.id;
    if (!chatId) {
      process.stderr.write(
        `[QQ:${this.name}] C2C message dropped: no chatId for author\n`,
      );
      return;
    }
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] C2C message dropped: invalid chatId (length=${chatId.length})\n`,
      );
      return;
    }
    this.chatTypeMap.set(chatId, 'c2c');
    this.setReplyMsgId(chatId, event.id);
    const senderName = event.author.username || event.author.id || 'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const cleanText = rawContent.trim();
    // Strip system-reserved tags that could be forged by users
    const safeContent = cleanText
      .replace(/\[atMention=[^\]]*]/g, '')
      .replace(/\[botOpenId:[^\]]*]/g, '')
      .replace(/\[bot]/g, '');
    const isSlash = safeContent.startsWith('/');
    const body = sanitizePromptText(safeContent);
    const mediaOnly = !body && media.length > 0;
    const text = mediaOnly
      ? mediaPlaceholder(media)
      : isSlash || this.config.messageRoutes
        ? body
        : `[atMention=true] [${safeName}]: ${body}`;
    const envelope: Envelope = {
      channelName: this.name,
      senderId: chatId,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: false,
      isMentioned: true,
      isReplyToBot: false,
      ...(mediaOnly ? { syntheticText: true as const } : {}),
      ...(isSlash || this.config.messageRoutes
        ? {}
        : { alreadyPrefixed: true as const }),
    };
    this.dispatchInbound(envelope, media).catch((e) =>
      process.stderr.write(
        `[QQ:${this.name}] C2C handler error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      ),
    );
  }

  private handleGroup(event: QQGroupMessageEvent): void {
    if (!event.group_openid) {
      process.stderr.write(
        `[QQ:${this.name}] Group message dropped: missing group_openid\n`,
      );
      return;
    }
    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] Group message dropped: missing author\n`,
      );
      return;
    }
    if (event.author.bot) {
      process.stderr.write(
        `[QQ:${this.name}] Bot message dropped in group ${sanitizeLogText(event.group_openid, 64)}\n`,
      );
      return;
    }
    const chatId = event.group_openid;
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] Group message dropped: invalid group_openid\n`,
      );
      return;
    }
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, 'group');
    if (isNewGroup) this.saveQQState();

    // Deduplicate after prepareGroupMessage so side effects
    // (extractBotOpenId) always run, even for replayed duplicates.
    // Only skip handleInbound on duplicates — this prevents silent
    // drops when GROUP_MESSAGE_CREATE fires before GROUP_AT_MESSAGE_CREATE
    // for the same message.

    const result = this.prepareGroupMessage(event, chatId, {
      forceAtMention: true,
    });
    if (!result) return;
    const { isSlash, text, commandText, routeText, senderName, safeName } =
      result;
    const media = this.inboundMedia(event);
    const mediaOnly = result.body === '' && media.length > 0;

    // Deduplicate before handleInbound — prepareGroupMessage already ran
    // so side effects (extractBotOpenId) are applied regardless of dedup.
    if (this.isDuplicate(event.id)) return;

    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(commandText.split(/\s/)[0], 64)}\n`,
      );
    }

    // GROUP_AT_MESSAGE_CREATE always has finalIsAtBot=true, so @-bot
    // messages are always delivered. Log when active messages are disabled.
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroup: active messages disabled but @-bot allowed through (passive)\n`,
      );
    }
    const senderId =
      event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(
        `[QQ:${this.name}] Group message dropped: no senderId for author\n`,
      );
      return;
    }
    this.setReplyMsgId(chatId, event.id);
    const envelope: Envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text: mediaOnly
        ? mediaPlaceholder(media)
        : this.config.messageRoutes
          ? routeText
          : text,
      messageId: event.id,
      isGroup: true,
      isMentioned: true,
      isReplyToBot: true,
      ...(mediaOnly ? { syntheticText: true as const } : {}),
      ...(isSlash || this.config.messageRoutes
        ? {}
        : { alreadyPrefixed: true as const }),
    };
    this.dispatchInbound(envelope, media).catch((e) =>
      process.stderr.write(
        `[QQ:${this.name}] Group handler error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      ),
    );
  }
  private handleGroupAll(event: QQGroupMessageEvent): void {
    if (!event.group_openid) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: missing group_openid\n`,
      );
      return;
    }

    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: missing author\n`,
      );
      return;
    }
    if (event.author.bot) {
      process.stderr.write(
        `[QQ:${this.name}] Bot message dropped in group ${sanitizeLogText(event.group_openid, 64)}\n`,
      );
      return;
    }

    const chatId = event.group_openid;
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: invalid group_openid\n`,
      );
      return;
    }
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, 'group');
    if (isNewGroup) this.saveQQState();

    const result = this.prepareGroupMessage(event, chatId);
    if (!result) return;
    const {
      isSlash,
      text,
      commandText,
      routeText,
      senderName,
      isAtBot,
      safeName,
    } = result;
    const media = this.inboundMedia(event);
    const mediaOnly = result.body === '' && media.length > 0;

    // @-bot messages always pass through (passive reply).
    // Non-@-bot messages are subject to active-message and keyword policies.
    if (!isAtBot) {
      if (this.groupActiveMsgEnabled.get(chatId) === false) {
        process.stderr.write(
          `[QQ:${this.name}] handleGroupAll blocked: active messages disabled for ${sanitizeLogText(chatId, 64)}\n`,
        );
        return;
      }

      const rawPolicy = this.qqConfig.groupAllPolicy;
      const policy =
        rawPolicy === 'keyword' || rawPolicy === 'all' ? rawPolicy : 'log';

      if (policy === 'log') {
        process.stderr.write(
          `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: log policy — message from ${sanitizeLogText(senderName, 64)} not forwarded\n`,
        );
        return;
      }

      if (policy === 'keyword') {
        if (!this._keywordTriggerCache) {
          this._keywordTriggerCache = (this.qqConfig.keywordTriggers ?? [])
            .filter((kw) => kw.length > 0)
            .map((kw) => {
              const normalized = kw.normalize('NFC');
              const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const firstIsAscii = /^[A-Za-z0-9_]/.test(normalized);
              const lastIsAscii = /[A-Za-z0-9_]$/.test(normalized);
              const lb = firstIsAscii ? '(?:^|[^\\w])' : '';
              const la = lastIsAscii ? '(?:[^\\w]|$)' : '';
              return new RegExp(`${lb}${escaped}${la}`, 'i');
            });
        }
        if (this._keywordTriggerCache.length === 0) {
          process.stderr.write(
            `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy — no keywords configured, message from ${sanitizeLogText(senderName, 64)} not forwarded\n`,
          );
          return;
        }
        const keywordText = result.cleanText.normalize('NFC');
        const matched = this._keywordTriggerCache.some((re) =>
          re.test(keywordText),
        );
        if (!matched) {
          const now = Date.now();
          const lastLog = this._lastKeywordNoMatchLog.get(chatId) ?? 0;
          if (now - lastLog >= 60000) {
            this._lastKeywordNoMatchLog.set(chatId, now);
            process.stderr.write(
              `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy — no match for message from ${sanitizeLogText(senderName, 64)}\n`,
            );
          }
          return;
        }
      }
    } else if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll: @-bot message allowed through (passive) despite active messages disabled for ${sanitizeLogText(chatId, 64)}\n`,
      );
    }

    // isDuplicate handles reconnect replay protection (same event.id).
    if (this.isDuplicate(event.id)) return;

    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(commandText.split(/\s/)[0], 64)}\n`,
      );
    }

    // Non-@-bot messages pass isMentioned:false, which causes GroupGate.requireMention
    // to silently drop them before they reach the LLM. This is by core design:
    // non-@-bot group messages should flow through cron/log only, not trigger AI.
    // The isMentioned=true override for non-@-bot keyword/all matches (PR #6457
    // review thread #17, landed in 998d36068b, then reverted there) was
    // intentionally not restored — it violated principle #1.
    // Users must set requireMention: false in group config
    // (e.g., `groups: { '*': { requireMention: false } }`) to allow
    // non-@-bot keyword/all messages to reach the AI.

    const senderId =
      event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: no senderId for author\n`,
      );
      return;
    }
    // Set replyMsgId for all messages that pass the policy gate,
    // not just @-bot ones.
    this.setReplyMsgId(chatId, event.id);
    const envelope: Envelope = {
      channelName: this.name,
      chatId,
      text: mediaOnly
        ? mediaPlaceholder(media)
        : this.config.messageRoutes
          ? routeText
          : text,
      senderId,
      senderName,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      ...(mediaOnly ? { syntheticText: true as const } : {}),
      ...(isSlash || this.config.messageRoutes
        ? {}
        : { alreadyPrefixed: true as const }),
    };
    this.dispatchInbound(envelope, media).catch((e) => {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      );
    });
  }

  // ── Group management events ────────────────────────────────────

  private handleGroupAddRobot(event: GroupAddRobotEvent): void {
    const groupId = event.group_openid;
    if (!groupId) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAddRobot: missing group_openid\n`,
      );
      return;
    }
    if (!isValidChatId(groupId)) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAddRobot: invalid group_openid (length=${groupId.length})\n`,
      );
      return;
    }
    this.chatTypeMap.set(groupId, 'group');
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Added to group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}\n`,
    );
  }

  private handleGroupDelRobot(event: GroupDelRobotEvent): void {
    const groupId = event.group_openid;
    if (!groupId) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupDelRobot: missing group_openid\n`,
      );
      return;
    }
    if (!isValidChatId(groupId)) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupDelRobot: invalid group_openid (length=${groupId.length})\n`,
      );
      return;
    }
    this.chatTypeMap.delete(groupId);
    this.groupActiveMsgEnabled.delete(groupId);
    // msgSeqMap is keyed by message ID, not group_openid — get the message ID
    // from replyMsgId before dropping the entry. The entry is removed BEFORE
    // the reclaim: while it is still present it is itself a holder, so
    // reclaiming first would always veto and leave the counter until the next
    // 60s sweep tick. A still-live holder (session anchor, stream entry,
    // in-flight send, routing map) vetoes as before.
    const replyEntry = this.replyMsgId.get(groupId);
    this.replyMsgId.delete(groupId);
    if (replyEntry) {
      this.reclaimMsgSeq(replyEntry.msgId);
    }
    for (const context of this.replyContextByMessageId.values()) {
      if (context.chatId === groupId) {
        this.replyContextByMessageId.delete(context.msgId);
        this.reclaimMsgSeq(context.msgId);
      }
    }
    this.botOpenIdByGroup.delete(groupId);
    this._lastKeywordNoMatchLog.delete(groupId);
    // Clean up cron buffers targeting this group (always, regardless of config flag)
    let cleanedCron = 0;
    for (const [sid, entry] of this.cronBuffer) {
      const state = this.streamState.get(sid);
      if (state?.chatId === groupId) {
        if (entry.timer) clearTimeout(entry.timer);
        this.cronBuffer.delete(sid);
        cleanedCron++;
      }
    }
    // Clean up active streamState sessions targeting this group.
    // Cancel pending idle-flush timers before deleting entries so
    // setTimeout callbacks don't fire and attempt to send to the
    // removed group.
    let cleanedStreams = 0;
    for (const [sid, state] of this.streamState) {
      if (state.chatId === groupId) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        // Disarm the residual before the release: the guard would otherwise
        // veto on state this same block destroys (the entry is deleted two
        // lines later), leaving the counter orphaned with no path left to
        // reclaim it. Same ordering property as onResponseChunk's superseded
        // branch; flushingSessions stays set for a genuine in-flight send.
        state.buffer = '';
        // Release before the deletes so the release guard still sees this
        // entry's in-flight marker and keeps the msg_seq counter while a
        // send owns it (release-before-delete ordering). Expected-msgId-gated:
        // under 'single' scope the matched session is channel-wide and may
        // already belong to a newer turn, whose anchor must not be deleted. A
        // proactive/loop turn's entry carries no msgId; releasing with
        // `undefined` would mean "no identity expectation" and delete the
        // shared session's live anchor, so skip the release entirely then.
        if (state.msgId !== undefined) {
          this.releaseSessionReplyAnchor(sid, state.msgId);
        }
        this.flushingSessions.delete(sid);
        this.pendingStreamDelete.delete(sid);
        this.flushedSessions.delete(sid);
        this.streamState.delete(sid);
        if (this.config.sessionScope !== 'single') {
          this.onSessionDied(sid);
        }
        cleanedStreams++;
      }
    }
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Removed from group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}, cleaned ${cleanedStreams} stream(s) and ${cleanedCron} cron buffer(s)\n`,
    );
  }

  private handleGroupMsgToggle(
    event: GroupMsgToggleEvent,
    enabled: boolean,
  ): void {
    if (!event.group_openid) {
      process.stderr.write(
        `[QQ:${this.name}] Group msg toggle dropped: missing group_openid\n`,
      );
      return;
    }
    if (!isValidChatId(event.group_openid)) {
      process.stderr.write(
        `[QQ:${this.name}] Group msg toggle dropped: invalid group_openid\n`,
      );
      return;
    }
    this.groupActiveMsgEnabled.set(event.group_openid, enabled);
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Active msg ${enabled ? 'enabled' : 'disabled'} for group ${sanitizeLogText(event.group_openid, 64)}\n`,
    );
  }
}
