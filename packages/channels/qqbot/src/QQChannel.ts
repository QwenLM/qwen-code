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
} from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  ChannelAgentBridge,
  ToolCallEvent,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { OpCode, Intent } from './types.js';
import type {
  QQChannelConfig,
  QQMessageEvent,
  QQGroupMessageEvent,
  GroupAddRobotEvent,
  GroupDelRobotEvent,
  GroupMsgToggleEvent,
} from './types.js';
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

export type DeliveryErrorCode =
  | 'RATE_LIMITED'
  | 'RETRY_EXHAUSTED'
  | 'FALLBACK_FAILED';

export class DeliveryError extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** Validate chatId to prevent SSRF when constructing URLs. */
export function isValidChatId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
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
  private readonly maxReconnectAttempts: number = 20;
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
  /** Cross-event-type dedup cache (e.g., GROUP_AT_MESSAGE_CREATE + GROUP_MESSAGE_CREATE). */
  private crossEventDedup: Map<string, number> = new Map();
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
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();
  /** Periodic cleanup timer for expired replyMsgId entries. */
  private replyMsgIdCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 5-minute TTL for replyMsgId entries and seenMessages dedup. */
  private static readonly REPLY_MSG_ID_TTL_MS = 300_000;
  /** Idle-flush timeout: buffer is sent after this many ms of silence. */
  private static readonly IDLE_FLUSH_MS = 2000;
  /** Max consecutive send failures before the stream is abandoned. */
  private static readonly MAX_FLUSH_RETRIES = 3;
  /** Retry delay for subsequent attempts (backoff beyond first retry). */
  private static readonly IDLE_FLUSH_BACKOFF_MS = 4000;
  /** Max buffer length before forcing an immediate flush. */
  private static readonly MAX_BUFFER_LENGTH = 4096;

  // ── Group / cron fields ────────────────────────────────────────

  /** Per-group bot OPENID map for multi-group support. */
  private botOpenIdByGroup: Map<string, string> = new Map();
  /** Guard: set to true after first READY + session restore completes. */
  private _ready: boolean = false;
  /** Whether this process has never received READY (cold start). */
  private coldStart: boolean = true;
  /** Track per-group active message permission. */
  private groupActiveMsgEnabled: Map<string, boolean> = new Map();
  /** Lazy cache for compiled keyword trigger RegExp patterns.
   * Built lazily on first access; never invalidated — keywordTriggers is not modified at runtime. */
  private _keywordTriggerCache: RegExp[] | null = null;

  /** Accumulation buffer for cron/non-prompt textChunk events. */
  private cronBuffer: Map<
    string,
    { buffer: string; timer: ReturnType<typeof setTimeout> | null }
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
  private streamState: Map<
    string,
    {
      chatId: string;
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
      retryCount: number;
    }
  > = new Map();
  private flushingSessions: Set<string> = new Set();
  private pendingStreamDelete: Set<string> = new Set();
  private _reconnectId: number = 0;
  private blockStreaming: boolean = false;
  private flushedSessions: Set<string> = new Set();
  private readonly qqStatePath: string;
  /**
   * Path to the global sessions.json managed by start.ts.
   * start.ts deletes it on shutdown, so we back it up.
   */
  private readonly globalSessionsPath: string;
  /** Backup of sessions.json so conversations survive daemon restarts. */
  private readonly sessionsBackupPath: string;

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

    const router =
      options?.router ??
      new SessionRouter(bridge, config.cwd, config.sessionScope, sessionsPath);

    super(name, config, bridge, {
      ...options,
      router,
      registerBridgeEvents: options?.registerBridgeEvents ?? !options?.router,
    });
    this.qqConfig = config as unknown as QQChannelConfig;
    this.blockStreaming = this.config.blockStreaming === 'on';
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

    // Permanent textChunk listener for cron/non-prompt messages.
    // ChannelBase's prompt-path textChunk listener is only alive during
    // bridge.prompt(). Cron messages bypass prompt() so their textChunk
    // events arrive without a listener. This permanent listener catches them.
    if (this.qqConfig['cron-msg-experimental']) {
      this._cronTextHandler = (sessionId: string, text: string) => {
        // Capture _inCronFlow BEFORE setImmediate to avoid a race:
        // if the flag is cleared in the same event-loop turn, the
        // deferred callback would see false and silently drop chunks.
        const wasInCronFlow = this._inCronFlow > 0;
        setImmediate(() => {
          if (!this._ready) return;
          if (!wasInCronFlow) return;
          if (this.streamState.has(sessionId)) return; // prompt path handles it
          let entry = this.cronBuffer.get(sessionId);
          if (!entry) {
            entry = { buffer: '', timer: null };
            this.cronBuffer.set(sessionId, entry);
          }
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          entry.buffer += text;
          // Size-cap flush: when buffer exceeds configurable limit, flush immediately.
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
                this.sendMessage(target.chatId, toFlush)
                  .then(() => {
                    if (!entry!.buffer) this.cronBuffer.delete(sessionId);
                  })
                  .catch((err) => {
                    const code = err instanceof DeliveryError ? err.code : null;
                    const codeStr = code ? ` (${code})` : '';
                    process.stderr.write(
                      `[QQ:${this.name}] Cron flush send error${codeStr}: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 200)}\n`,
                    );
                    if (code === 'RETRY_EXHAUSTED') {
                      this.cronBuffer.delete(sessionId);
                      return;
                    }
                    // Transient (RATE_LIMITED, FALLBACK_FAILED, etc.) — re-schedule flush
                    entry!.timer = setTimeout(() => {
                      const retryTarget = this.router.getTarget(sessionId);
                      if (!retryTarget) {
                        process.stderr.write(
                          `[QQ:${this.name}] Cron flush dropped after retry: no target for session ${sanitizeLogText(sessionId, 32)}\n`,
                        );
                        this.cronBuffer.delete(sessionId);
                        return;
                      }
                      this.sendMessage(retryTarget.chatId, toFlush)
                        .then(() => {
                          if (!entry!.buffer) this.cronBuffer.delete(sessionId);
                        })
                        .catch((retryErr) => {
                          process.stderr.write(
                            `[QQ:${this.name}] Cron flush retry failed: ${sanitizeLogText(retryErr instanceof Error ? retryErr.message : String(retryErr), 200)}\n`,
                          );
                          this.cronBuffer.delete(sessionId);
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
      };
      this.attachCronHandler();
    }
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
    super.setBridge(bridge);
    this.attachCronHandler();
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
          '当其他群成员 @你（机器人）时，消息内容中会出现 <@你的BotOPENID> 标签，这代表该消息是 @给你的。机器人自己的 OPENID 将在连接建立后告知。',
          '你可以在回复中使用 <@OPENID> 格式来 @提及特定的群成员。',
          '例如：回复 "<@ABC123DEF456> 你好" 会在群里 @该成员。',
        );
      }
      parts.push(
        '',
        '## 关于机器人消息',
        '',
        '消息前缀 [bot] 表示该消息来自另一个机器人。是否回复由你自主判断。',
      );
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

  async sendMessage(chatId: string, text: string): Promise<void> {
    // <noreply> suppression
    if (text.trim() === '<noreply>') {
      process.stderr.write(
        `[QQ:${this.name}] <noreply> skipped for ${sanitizeLogText(chatId, 64)}\n`,
      );
      return;
    }

    const route = await this.resolveRoute(chatId);
    if (!route) return;

    // Look up reply context with TTL check
    const entry = this.replyMsgId.get(chatId);
    const msgId =
      entry && Date.now() - entry.timestamp < QQChannel.REPLY_MSG_ID_TTL_MS
        ? entry.msgId
        : undefined;
    if (entry && !msgId) {
      process.stderr.write(
        `[QQ:${this.name}] replyMsgId entry expired for ${sanitizeLogText(chatId, 64)}, reply context expired, sending without msg_id\n`,
      );
      this.msgSeqMap.delete(entry.msgId);
      this.replyMsgId.delete(chatId);
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
        'RATE_LIMITED',
        `Active messages disabled for ${sanitizeLogText(chatId, 64)}`,
      );
    }

    let nextSeq = 0;
    let rollbackApplied = false;
    try {
      // Try markdown first (msg_type: 2)
      const body: Record<string, unknown> = {
        msg_type: 2,
        markdown: { content: text },
      };
      nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
      if (msgId) {
        this.msgSeqMap.set(msgId, nextSeq);
        body['msg_id'] = msgId;
        body['msg_seq'] = nextSeq;
      }

      const resp = await sendQQMessage(
        route.base,
        route.path,
        this.accessToken,
        body,
      );

      if (!resp.ok) {
        // Always consume response body to prevent undici resource leak
        const errBody = sanitizeLogText(await resp.text().catch(() => ''), 200);
        // Log diagnostic info for non-429 failures
        if (resp.status !== 429) {
          process.stderr.write(
            `[QQ:${this.name}] Send failed (HTTP ${resp.status}: ${errBody})
`,
          );
        }
        // 429 = rate-limited — do not retry, bail immediately
        if (resp.status === 429) {
          process.stderr.write(
            `[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on markdown attempt for ${sanitizeLogText(chatId, 64)}\n`,
          );
          if (msgId) {
            this.msgSeqMap.set(msgId, nextSeq - 1);
            this.saveQQState();
          }
          throw new DeliveryError(
            'RATE_LIMITED',
            `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
          );
        }

        // Active retry when we have a reply context (msgId)
        if (msgId) {
          this.msgSeqMap.set(msgId, nextSeq - 1);
          rollbackApplied = true;
          const activeBody: Record<string, unknown> = {
            content: text,
            msg_type: 0,
            msg_id: msgId,
            msg_seq: nextSeq,
          };
          const activeResp = await sendQQMessage(
            route.base,
            route.path,
            this.accessToken,
            activeBody,
          );

          if (activeResp.ok) {
            process.stderr.write(
              `[QQ:${this.name}] Active retry succeeded for ${sanitizeLogText(chatId, 64)}\n`,
            );
            const current = this.replyMsgId.get(chatId);
            if (current?.msgId === msgId) {
              this.msgSeqMap.set(msgId, nextSeq);
            }
            this.saveQQState();
            await activeResp.text().catch(() => '');
            return;
          }

          process.stderr.write(
            `[QQ:${this.name}] Active retry also failed (HTTP ${activeResp.status}: ${sanitizeLogText(await activeResp.text().catch(() => ''), 200)})\n`,
          );

          if (activeResp.status === 429) {
            process.stderr.write(
              `[QQ:${this.name}] MESSAGE DROPPED: active retry rate-limited (HTTP 429) for ${sanitizeLogText(chatId, 64)}\n`,
            );
            this.saveQQState();
            throw new DeliveryError(
              'RATE_LIMITED',
              `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`,
            );
          }

          // Active retry failed with non-429 — don't fall through to plain-text
          process.stderr.write(
            `[QQ:${this.name}] MESSAGE DROPPED: both passive and active send failed for ${sanitizeLogText(chatId, 64)}\n`,
          );
          this.saveQQState();
          throw new DeliveryError(
            'RETRY_EXHAUSTED',
            `All delivery attempts exhausted for ${sanitizeLogText(chatId, 64)}`,
          );
        }

        // Plain-text fallback for active messages (no reply context)
        const plainBody: Record<string, unknown> = {
          content: text,
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
        return;
      }

      await resp.text().catch(() => '');
      if (msgId) this.saveQQState();
    } catch (e) {
      // Rollback on failure if we haven't already
      if (msgId && !rollbackApplied) {
        this.msgSeqMap.set(msgId, nextSeq - 1);
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
  }

  /**
   * Resolve API routing: handles disposed check, token refresh, chatId validation,
   * sandbox detection, and C2C/group path selection. Returns null if any guard fails.
   */
  private async resolveRoute(
    chatId: string,
  ): Promise<{ base: string; path: string } | null> {
    if (this.disposed) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: channel disposed, dropping message to ${sanitizeLogText(chatId, 64)}
`,
      );
      return null;
    }
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch (_e) {
        process.stderr.write(
          `[QQ:${this.name}] resolveRoute: token refresh failed (${sanitizeLogText(_e instanceof Error ? _e.message : String(_e), 120)}), dropping message to ${sanitizeLogText(chatId, 64)}
`,
        );
        return null;
      }
    }
    if (!this.accessToken) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: accessToken is empty after fetchToken
`,
      );
      return null;
    }
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: invalid chatId rejected (length=${chatId.length})
`,
      );
      return null;
    }
    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const routeType =
      this.chatTypeMap.get(chatId) || this.qqConfig.chatTypes?.[chatId];
    if (routeType !== 'group' && routeType !== 'c2c') {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: no chat type for ${sanitizeLogText(chatId, 64)}, defaulting to C2C\n`,
      );
    }
    const path =
      routeType === 'group'
        ? `/v2/groups/${chatId}/messages`
        : `/v2/users/${chatId}/messages`;
    return { base, path };
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
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.msgSeqMap.clear();
    this.botOpenIdByGroup.clear();
    this.groupActiveMsgEnabled.clear();
    this.seenMessages.clear();
    this.crossEventDedup.clear();
    this.coldStart = true;
    if (this._inCronFlow > 0) {
      process.stderr.write(
        '[qqbot] resetRoutingState: orphaned cron flow (depth=' +
          this._inCronFlow +
          ') during disconnect',
      );
    }
    this._inCronFlow = 0;
    for (const [, state] of this.streamState) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.streamState.clear();
    this.flushingSessions.clear();
    this.pendingStreamDelete.clear();
    this.flushedSessions.clear();
  }

  /**
   * QQ Bot API V2 does not provide a typing indicator endpoint.
   * ChannelBase calls these hooks to signal prompt start/end;
   * they are intentionally no-ops for this channel.
   */
  protected override onPromptStart(
    _chatId: string,
    _sessionId: string,
    _messageId?: string,
  ): void {}

  protected override onPromptEnd(
    _chatId: string,
    _sessionId: string,
    _messageId?: string,
  ): void {}

  // ── Streaming (idle-flush with per-session buffers) ────────────

  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    sessionId: string,
  ): void {
    if (this.blockStreaming) return;
    let state = this.streamState.get(sessionId);
    if (!state) {
      state = { chatId, buffer: chunk, timer: null, retryCount: 0 } as {
        chatId: string;
        buffer: string;
        timer: ReturnType<typeof setTimeout> | null;
        retryCount: number;
      };
      this.streamState.set(sessionId, state);
    } else {
      state.buffer += chunk;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      // Flush immediately when buffer exceeds max to prevent unbounded growth
      if (
        state.buffer.length >=
        (this.qqConfig.bufferFlushLength ?? QQChannel.MAX_BUFFER_LENGTH)
      ) {
        const buf = state.buffer;
        state.buffer = '';
        this.flushAndTrack(sessionId, buf, state, 'idleFlush');
        return;
      }
    }
    const reconnectId = this._reconnectId;
    state.timer = setTimeout(() => {
      this.idleFlush(sessionId, reconnectId);
    }, QQChannel.IDLE_FLUSH_MS);
    state.timer.unref?.();
  }

  private idleFlush(sessionId: string, reconnectId: number): void {
    if (this._reconnectId !== reconnectId) {
      process.stderr.write(
        `[QQ:${this.name}] idleFlush discarded (reconnect) session=${sanitizeLogText(sessionId, 32)}\n`,
      );
      return;
    }
    const state = this.streamState.get(sessionId);
    if (!state || !state.buffer) return;
    if (this.flushingSessions.has(sessionId)) {
      // Another send is in-flight — re-schedule idle timer so we retry later
      if (!state.timer) {
        const retryReconnectId = this._reconnectId;
        state.timer = setTimeout(() => {
          this.idleFlush(sessionId, retryReconnectId);
        }, QQChannel.IDLE_FLUSH_MS);
        state.timer.unref?.();
      }
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
    state: {
      chatId: string;
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
      retryCount: number;
    },
    logLabel: string,
  ): void {
    this.flushingSessions.add(sessionId);
    // sendMessage throws DeliveryError for delivery failures. Only
    // RETRY_EXHAUSTED is definitive — RATE_LIMITED and FALLBACK_FAILED
    // are transient and fall through to re-buffer/retry.
    this.sendMessage(state.chatId, buffer)
      .then(() => {
        // #3: Guard — if session died during in-flight send, touch nothing
        const current = this.streamState.get(sessionId);
        if (current !== state) return;
        current.retryCount = 0;
        this.flushedSessions.add(sessionId);

        if (this.pendingStreamDelete.has(sessionId)) {
          this.pendingStreamDelete.delete(sessionId);
          // #2: Flush immediately — idle timer would add unnecessary delay
          const s = this.streamState.get(sessionId);
          if (s === state && s.buffer) {
            // Don't clear buffer or retryCount — idleFlush will pick them up.
            this.idleFlush(sessionId, this._reconnectId);
            // Don't return — let .finally() clear flushingSessions
            // so deferred idleFlush can proceed.
          }
        }

        // #8: Clean up streamState only if no content arrived during send
        const s = this.streamState.get(sessionId);
        if (s === state && !s.buffer) {
          this.streamState.delete(sessionId);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DeliveryError && e.code === 'RETRY_EXHAUSTED') {
          process.stderr.write(
            `[QQ:${this.name}] ${logLabel} delivery failed (${e.code}): ${sanitizeLogText(e.message, 200)}\n`,
          );
          // RETRY_EXHAUSTED = permanent failure (retries exhausted at QQ
          // or upstream layers). Don't retry — just clean up state.
          const current = this.streamState.get(sessionId);
          if (current === state) {
            current.retryCount = 0;
            if (!current.buffer) {
              this.streamState.delete(sessionId);
            }
          }
          if (this.pendingStreamDelete.has(sessionId)) {
            this.pendingStreamDelete.delete(sessionId);
            this.flushedSessions.delete(sessionId);
          }
          return;
        }

        process.stderr.write(
          `[QQ:${this.name}] ${logLabel} send failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
        // #1: Never undo previously-succeeded flush records on failure

        if (this.pendingStreamDelete.has(sessionId)) {
          // Session is ending - retry up to MAX_FLUSH_RETRIES
          this.pendingStreamDelete.delete(sessionId);
          const current = this.streamState.get(sessionId);
          if (current === state) {
            current.buffer = buffer;
            current.retryCount++;
            if (current.retryCount < QQChannel.MAX_FLUSH_RETRIES) {
              const reconnectId = this._reconnectId;
              const delay =
                current.retryCount > 1
                  ? QQChannel.IDLE_FLUSH_BACKOFF_MS
                  : QQChannel.IDLE_FLUSH_MS;
              current.timer = setTimeout(() => {
                this.idleFlush(sessionId, reconnectId);
              }, delay);
              current.timer.unref?.();
            } else {
              this.streamState.delete(sessionId);
              // #2: Clean up flushedSessions on retry exhaustion
              this.flushedSessions.delete(sessionId);
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
            // #3: If re-buffer exceeds max length, flush immediately
            if (
              current.buffer.length >=
              (this.qqConfig.bufferFlushLength ?? QQChannel.MAX_BUFFER_LENGTH)
            ) {
              this.idleFlush(sessionId, this._reconnectId);
              // Don't return — let .finally() clear flushingSessions.
              // Skip retry scheduling: idleFlush handles it.
            } else {
              current.retryCount++;
              if (current.retryCount < QQChannel.MAX_FLUSH_RETRIES) {
                if (!current.timer) {
                  const reconnectId = this._reconnectId;
                  const delay =
                    current.retryCount > 1
                      ? QQChannel.IDLE_FLUSH_BACKOFF_MS
                      : QQChannel.IDLE_FLUSH_MS;
                  current.timer = setTimeout(() => {
                    this.idleFlush(sessionId, reconnectId);
                  }, delay);
                  current.timer.unref?.();
                }
              } else {
                this.streamState.delete(sessionId);
                // #2: Clean up flushedSessions on retry exhaustion
                this.flushedSessions.delete(sessionId);
                process.stderr.write(
                  `[QQ:${this.name}] ${logLabel} retries exhausted for ${sanitizeLogText(sessionId, 64)}\n`,
                );
              }
            }
          }
        }
      })
      .finally(() => {
        // #1: Identity guard — only delete if no new state replaced us
        const current = this.streamState.get(sessionId);
        if (!current || current === state) {
          this.flushingSessions.delete(sessionId);
        }
      });
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

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    sessionId: string,
  ): Promise<void> {
    const state = this.streamState.get(sessionId);
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
    const remaining = state?.buffer ?? (wasFlushed ? '' : fullText);
    this.streamState.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    if (remaining) {
      await super.onResponseComplete(chatId, remaining, sessionId);
    }
  }

  override onSessionDied(sessionId: string): void {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
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
          `[QQ:${this.name}] saveQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
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
        `[QQ:${this.name}] flushQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
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
      }
      if (raw.replyMsgId) {
        const arr = raw.replyMsgId as Array<[string, unknown]>;
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
                    Number.isFinite(o['timestamp'])
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
      }
      if (raw.msgSeqMap) {
        const arr = raw.msgSeqMap as Array<[string, unknown]>;
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
      }
      if (raw.groupActiveMsgEnabled) {
        const arr = raw.groupActiveMsgEnabled as Array<[string, unknown]>;
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
      }
      if (raw.botOpenIdByGroup) {
        const arr = raw.botOpenIdByGroup as Array<[string, unknown]>;
        this.botOpenIdByGroup = new Map(
          Array.isArray(arr)
            ? arr.filter(
                ([k, v]) =>
                  typeof k === 'string' &&
                  k.length <= 256 &&
                  typeof v === 'string' &&
                  /^[A-F0-9]{32}$/i.test(v),
              )
            : [],
        ) as Map<string, string>;
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
        `[QQ:${this.name}] backupGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
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
        `[QQ:${this.name}] restoreGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
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
        `[QQ:${this.name}] fixRestoredSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`,
      );
    }
  }

  // ── ReplyMsgId helpers ────────────────────────────────────────

  /**
   * Set replyMsgId for a chat, cleaning up the previous entry's msgSeqMap
   * to prevent orphaned entries accumulating over time.
   */
  private setReplyMsgId(chatId: string, msgId: string): void {
    const oldEntry = this.replyMsgId.get(chatId);
    if (oldEntry && oldEntry.msgId !== msgId) {
      this.msgSeqMap.delete(oldEntry.msgId);
    }
    this.replyMsgId.set(chatId, { msgId, timestamp: Date.now() });
    this.saveQQState();
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
      for (const [chatId, entry] of this.replyMsgId) {
        if (entry.timestamp < cutoff) {
          this.msgSeqMap.delete(entry.msgId);
          this.replyMsgId.delete(chatId);
          dirty = true;
        }
      }
      if (dirty) this.saveQQState();
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
            `[QQ:${this.name}] Token refresh failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, will retry
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
                `[QQ:${this.name}] FATAL: token refresh exhausted, reconnecting
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
                  `[QQ:${this.name}] Token refresh retry failed (attempt ${retryCount}): ${sanitizeLogText(e2 instanceof Error ? e2.message : String(e2), 200)}
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

      const shouldReconnect =
        this.serverRequestedReconnect ||
        (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts);

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
        this.reconnectAttempts++;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
        process.stderr.write(
          `[QQ:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})\n`,
        );
        if (!this.isReconnecting) {
          this.reconnectTimer = setTimeout(
            () => this.reconnectWithRetry(),
            delay,
          );
          this.reconnectTimer.unref();
        }
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
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
            this.restoreQQState();
            this.router
              .restoreSessions()
              .then(() => {
                this.fixRestoredSessions();
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
                this._ready = true;
                this.coldStart = false;
                this.attachCronHandler();
                onReady();
              })
              .catch(() => {
                this._ready = true;
                this.coldStart = false;
                this.attachCronHandler();
                onReady();
              });
          } else {
            process.stderr.write(
              `[QQ:${this.name}] Ready (warm reconnect, skipping state restore)\n`,
            );
            this._ready = true;
            this.attachCronHandler();
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
          this.handleGroupMsgReject(msg['d'] as unknown as GroupMsgToggleEvent);
        } else if (t === 'GROUP_MSG_RECEIVE') {
          this.handleGroupMsgReceive(
            msg['d'] as unknown as GroupMsgToggleEvent,
          );
        } else if (t === 'RESUMED') {
          // RESUME success — the process did NOT restart, all in-memory
          // session state, QQ routing state, and global sessions.json are
          // still intact. Calling restoreSessions() would drop and re-attach
          // every session, aborting in-flight LLM prompts.
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.connectReject = null;
          this._ready = true;
          this.startHeartbeat();
          this.attachCronHandler();
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
      this.qqConfig.groupAllPolicy === 'all';
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

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      process.stderr.write(
        `[QQ:${this.name}] RC: reconnect attempts exhausted, giving up\n`,
      );
      this.isReconnecting = false;
      return;
    }

    const maxGwRetries = 5;
    for (let attempt = 0; attempt < maxGwRetries; attempt++) {
      if (this.disposed) return;
      try {
        try {
          await this.fetchToken();
        } catch {
          process.stderr.write(
            `[QQ:${this.name}] RC: token refresh failed, retrying...
`,
          );
          await this.sleep(2000);
          if (this.disposed) return;
          continue;
        }
        await this.connectGateway();
        return;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const backoff = Math.min(1000 * 2 ** (attempt + 1), 30000);
        process.stderr.write(
          `[QQ:${this.name}] RC: ${sanitizeLogText(msg, 200)} (retry in ${backoff}ms, attempt ${attempt + 1}/${maxGwRetries})\n`,
        );
        if (attempt < maxGwRetries - 1) await this.sleep(backoff);
      }
    }
    process.stderr.write(
      `[QQ:${this.name}] RC: exhausted ${maxGwRetries} reconnect retries, will retry in 60s\n`,
    );
    this.reconnectAttempts++;
    this.tryResume = false;
    this.isReconnecting = false;
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
    if (!/^[A-F0-9]{32}$/i.test(botOpenId)) {
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
        for (const [key, ts] of this.crossEventDedup) {
          if (ts < cutoff) this.crossEventDedup.delete(key);
        }
        if (this.seenMessages.size === 0 && this.crossEventDedup.size === 0) {
          clearInterval(this.seenCleanupTimer!);
          this.seenCleanupTimer = null;
        }
      }, 60_000).unref();
    }
    return false;
  }
  /**
   * Check if a message was already processed via a different event type
   * (e.g., GROUP_AT_MESSAGE_CREATE + GROUP_MESSAGE_CREATE for the same message).
   * Note: QQ guarantees these events are mutually exclusive per-group
   * (groupAllPolicy determines which event type fires), so this dedup is
   * a safety net, not a normal code path. Keyed on event.id since the
   * same underlying message has the same event.id across both event types.
   */
  private isCrossEventDuplicate(
    chatId: string,
    event: QQGroupMessageEvent,
  ): boolean {
    const key = `${chatId}:${event.id}`;
    const now = Date.now();
    if (this.crossEventDedup.has(key)) return true;
    this.crossEventDedup.set(key, now);
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
    senderOpenId: string;
    botTag: string;
    cleanText: string;
    openIdSuffix: string;
    text: string;
    senderName: string;
  } | null {
    const senderName =
      event.author?.username ||
      event.author?.id ||
      event.author?.member_openid ||
      'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const senderOpenId =
      event.author?.member_openid || event.author?.user_openid || '';

    const content = (event.content || '').trim();
    const cleanText = content.replace(/<@[^>]{1,64}>/g, '').trim();
    if (!cleanText) return null;

    const isAtBot = event.mentions?.some((m) => m.is_you) ?? false;

    // Extract bot's own OPENID from mentions (per-group)
    if (isAtBot && !this.botOpenIdByGroup.has(chatId)) {
      this.extractBotOpenId(event.mentions, chatId);
    }

    const effectiveIsAtBot = forceAtMention ?? isAtBot;

    const isSlash = effectiveIsAtBot && cleanText.startsWith('/');

    // Deliberately NOT hard-blocking bot messages — QQ Bot API may deliver
    // self-echoes or other bot messages. Instead, tag with [bot] prefix so the
    // model can judge relevance and decide whether to respond. Hard-blocking
    // would prevent intentional bot-to-bot interactions that the operator
    // explicitly configures. The [bot] prefix gives the model enough context
    // to ignore irrelevant bot traffic.
    const isBot = event.author?.bot === true;
    const botTag = isBot ? '[bot] ' : '';
    // NOTE: Both callers (handleGroup, handleGroupAll) guard against bot
    // messages before reaching prepareGroupMessage, so isBot is always false
    // and botTag always '' here. The code is retained as defense-in-depth
    // in case a future caller skips the guard.

    const groupBotOpenId = this.botOpenIdByGroup.get(chatId);
    const openIdSuffix = groupBotOpenId ? ` [botOpenId:${groupBotOpenId}]` : '';
    const suffixFromBotOpenId = groupBotOpenId
      ? `\n机器人 OPENID: ${groupBotOpenId}`
      : '';
    const text = isSlash
      ? sanitizePromptText(cleanText)
      : `[atMention=${effectiveIsAtBot}]${openIdSuffix} ${botTag}[${safeName}${senderOpenId ? `(${senderOpenId.slice(0, 8)}\u2026)` : ''}]: ${sanitizePromptText(this.qqConfig.allowMention !== false ? content : cleanText)}${suffixFromBotOpenId}`;

    return {
      isAtBot: effectiveIsAtBot,
      isSlash,
      safeName,
      senderOpenId,
      botTag,
      cleanText,
      openIdSuffix,
      text,
      senderName,
    };
  }

  private handleC2C(event: QQMessageEvent): void {
    if (this.isDuplicate(event.id)) return;
    if (!event.content?.trim()) return;
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
    this.chatTypeMap.set(chatId, 'c2c');
    this.setReplyMsgId(chatId, event.id);
    const senderName = event.author.username || event.author.id || 'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const cleanText = event.content.trim();
    const isSlash = cleanText.startsWith('/');
    const text = isSlash
      ? sanitizePromptText(cleanText)
      : `[atMention=true] [${safeName}]: ${sanitizePromptText(cleanText)}`;
    this.handleInbound({
      channelName: this.name,
      senderId: chatId,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: false,
      isMentioned: true,
      isReplyToBot: false,
      ...(isSlash ? {} : { alreadyPrefixed: true as const }),
    }).catch((e) =>
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
    const { isSlash, text, senderName, safeName, cleanText } = result;

    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(cleanText.split(/\s/)[0], 64)}\n`,
      );
    }

    // GROUP_AT_MESSAGE_CREATE always has finalIsAtBot=true, so @-bot
    // messages are always delivered. Log when active messages are disabled.
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroup: active messages disabled but @-bot allowed through (passive)\n`,
      );
    }

    // Deduplicate before handleInbound — prepareGroupMessage already ran
    // so side effects (extractBotOpenId) are applied regardless of dedup.
    // Also check cross-event dedup: GROUP_MESSAGE_CREATE may also fire for the same message.
    if (this.isDuplicate(event.id) || this.isCrossEventDuplicate(chatId, event))
      return;
    const senderId =
      event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(
        `[QQ:${this.name}] Group message dropped: no senderId for author\n`,
      );
      return;
    }
    this.setReplyMsgId(chatId, event.id);
    this.handleInbound({
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: true,
      isMentioned: true,
      isReplyToBot: true,
      ...(isSlash ? {} : { alreadyPrefixed: true as const }),
    }).catch((e) =>
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
    const chatId = event.group_openid;
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, 'group');
    if (isNewGroup) this.saveQQState();

    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: missing author\n`,
      );
      return;
    }
    if (event.author.bot) {
      process.stderr.write(
        `[QQ:${this.name}] Bot message dropped in group ${sanitizeLogText(chatId, 64)}\n`,
      );
      return;
    }

    const result = this.prepareGroupMessage(event, chatId);
    if (!result) return;
    const { isSlash, text, senderName, isAtBot, safeName, cleanText } = result;

    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(cleanText.split(/\s/)[0], 64)}\n`,
      );
    }

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
              const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`, 'i');
            });
        }
        if (this._keywordTriggerCache.length === 0) {
          process.stderr.write(
            `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy — no keywords configured, message from ${sanitizeLogText(senderName, 64)} not forwarded\n`,
          );
          return;
        }
        const keywordText = (event.content || '')
          .replace(/<@[^>]{1,64}>/g, '')
          .trim()
          .toLowerCase()
          .normalize('NFC');
        const matched = this._keywordTriggerCache.some((re) =>
          re.test(keywordText),
        );
        if (!matched) {
          process.stderr.write(
            `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy — no match for message from ${sanitizeLogText(senderName, 64)}\n`,
          );
          return;
        }
      }
    } else if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll: @-bot message allowed through (passive) despite active messages disabled for ${sanitizeLogText(chatId, 64)}\n`,
      );
    }

    // Dedup after policy check: QQ guarantees GROUP_MESSAGE_CREATE and
    // GROUP_AT_MESSAGE_CREATE are mutually exclusive per-group based on
    // full-message access setting, so cross-event dedup is a safety net.
    // isDuplicate handles reconnect replay protection (same event.id).
    if (this.isDuplicate(event.id) || this.isCrossEventDuplicate(chatId, event))
      return;

    const senderId =
      event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: no senderId for author\n`,
      );
      return;
    }
    // Set replyMsgId for all messages that pass the policy gate,
    // not just @-bot ones. This ensures keyword-triggered non-@
    // messages get proper msg_id referencing in bot replies.
    this.setReplyMsgId(chatId, event.id);
    this.handleInbound({
      channelName: this.name,
      chatId,
      text,
      senderId,
      senderName,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      ...(isSlash ? {} : { alreadyPrefixed: true as const }),
    }).catch((e) => {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      );
    });
  }

  // ── Group management events ────────────────────────────────────

  private handleGroupAddRobot(event: GroupAddRobotEvent): void {
    const groupId = event.group_openid;
    if (!groupId) return;
    this.chatTypeMap.set(groupId, 'group');
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Added to group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}\n`,
    );
  }

  private handleGroupDelRobot(event: GroupDelRobotEvent): void {
    const groupId = event.group_openid;
    if (!groupId) return;
    this.chatTypeMap.delete(groupId);
    this.groupActiveMsgEnabled.delete(groupId);
    // msgSeqMap is keyed by message ID, not group_openid — get the
    // message ID from replyMsgId before deleting the reply entry.
    const replyEntry = this.replyMsgId.get(groupId);
    if (replyEntry) this.msgSeqMap.delete(replyEntry.msgId);
    this.replyMsgId.delete(groupId);
    this.botOpenIdByGroup.delete(groupId);
    // Clean up active streamState sessions targeting this group.
    // Cancel pending idle-flush timers before deleting entries so
    // setTimeout callbacks don't fire and attempt to send to the
    // removed group.
    let cleanedStreams = 0;
    for (const [sid, state] of this.streamState) {
      if (state.chatId === groupId) {
        if (state.timer) clearTimeout(state.timer);
        this.flushingSessions.delete(sid);
        this.pendingStreamDelete.delete(sid);
        this.flushedSessions.delete(sid);
        this.streamState.delete(sid);
        cleanedStreams++;
      }
    }
    // Clean up cron buffers targeting this group (always, regardless of config flag)
    let cleanedCron = 0;
    for (const [sid, entry] of this.cronBuffer) {
      const target = this.router.getTarget(sid);
      if (target?.chatId === groupId) {
        if (entry.timer) clearTimeout(entry.timer);
        this.cronBuffer.delete(sid);
        cleanedCron++;
      }
    }
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Removed from group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}, cleaned ${cleanedStreams} stream(s) and ${cleanedCron} cron buffer(s)\n`,
    );
  }

  private handleGroupMsgReject(event: GroupMsgToggleEvent): void {
    if (!event.group_openid) {
      process.stderr.write(
        `[QQ:${this.name}] Group msg toggle dropped: missing group_openid\n`,
      );
      return;
    }
    this.groupActiveMsgEnabled.set(event.group_openid, false);
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Active msg disabled for group ${sanitizeLogText(event.group_openid, 64)}\n`,
    );
  }

  private handleGroupMsgReceive(event: GroupMsgToggleEvent): void {
    if (!event.group_openid) {
      process.stderr.write(
        `[QQ:${this.name}] Group msg toggle dropped: missing group_openid\n`,
      );
      return;
    }
    this.groupActiveMsgEnabled.set(event.group_openid, true);
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Active msg enabled for group ${sanitizeLogText(event.group_openid, 64)}\n`,
    );
  }
}
