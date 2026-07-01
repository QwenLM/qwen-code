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
  sanitizeLogText,
  sanitizePromptText,
  sanitizeSenderName,
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
  /** Bot's own QQ OPENID, extracted from the first inbound @mention targeting us. */
  private botOpenId: string = '';
  /** Set to true after first READY + session restore completes. Guards
   *  against stale textChunk events during startup reconnection. */
  private _ready = false;
  /** Whether this connection attempt should try RESUME first. */
  private tryResume: boolean = false;
  private readonly qqConfig: QQChannelConfig;
  /** Set when server sends RECONNECT opcode — close handler uses this to force reconnect. */
  private serverRequestedReconnect: boolean = false;
  /** Pending connect promise reject — called when WebSocket closes before READY. */
  private connectReject: ((err: Error) => void) | null = null;
  /** Timeout that rejects the connect promise if READY is not received in 30s. */
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
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
  /** Timer for reconnectWithRetry fallback (unref'd so it doesn't block exit). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against parallel reconnectWithRetry chains from stale close events. */
  private isReconnecting: boolean = false;
  /** Whether this process has never received READY (cold start vs RESUME fallback). */
  private coldStart: boolean = true;

  /** Named handler for permanent textChunk listener (cron/non-prompt messages). */
  private _cronTextHandler: ((sessionId: string, text: string) => void) | null =
    null;

  /** Track whether a chatId is a group or C2C for correct API routing. */
  private chatTypeMap: Map<string, 'c2c' | 'group'> = new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  private replyMsgId: Map<string, { msgId: string; timestamp: number }> =
    new Map();
  /** Periodic cleanup timer for expired replyMsgId entries. */
  private replyMsgIdCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();
  /** Track per-group active message permission. */
  private groupActiveMsgEnabled: Map<string, boolean> = new Map();

  /** Path to persisted QQ routing state: chatTypeMap, replyMsgId, msgSeqMap. */
  private readonly qqStatePath: string;
  /**
   * Path to the global sessions.json managed by start.ts.
   * start.ts deletes it on shutdown, so we back it up.
   */
  private readonly globalSessionsPath: string;
  /** Backup of sessions.json so conversations survive daemon restarts. */
  private readonly sessionsBackupPath: string;

  // ── Streaming line-buffered output state ──────────────────────
  /**
   * Per-session stream state to prevent concurrent sessions from
   * clobbering each other's buffers. Keyed by sessionId.
   *
   * Entries are cleaned up in onResponseComplete. Cancelled or errored
   * prompts may leak entries — ChannelBase does not expose an onPromptEnd
   * hook that fires in the finally block — but this is acceptable because
   * a leaked entry occupies only ~100 bytes and the overall Map is bounded
   * by the number of active conversations.
   */
  private streamState: Map<
    string,
    {
      chatId: string;
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
    }
  > = new Map();

  /** Accumulation buffer for cron/non-prompt textChunk events. */
  private cronBuffer: Map<
    string,
    { buffer: string; timer: ReturnType<typeof setTimeout> | null }
  > = new Map();

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
    this.qqStatePath = join(stateDir, `${safeName}-state.json`);
    // In standalone mode (no external router), use the per-channel
    // sessions path so the channel owns its own session file instead
    // of sharing global sessions.json with other channels.
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
    // We use setImmediate to let ChannelBase's prompt listener set up
    // streamState first — if streamState has the sessionId, it's a
    // normal prompt and we skip.
    // During session restore (startup), textChunk events from replayed
    // old sessions are silently ignored to prevent stale output.
    this._cronTextHandler = (sessionId: string, text: string) => {
      setImmediate(() => {
        if (!this._ready) return; // during session restore — ignore
        if (this.streamState.has(sessionId)) return; // prompt path handles it

        let entry = this.cronBuffer.get(sessionId);
        if (!entry) {
          entry = { buffer: '', timer: null };
          this.cronBuffer.set(sessionId, entry);
        }

        // Cancel previous idle timer
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }

        // Accumulate
        entry.buffer += text;

        // Set new idle timer (2 seconds, same as streamState)
        entry.timer = setTimeout(() => {
          const toFlush = entry!.buffer;
          entry!.buffer = '';
          entry!.timer = null;
          if (toFlush) {
            const target = this.router.getTarget(sessionId);
            if (target) {
              this.sendMessage(target.chatId, toFlush).catch((err) => {
                process.stderr.write(`[QQ:${this.name}] Cron flush send error: ${err}\n`);
              });
            }
          }
          this.cronBuffer.delete(sessionId);
        }, 2000);
        entry.timer.unref();
      });
    };
    this.bridge.on?.('textChunk', this._cronTextHandler);
  }

  /**
   * Override setBridge to re-attach the permanent `_cronTextHandler`
   * after bridge crash-recovery. ChannelBase.setBridge detaches only
   * toolCall/sessionDied listeners; the cron handler would stay bound
   * to the dead bridge without this override.
   */
  override setBridge(bridge: ChannelAgentBridge): void {
    // Detach from old bridge before swap
    if (this._cronTextHandler) {
      this.bridge.off?.('textChunk', this._cronTextHandler);
    }
    super.setBridge(bridge);
    // Re-attach to new bridge
    if (this._cronTextHandler) {
      bridge.on?.('textChunk', this._cronTextHandler);
    }
  }

  // ── ChannelBase interface ──────────────────────────────────────

  async connect(): Promise<void> {
    this.disposed = false;
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
      if (this.disposed) return;
      try {
        await this.fetchToken();
        await this.connectGateway();
        this.startReplyMsgIdCleanup();
        return;
      } catch (e: unknown) {
        if (attempt < 2) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(
            `[QQ:${this.name}] Connect attempt ${attempt + 1} failed: ${msg}, retrying...\n`,
          );
          await this.sleep(2000);
        } else {
          this.stopTokenRefresh();
          throw e;
        }
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (text.trim() === '<noreply>') {
      // LLM 判断不需要回复——静默跳过。加一行日志方便排查"是不是 bot 挂了"。
      process.stderr.write(
        `[QQ:${this.name}] <noreply> skipped for ${chatId}\n`,
      );
      return;
    }
    const route = await this.resolveRoute(chatId);
    if (!route) return;

    // Respect QQ Bot active-message toggle: when a group admin disables
    // active messages, drop outbound sends silently to avoid platform-policy
    // violations.
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] sendMessage blocked: active messages disabled for ${chatId}\n`,
      );
      return;
    }

    const entry = this.replyMsgId.get(chatId);
    const msgId =
      entry && Date.now() - entry.timestamp < 300_000 ? entry.msgId : undefined;

    let nextSeq = 0;
    try {
      const body: Record<string, unknown> = {
        msg_type: 2,
        markdown: { content: text },
      };
      nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
      if (msgId) this.msgSeqMap.set(msgId, nextSeq);
      if (msgId) {
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
        const errBody = await resp.text().catch(() => '');
        process.stderr.write(
          `[QQ:${this.name}] Markdown rejected (HTTP ${resp.status}: ${errBody.slice(0, 200)})\n`,
        );

        // Passive reply failed (rate-limited 429, expired 400, etc.) —
        // roll back msgSeqMap and retry as active message (no msg_id/msg_seq).
        if (msgId) {
          this.msgSeqMap.set(msgId, nextSeq - 1);
          process.stderr.write(
            `[QQ:${this.name}] Retrying as active message\n`,
          );
          const activeResp = await sendQQMessage(
            route.base,
            route.path,
            this.accessToken,
            { content: text, msg_type: 0 },
          );
          if (activeResp.ok) {
            if (msgId) this.saveQQState();
            return;
          }
          process.stderr.write(
            `[QQ:${this.name}] Active retry also failed (HTTP ${activeResp.status}: ${(await activeResp.text().catch(() => '')).slice(0, 100)})\n`,
          );
          // Active retry failed — don't retry passive plain-text if rate limited
          if (activeResp.status === 429) {
            if (msgId) {
              this.msgSeqMap.set(msgId, nextSeq - 1);
              this.saveQQState();
            }
            return;
          }
        }
        if (msgId) this.saveQQState();
        return;
      }

      if (msgId) this.saveQQState();
    } catch (e) {
      if (msgId) {
        this.msgSeqMap.set(msgId, nextSeq - 1);
        this.saveQQState();
      }
      process.stderr.write(`[QQ:${this.name}] Send error: ${e}\n`);
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
        `[QQ:${this.name}] resolveRoute: channel disposed, dropping message to ${chatId}\n`,
      );
      return null;
    }
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch (_e) {
        process.stderr.write(
          `[QQ:${this.name}] resolveRoute: token refresh failed, dropping message to ${chatId}\n`,
        );
        return null;
      }
    }
    if (!this.accessToken) return null;
    if (!isValidChatId(chatId)) {
      process.stderr.write(
        `[QQ:${this.name}] resolveRoute: invalid chatId rejected (length=${chatId.length})\n`,
      );
      return null;
    }
    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const routeType =
      this.chatTypeMap.get(chatId) || this.qqConfig.chatTypes?.[chatId];
    const path =
      routeType === 'group'
        ? `/v2/groups/${chatId}/messages`
        : `/v2/users/${chatId}/messages`;
    return { base, path };
  }

  disconnect(): void {
    this.disposed = true;
    this._ready = false;
    this.stopHeartbeat();
    this.stopTokenRefresh();
    if (this.seenCleanupTimer) {
      clearInterval(this.seenCleanupTimer);
      this.seenCleanupTimer = null;
    }
    this.stopReplyMsgIdCleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    for (const [, state] of this.streamState) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.streamState.clear();
    // Clean up cron buffers
    for (const [, entry] of this.cronBuffer) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.cronBuffer.clear();
    this.flushQQState();
    this.backupGlobalSessions();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    if (this.connectReject) {
      this.connectReject(new Error('Channel disconnected'));
      this.connectReject = null;
    }
    if (this._cronTextHandler) {
      this.bridge.off?.('textChunk', this._cronTextHandler);
      this._cronTextHandler = null;
    }
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.msgSeqMap.clear();
    this.coldStart = true;
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

  /**
   * Accumulate response text chunks per session. Each session gets its own
   * buffer and idle timer so two concurrent conversations don't clobber each
   * other. Text is flushed on 2 s silence, on tool call, or on completion.
   */
  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    sessionId: string,
  ): void {
    if (this.config.blockStreaming === 'on') return;
    let state = this.streamState.get(sessionId);
    if (!state) {
      state = { chatId, buffer: chunk, timer: null };
      this.streamState.set(sessionId, state);
    } else {
      state.buffer += chunk;
    }
    // Cancel any pending idle timer — new data arrived, restart the silence window.
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // Start a new 2-second silence timer: flush when the model stops sending chunks.
    state.timer = setTimeout(() => {
      state!.timer = null;
      const toFlush = state!.buffer;
      if (!toFlush) return;
      // Clear buffer before send; restore on failure so text is not lost.
      state!.buffer = '';
      this.sendMessage(state!.chatId, toFlush).catch((err) => {
        process.stderr.write(
          `[QQ:${this.name}] idleFlush send failed: ${err}\n`,
        );
        state!.buffer = toFlush + (state!.buffer || '');
      });
    }, 2000);
    state.timer.unref?.();
  }

  /**
   * Send remaining un-flushed text for this session. Uses the per-session
   * buffer (not fullText) because onToolCall may have already sent the
   * pre-tool-call portion.
   */
  protected override async onResponseComplete(
    chatId: string,
    _fullText: string,
    sessionId: string,
  ): Promise<void> {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // ?? not ||: empty-string buffer means already-flushed by idleFlush/onToolCall;
    // || would re-send _fullText (duplicate message).
    const remaining =
      state?.buffer ??
      (() => {
        process.stderr.write(
          `[QQ:${this.name}] onResponseComplete: no streamState for ${sessionId}, sending fullText\n`,
        );
        return _fullText;
      })();
    this.streamState.delete(sessionId);
    if (remaining) {
      await super.onResponseComplete(chatId, remaining, sessionId);
    }
  }

  /**
   * Flush buffered text when a tool call starts, so users see the
   * model's intent text (e.g. "我先来查一下天气") immediately rather
   * than waiting for the tool call to complete.
   */
  override onToolCall(_chatId: string, event: ToolCallEvent): void {
    // Only flush the triggering session
    const state = this.streamState.get(event.sessionId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.buffer) {
      this.sendMessage(state.chatId, state.buffer).catch((err) => {
        process.stderr.write(
          `[QQ:${this.name}] toolCallFlush send failed: ${err}\n`,
        );
      });
      state.buffer = '';
    }
  }

  /**
   * Start periodic cleanup of expired replyMsgId entries.
   * Evicts entries older than 5 minutes every 60 seconds, and cascades
   * to msgSeqMap.
   */
  private startReplyMsgIdCleanup(): void {
    this.stopReplyMsgIdCleanup();
    this.replyMsgIdCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 300_000;
      for (const [chatId, entry] of this.replyMsgId) {
        if (entry.timestamp < cutoff) {
          // Also evict the corresponding msgSeqMap entry so it doesn't
          // grow without bound across weeks of uptime.
          this.msgSeqMap.delete(entry.msgId);
          this.replyMsgId.delete(chatId);
        }
      }
    }, 60_000);
    this.replyMsgIdCleanupTimer.unref();
  }

  private stopReplyMsgIdCleanup(): void {
    if (this.replyMsgIdCleanupTimer) {
      clearInterval(this.replyMsgIdCleanupTimer);
      this.replyMsgIdCleanupTimer = null;
    }
  }

  // ── State Persistence (cross-server context continuation) ──────

  private serializeQQState(): string {
    return JSON.stringify({
      chatTypeMap: Array.from(this.chatTypeMap.entries()),
      replyMsgId: Array.from(this.replyMsgId.entries()),
      msgSeqMap: Array.from(this.msgSeqMap.entries()),
      groupActiveMsgEnabled: Array.from(this.groupActiveMsgEnabled.entries()),
    });
  }

  /** Debounced state persistence. Writes to a temp file then renames for
   * crash-safety — a mid-write crash will not corrupt the real state file. */
  private saveQQState(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const tmpPath = this.qqStatePath + '.tmp';
        writeFileSync(tmpPath, this.serializeQQState(), { mode: 0o600 });
        renameSync(tmpPath, this.qqStatePath);
      } catch (e) {
        process.stderr.write(
          `[QQ:${this.name}] saveQQState write failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }, 500);
    this.saveTimer.unref();
  }

  /** Flush pending state writes immediately (called on disconnect). */
  private flushQQState(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const tmpPath = this.qqStatePath + '.tmp';
      writeFileSync(tmpPath, this.serializeQQState(), { mode: 0o600 });
      renameSync(tmpPath, this.qqStatePath);
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] flushQQState write failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Restore QQ routing state from disk.
   * Trusts persisted JSON — if the file is corrupt, new Map() may create
   * entries with undefined values, causing get()===undefined to fall through
   * to default routing (C2C). This is acceptable for a rare edge case.
   */
  private restoreQQState(): boolean {
    try {
      if (!existsSync(this.qqStatePath)) return false;
      const raw = JSON.parse(readFileSync(this.qqStatePath, 'utf-8'));
      if (raw.chatTypeMap) {
        // Validate: only accept 'c2c' | 'group' values to prevent
        // manipulated state files from injecting invalid routing entries.
        this.chatTypeMap = new Map(
          (raw.chatTypeMap as Array<[string, unknown]>).filter(
            ([, v]) => v === 'c2c' || v === 'group',
          ),
        ) as Map<string, 'c2c' | 'group'>;
      }
      if (raw.replyMsgId) {
        const now = Date.now();
        this.replyMsgId = new Map(
          (raw.replyMsgId as Array<[string, unknown]>)
            .map(
              ([k, v]: [string, unknown]) =>
                typeof v === 'string'
                  ? ([k, { msgId: v, timestamp: now }] as const) // Old format: msgId only
                  : ([k, v] as const), // New format: { msgId, timestamp }
            )
            // Validate new-format entries: must have string msgId and numeric timestamp.
            .filter(([, v]) => {
              if (typeof v !== 'object' || v === null) return false;
              const entry = v as { msgId?: unknown; timestamp?: unknown };
              return (
                typeof entry.msgId === 'string' &&
                typeof entry.timestamp === 'number'
              );
            }),
        ) as Map<string, { msgId: string; timestamp: number }>;
      }
      if (raw.msgSeqMap) {
        // Validate: values must be non-negative numbers.
        this.msgSeqMap = new Map(
          (raw.msgSeqMap as Array<[string, unknown]>).filter(
            ([, v]) => typeof v === 'number' && v >= 0,
          ),
        ) as Map<string, number>;
      }
      if (raw.groupActiveMsgEnabled) {
        // Validate: values must be booleans.
        this.groupActiveMsgEnabled = new Map(
          (raw.groupActiveMsgEnabled as Array<[string, unknown]>).filter(
            ([, v]) => typeof v === 'boolean',
          ),
        ) as Map<string, boolean>;
      }
      return true;
    } catch (e) {
      process.stderr.write(
        `[QQ:${this.name}] Failed to restore QQ state: ${e instanceof Error ? e.message : String(e)}\n`,
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
        `[QQ:${this.name}] backupGlobalSessions failed: ${e instanceof Error ? e.message : String(e)}\n`,
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
        `[QQ:${this.name}] restoreGlobalSessions failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Workaround for SessionRouter.restoreSessions() storing undefined sessionIds
   * when ACP bridge.loadSession() fails to return a session_id.
   *
   * **Fragile**: accesses SessionRouter's private `toSession`/`toTarget`/`toCwd`
   * maps via type coercion. If SessionRouter internals change, this breaks
   * silently. The only signal will be cross-server conversations failing to
   * restore after daemon restart — no crash, no log.
   *
   * If upstream SessionRouter adds a public fix for this, remove this method.
   */
  private fixRestoredSessions(): void {
    try {
      if (!existsSync(this.globalSessionsPath)) return;
      const raw = JSON.parse(readFileSync(this.globalSessionsPath, 'utf-8'));
      const r = this.router as unknown as Record<string, unknown>;
      const tm = r['toSession'] as Map<string, string> | undefined;
      const tt = r['toTarget'] as Map<string, unknown> | undefined;
      const tc = r['toCwd'] as Map<string, string> | undefined;
      if (!tm || !tt) {
        process.stderr.write(
          `[QQ:${this.name}] fixRestoredSessions: SessionRouter internals not found (toSession=${!!tm}, toTarget=${!!tt})\n`,
        );
        return;
      }

      for (const [key, sid] of tm) {
        if (sid) continue;
        const entry = raw[key] as
          | { sessionId?: string; target?: unknown; cwd?: string }
          | undefined;
        if (!entry?.sessionId) continue;
        const correctId: string = entry.sessionId;
        // sid is undefined here — use entry.target directly instead of tt.get(undefined)
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
        `[QQ:${this.name}] fixRestoredSessions failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // ── Token ──────────────────────────────────────────────────────

  private async fetchToken(): Promise<void> {
    const safeName = this.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const credsFile = getCredsFilePath(safeName);

    // Try load persisted credentials first, then fall back to config
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

    // If still no credentials, launch QR code login
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
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          if (this.disposed) return;
          process.stderr.write(
            `[QQ:${this.name}] Token refresh failed: ${e}, will retry\n`,
          );
          // Retry up to 10 times at 60s intervals, then give up.
          // Token refresh failure after 10 attempts (10 min) indicates
          // a persistent issue (revoked credentials, DNS, firewall) that
          // won't resolve by retrying — disconnect and reconnect so the
          // fresh connection re-fetches the token, preventing zombie-state
          // where the WS stays connected but outbound messages are dropped.
          let retryCount = 0;
          const retry = () => {
            if (this.disposed) return;
            if (++retryCount > 10) {
              process.stderr.write(
                `[QQ:${this.name}] FATAL: token refresh exhausted, reconnecting\n`,
              );
              this.isReconnecting = true;
              this.disconnect();
              setTimeout(() => {
                this.isReconnecting = false;
                this.connect().catch((err: unknown) => {
                  process.stderr.write(
                    `[QQ:${this.name}] FATAL: reconnect after token exhaustion failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
                  );
                });
              }, 1000);
              return;
            }
            this.tokenRefreshTimer = setTimeout(() => {
              this.fetchToken().catch((e2) => {
                if (this.disposed) return;
                process.stderr.write(
                  `[QQ:${this.name}] Token refresh retry failed (attempt ${retryCount}): ${e2}\n`,
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
    const dialed = this.ws; // capture for stale-close guard

    // Reject if READY/RESUMED is not received within 30 seconds
    this.readyTimeout = setTimeout(() => {
      if (
        dialed.readyState === WebSocket.OPEN ||
        dialed.readyState === WebSocket.CONNECTING
      ) {
        dialed.close(4002);
        reject(new Error('Timed out waiting for READY'));
      }
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
          `[QQ:${this.name}] Malformed gateway message: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    });

    this.ws.on('close', (code: number) => {
      // Stale-close guard: if a new dialGateway() call has since
      // replaced this.ws, this close event belongs to a dead socket
      // and must not nuke the live connection.
      if (this.ws !== dialed) return;
      process.stderr.write(
        `[QQ:${this.name}] WebSocket closed (code=${code})\n`,
      );
      this.stopHeartbeat();
      this.ws = null;
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }

      const shouldReconnect =
        this.serverRequestedReconnect ||
        (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts);

      this.serverRequestedReconnect = false;

      if (shouldReconnect && this.connectReject) {
        // Pre-READY close: reject so the caller's retry loop retries.
        // connectReject is null after READY; when it's still set,
        // we're waiting for the first READY and must not internal-reconnect
        // (which would create a competing WebSocket and leak the Promise).
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
        } else {
          process.stderr.write(
            `[QQ:${this.name}] Close-handler reconnect skipped (already reconnecting)\n`,
          );
        }
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        process.stderr.write(
          `[QQ:${this.name}] FATAL: reconnect exhausted after ${this.maxReconnectAttempts} attempts. Bot is offline until daemon restart.\n`,
        );
        // Reject pending connect promise if we're not reconnecting
        if (this.connectReject) {
          this.connectReject(
            new Error(
              `WebSocket closed (max reconnect attempts, code=${code})`,
            ),
          );
          this.connectReject = null;
        }
      } else {
        // Reject pending connect promise if we're not reconnecting
        if (this.connectReject) {
          this.connectReject(
            new Error(`WebSocket closed before READY (code=${code})`),
          );
          this.connectReject = null;
        }
      }
    });

    this.ws.on('error', (e: Error) => {
      process.stderr.write(`[QQ:${this.name}] WebSocket error: ${e.message}\n`);
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
          this.sessionId =
            ((msg['d'] as Record<string, unknown> | undefined)?.[
              'session_id'
            ] as string) || '';
          this.tryResume = true;
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
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
                this.connectReject = null;
                this._ready = true;
                this.coldStart = false;
                onReady();
              })
              .catch((err: unknown) => {
                process.stderr.write(
                  `[QQ:${this.name}] restoreSessions failed: ${err instanceof Error ? err.message : String(err)}\n`,
                );
                this.connectReject = null;
                this._ready = true;
                this.coldStart = false;
                onReady();
              });
          } else {
            process.stderr.write(
              `[QQ:${this.name}] Ready (warm reconnect, skipping state restore)\n`,
            );
            this.connectReject = null;
            this._ready = true;
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
    this.ws.send(
      JSON.stringify({
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents:
            Intent.C2C_MESSAGE | Intent.GROUP_AT_MESSAGE | Intent.GROUP_MESSAGE,
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
    // Guard: if the channel was disposed (daemon shutdown) while a reconnect
    // timeout was pending, bail out immediately to avoid an infinite loop.
    if (this.disposed) return;
    // Guard: prevent parallel reconnection chains when multiple close events
    // fire in rapid succession, each scheduling reconnectWithRetry.
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
    let gwCalled = false;
    for (let attempt = 0; attempt < maxGwRetries; attempt++) {
      if (this.disposed) return;
      try {
        // Refresh token before reconnect attempt
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
        gwCalled = true;
        await this.connectGateway();
        this.isReconnecting = false;
        return; // success
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const backoff = Math.min(1000 * 2 ** (attempt + 1), 30000);
        process.stderr.write(
          `[QQ:${this.name}] RC: ${msg} (retry in ${backoff}ms, attempt ${attempt + 1}/${maxGwRetries})\n`,
        );
        if (attempt < maxGwRetries - 1) {
          await this.sleep(backoff);
          if (this.disposed) return;
        }
      }
    }
    process.stderr.write(
      `[QQ:${this.name}] RC: exhausted ${maxGwRetries} gateway retries, will retry in 60s\n`,
    );
    // Only increment when a gateway connection was attempted (not on
    // pure token-refresh failures), so the budget isn't consumed by
    // transient auth issues.
    if (gwCalled) this.reconnectAttempts++;
    this.tryResume = false; // fall back to full IDENTIFY next time
    this.isReconnecting = false; // release guard for future retries
    // Schedule another attempt with longer delay
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
      // Check if previous heartbeat was acknowledged
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

  /**
   * Extract bot's own OPENID from mentions. Finds the self-mention,
   * validates format, writes invalid-format diagnostic to stderr.
   * Returns the validated id or empty string.
   */
  private extractBotOpenId(mentions: QQGroupMessageEvent['mentions']): string {
    const selfMention = mentions?.find((m) => m.is_you);
    if (!selfMention?.id) return '';
    if (!/^[A-F0-9]{32}$/i.test(selfMention.id)) {
      process.stderr.write(
        `[QQ:${this.name}] Invalid botOpenId format: ${selfMention.id}\n`,
      );
      return '';
    }
    this.botOpenId = selfMention.id;
    if (this.qqConfig.allowMention !== false) {
      this.config.instructions += `\n\n机器人 OPENID: ${this.botOpenId}`;
    }
    return this.botOpenId;
  }

  // ── Message Handlers ───────────────────────────────────────────

  /** Check if a message ID was already processed (reconnect replay dedup). */
  private isDuplicate(eventId: string): boolean {
    if (this.seenMessages.has(eventId)) return true;
    const now = Date.now();
    this.seenMessages.set(eventId, now);
    // Evict entries older than 5 minutes
    if (!this.seenCleanupTimer) {
      this.seenCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 300_000;
        for (const [id, ts] of this.seenMessages) {
          if (ts < cutoff) this.seenMessages.delete(id);
        }
        if (this.seenMessages.size === 0) {
          clearInterval(this.seenCleanupTimer!);
          this.seenCleanupTimer = null;
        }
      }, 60_000);
      this.seenCleanupTimer.unref();
    }
    return false;
  }

  private handleC2C(event: QQMessageEvent): void {
    if (this.isDuplicate(event.id)) return;
    // Ignore messages with no text content (images, stickers, etc.)
    if (!event.content?.trim()) return;
    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] C2C message dropped: missing author\n`,
      );
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
    this.replyMsgId.set(chatId, { msgId: event.id, timestamp: Date.now() });
    this.saveQQState();
    const senderName = event.author.username || event.author.id || 'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const cleanText = event.content.trim();
    const isSlash = cleanText.startsWith('/');
    const text = isSlash
      ? cleanText
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
      alreadyPrefixed: !isSlash || undefined,
    }).catch((err: unknown) =>
      process.stderr.write(`[QQ:${this.name}] C2C handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`),
    );
  }

  private handleGroup(event: QQGroupMessageEvent): void {
    if (this.isDuplicate(event.id)) return;
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
    const chatId = event.group_openid;
    this.chatTypeMap.set(chatId, 'group');
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroup blocked: active messages disabled for ${chatId}\n`,
      );
      return;
    }
    const senderName =
      event.author.username ||
      event.author.id ||
      event.author.member_openid ||
      'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const senderOpenId =
      event.author.member_openid || event.author.user_openid || '';
    const cleanText = (event.content || '')
      .replace(/<@[^>]{1,64}>/g, '')
      .trim();
    // Ignore messages that have no meaningful text after @mention stripping
    // (pure @mention, image, or sticker messages).
    if (!cleanText) return;

    // GROUP_AT_MESSAGE_CREATE may fire for @all mentions (not just
    // specifically @bot). Only treat as a slash command when the bot
    // itself is the direct target.
    const isAtBot = event.mentions?.some((m) => m.is_you) ?? false;

    // Extract bot's own OPENID from mentions
    if (isAtBot && !this.botOpenId) {
      this.extractBotOpenId(event.mentions);
    }

    const isSlash = isAtBot && cleanText.startsWith('/');
    const isBot = event.author.bot === true;
    const botTag = isBot ? '[bot] ' : '';

    // Log slash commands with safeName for audit trail
    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(cleanText.split(/\s/)[0], 64)}\n`,
      );
    }

    // Only track replyMsgId for at-bot messages — non-bot @all mentions
    // should not clobber a preceding @mention's replyMsgId.
    if (isAtBot) {
      this.replyMsgId.set(chatId, { msgId: event.id, timestamp: Date.now() });
      this.saveQQState();
    }

    if (!isAtBot) {
      process.stderr.write(
        `[QQ:${this.name}] @all msg in ${sanitizeLogText(chatId, 32)} (isAtBot=false)\n`,
      );
    }

    const text = isSlash
      ? cleanText
      : `[atMention=${isAtBot}] ${botTag}[${safeName}${senderOpenId ? `(${senderOpenId.slice(0, 8)}…)` : ''}]: ${sanitizePromptText(this.qqConfig.allowMention !== false ? (event.content?.trim() ?? '') : cleanText)}`;
    this.handleInbound({
      channelName: this.name,
      senderId:
        event.author.member_openid ||
        event.author.user_openid ||
        event.author.id ||
        'unknown',
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      alreadyPrefixed: !isSlash || undefined,
    }).catch((err: unknown) =>
      process.stderr.write(`[QQ:${this.name}] Group handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`),
    );
  }

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
    for (const [sid, state] of this.streamState) {
      if (state.chatId === groupId) {
        // Cancel the pending idle-flush timer before deleting the entry,
        // otherwise the setTimeout callback will fire and attempt to send
        // to the removed group, creating orphaned API calls.
        if (state.timer) clearTimeout(state.timer);
        this.streamState.delete(sid);
      }
    }
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Removed from group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}\n`,
    );
  }

  private handleGroupMsgReject(event: GroupMsgToggleEvent): void {
    if (!event.group_openid) return;
    this.groupActiveMsgEnabled.set(event.group_openid, false);
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Active msg disabled for group ${sanitizeLogText(event.group_openid, 64)}\n`,
    );
  }

  private handleGroupMsgReceive(event: GroupMsgToggleEvent): void {
    if (!event.group_openid) return;
    this.groupActiveMsgEnabled.set(event.group_openid, true);
    this.saveQQState();
    process.stderr.write(
      `[QQ:${this.name}] Active msg enabled for group ${sanitizeLogText(event.group_openid, 64)}\n`,
    );
  }

  private handleGroupAll(event: QQGroupMessageEvent): void {
    if (!event.group_openid) {
      return;
    }
    const chatId = event.group_openid;
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, 'group');
    if (isNewGroup) this.saveQQState();

    // Deduplicate early — before any side effects beyond chatTypeMap.set
    // to avoid unnecessary state mutations on replayed messages.
    if (this.isDuplicate(event.id)) return;

    // Guard: if the group admin disabled active messages via QQ's
    // permission toggle, drop the inbound message silently. QQ platform
    // policy requires bots to stop processing when active messages are off.
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll blocked: active messages disabled for ${chatId}\n`,
      );
      return;
    }

    // Guard: drop messages without an author (malformed events).
    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: missing author\n`,
      );
      return;
    }
    const isBot = event.author.bot === true;
    const botTag = isBot ? '[bot] ' : '';

    // Validate groupAllPolicy — unknown values default to 'log'.
    // Policy check runs BEFORE content/regex processing to avoid
    // unnecessary work when policy is 'log' (discard all messages).
    const rawPolicy = this.qqConfig.groupAllPolicy;
    const policy =
      rawPolicy === 'keyword' || rawPolicy === 'all' ? rawPolicy : 'log';

    if (policy === 'log') return;

    const content = event.content?.trim() ?? '';
    // Compute cleanText so keyword matching and text construction
    // both use the sanitized content (without <@OPENID> tags).
    const cleanText = content.replace(/<@[^>]{1,64}>/g, '').trim();
    if (!cleanText) return;

    if (policy === 'keyword') {
      const triggers = (this.qqConfig.keywordTriggers ?? []).filter(
        (kw) => kw.length > 0,
      );
      if (triggers.length === 0) return;
      const lower = cleanText.toLowerCase();
      const matched = triggers.some((kw) => lower.includes(kw.toLowerCase()));
      if (!matched) return;
    }

    // policy === 'all' or keyword matched → forward to LLM

    // Group messages use member_openid; username/id are not present.
    const senderName =
      event.author.username ||
      event.author.id ||
      event.author.member_openid ||
      'QQ User';
    const safeName = sanitizeSenderName(senderName);
    const senderOpenId =
      event.author.member_openid || event.author.user_openid || '';

    // 只有 @机器人本人 + 斜杠 才是 slash command
    const isAtBot = event.mentions?.some((m) => m.is_you) ?? false;

    // Extract bot's own OPENID from mentions
    if (isAtBot && !this.botOpenId) {
      this.extractBotOpenId(event.mentions);
    }

    const isSlash = isAtBot && cleanText.startsWith('/');

    // Log slash commands with safeName for audit trail
    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(cleanText.split(/\s/)[0], 64)}\n`,
      );
    }

    // When allowMention is enabled (default), preserve raw <@OPENID> tags so
    // the model can @mention group members. When disabled, strip tags before
    // the content reaches the LLM to prevent prompt-injection-based @mentions.
    const text = isSlash
      ? cleanText
      : `[atMention=${isAtBot}] ${botTag}[${safeName}${senderOpenId ? `(${senderOpenId.slice(0, 8)}…)` : ''}]: ${sanitizePromptText(this.qqConfig.allowMention !== false ? content : cleanText)}`;

    // Only track replyMsgId for at-mention messages — non-@messages should
    // not clobber a preceding @mention's replyMsgId, or the bot's response
    // will be threaded to the wrong message.
    if (isAtBot) {
      this.replyMsgId.set(chatId, { msgId: event.id, timestamp: Date.now() });
      this.saveQQState();
    }

    this.handleInbound({
      channelName: this.name,
      chatId,
      text,
      senderId:
        event.author.member_openid ||
        event.author.user_openid ||
        event.author.id ||
        'unknown',
      senderName,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      alreadyPrefixed: !isSlash || undefined,
    }).catch((err: unknown) => {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    });
  }
}
