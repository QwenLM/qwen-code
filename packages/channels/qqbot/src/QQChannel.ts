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

/** Validate chatId to prevent SSRF when constructing URLs. */
export function isValidChatId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
}

/**
 * Detect whether text contains markdown syntax (for msg_type selection).
 *
 * The list-item patterns `^[-*+]\s` and `^\d+\.\s` trade precision for recall:
 * text like "- temperature: 5°C" or "1. first thing" will trigger markdown
 * mode. Sending non-markdown as msg_type=2 (markdown) is harmless — QQ renders
 * it as plain text — so false positives are safe. False negatives (missing
 * markdown in msg_type=0) would strip formatting, so we bias toward markdown.
 */
export function hasLinkSyntax(text: string): boolean {
  const open = text.indexOf('[');
  if (open === -1) return false;
  const mid = text.indexOf('](', open + 1);
  if (mid === -1) return false;
  return text.indexOf(')', mid + 2) !== -1;
}

export function hasMarkdownSyntax(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||
    text.includes('```') ||
    /\*\*|__|~~/.test(text) ||
    /`[^`]+`/.test(text) ||
    hasLinkSyntax(text) ||
    /^[-*+]\s/m.test(text) ||
    /^\d+\.\s/m.test(text)
  );
}

/**
 * Split long text into QQ-compatible chunks (max 2000 chars each).
 *
 * Uses UTF-16 code-unit length — in the extremely rare case that the
 * 2000-unit boundary falls in the middle of a surrogate pair (emoji),
 * that character will be garbled. QQ chat messages rarely approach
 * this limit at a boundary that aligns with a high-codepoint character.
 */
export function splitText(text: string): string[] {
  const MAX = 2000;
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX) {
    chunks.push(text.slice(i, i + MAX));
  }
  return chunks;
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
  /** Timestamp of last received HEARTBEAT_ACK, for zombie-connection detection. */
  private lastHeartbeatAck: number = 0;
  /** Debounce timer for saveQQState to avoid blocking event loop. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** beforeExit hook to flush state when the event loop drains naturally. Does NOT fire for SIGKILL, OOM kills, or uncaughtException. */
  private beforeExitHook: (() => void) | null = null;
  /** Timer for reconnectWithRetry fallback (unref'd so it doesn't block exit). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against parallel reconnectWithRetry chains from stale close events. */
  private isReconnecting: boolean = false;

  /** Track whether a chatId is a group or C2C for correct API routing. */
  private chatTypeMap: Map<string, 'c2c' | 'group'> = new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  private replyMsgId: Map<string, string> = new Map();
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();

  // ── Group / cron fields ────────────────────────────────────────

  /** Per-group bot OPENID map for multi-group support. */
  private botOpenIdByGroup: Map<string, string> = new Map();
  /** Guard: set to true after first READY + session restore completes. */
  private _ready: boolean = false;
  /** Whether this process has never received READY (cold start). */
  private coldStart: boolean = true;
  /** Track per-group active message permission. */
  private groupActiveMsgEnabled: Map<string, boolean> = new Map();
  /** Lazy cache for filtered, lowercased keyword triggers. */
  private _keywordTriggerCache: string[] | null = null;

  /** Accumulation buffer for cron/non-prompt textChunk events. */
  private cronBuffer: Map<
    string,
    { buffer: string; timer: ReturnType<typeof setTimeout> | null }
  > = new Map();
  /** Retry count per session for cron buffer flush. */
  private cronRetryCount: Map<string, number> = new Map();
  private static readonly MAX_CRON_RETRIES = 3;

  /** Named handler for permanent textChunk listener (cron/non-prompt). */
  private _cronTextHandler: ((sessionId: string, text: string) => void) | null =
    null;
  /** Tracks whether _cronTextHandler is registered on bridge. */
  /** Gate: only set during cron-scheduled message flows. Prevents
     phantom cronBuffer entries when textChunk fires during normal
     bridge.prompt() calls (ChannelBase has its own listener there). */
  private _inCronFlow: boolean = false;
  private cronTextHandlerAttached: boolean = false;

  /** Path to persisted QQ routing state: chatTypeMap, replyMsgId, msgSeqMap. */
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
        setImmediate(() => {
          if (!this._ready) return;
          if (!this._inCronFlow) return;
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
          entry.timer = setTimeout(() => {
            const toFlush = entry!.buffer;
            entry!.buffer = '';
            entry!.timer = null;
            if (toFlush) {
              const target = this.router.getTarget(sessionId);
              if (target) {
                this.sendMessage(target.chatId, toFlush)
                  .then(() => {
                    this.cronRetryCount.delete(sessionId);
                    if (!entry!.buffer) this.cronBuffer.delete(sessionId);
                  })
                  .catch((err) => {
                    process.stderr.write(
                      `[QQ:${this.name}] Cron flush send error: ${err}\n`,
                    );
                    const retries =
                      (this.cronRetryCount.get(sessionId) ?? 0) + 1;
                    this.cronRetryCount.set(sessionId, retries);
                    if (retries >= QQChannel.MAX_CRON_RETRIES) {
                      process.stderr.write(
                        `[QQ:${this.name}] Cron flush exhausted retries (${QQChannel.MAX_CRON_RETRIES}) for ${sessionId}, discarding\n`,
                      );
                      this.cronRetryCount.delete(sessionId);
                      this.cronBuffer.delete(sessionId);
                      return;
                    }
                    entry!.buffer = toFlush + (entry!.buffer || '');
                    if (this.cronBuffer.get(sessionId) !== entry) {
                      this.cronBuffer.set(sessionId, entry!);
                    }
                    setTimeout(() => {
                      this._cronTextHandler?.(sessionId, '');
                    }, 2000);
                  });
                return;
              }
            }
            this.cronBuffer.delete(sessionId);
          }, 2000);
        });
      };
      this.attachCronHandler();
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
    this.disposed = false;
    if (!this.config.instructions) {
      this.config.instructions = [
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
        '',
        '## @提及格式',
        '',
        '消息内容中的 <@OPENID> 标签代表群成员的 QQ 标识。',
        '当其他群成员 @你（机器人）时，消息内容中会出现 <@你的BotOPENID> 标签，这代表该消息是 @给你的。机器人自己的 OPENID 将在连接建立后告知。',
        '你可以在回复中使用 <@OPENID> 格式来 @提及特定的群成员。',
        '例如：回复 "<@ABC123DEF456> 你好" 会在群里 @该成员。',
        '',
        '## 关于机器人消息',
        '',
        '消息前缀 [bot] 表示该消息来自另一个机器人。是否回复由你自主判断。',
      ].join('\n');
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
    if (text.trim() === '<noreply>') {
      process.stderr.write(
        `[QQ:${this.name}] <noreply> skipped for ${chatId}\n`,
      );
      return;
    }
    // ── Normal text / markdown flow ──────────────────────────
    const route = await this.resolveRoute(chatId);
    if (!route) return;

    const msgId = this.replyMsgId.get(chatId);
    const useMarkdown = hasMarkdownSyntax(text);
    // Respect QQ Bot active-message toggle: when a group admin disables
    // active messages, drop outbound sends silently to avoid platform-policy
    // violations. Only applies to active sends (no msgId — passive replies
    // to @-bot messages must still be delivered.
    if (!msgId && this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] sendMessage blocked: active messages disabled for ${chatId}\n`,
      );
      return;
    }

    for (const chunk of splitText(text)) {
      try {
        const body: Record<string, unknown> = useMarkdown
          ? { msg_type: 2, markdown: { content: chunk } }
          : { content: chunk, msg_type: 0 };
        const nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
        if (msgId) {
          body['msg_id'] = msgId;
          body['msg_seq'] = nextSeq;
        }

        let resp = await sendQQMessage(
          route.base,
          route.path,
          this.accessToken,
          body,
        );

        if (!resp.ok && useMarkdown) {
          const errBody = await resp.text().catch(() => '');
          process.stderr.write(
            `[QQ:${this.name}] Markdown rejected (HTTP ${resp.status}: ${sanitizeLogText(errBody, 200)}), retrying as plain text\n`,
          );
          const plainBody: Record<string, unknown> = {
            content: chunk,
            msg_type: 0,
          };
          if (msgId) {
            plainBody['msg_id'] = msgId;
            plainBody['msg_seq'] = nextSeq;
          }
          resp = await sendQQMessage(
            route.base,
            route.path,
            this.accessToken,
            plainBody,
          );
        }

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          process.stderr.write(
            `[QQ:${this.name}] Send HTTP ${resp.status} (msg_seq=${body['msg_seq'] ?? '-'}): ${sanitizeLogText(errBody, 200)}\n`,
          );
          break;
        }
        if (msgId) this.msgSeqMap.set(msgId, nextSeq);
      } catch (e) {
        process.stderr.write(
          `[QQ:${this.name}] Send error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
        );
        break;
      }
    }
    if (msgId) this.saveQQState();
  }

  /**
   * Resolve API routing: handles disposed check, token refresh, chatId validation,
   * sandbox detection, and C2C/group path selection. Returns null if any guard fails.
   */
  private async resolveRoute(
    chatId: string,
  ): Promise<{ base: string; path: string } | null> {
    if (this.disposed) return null;
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch {
        return null;
      }
    }
    if (!this.accessToken || !isValidChatId(chatId)) return null;
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean up cron buffers
    if (this.qqConfig['cron-msg-experimental']) {
      for (const [, entry] of this.cronBuffer) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      this.cronBuffer.clear();
    }
    this.cronRetryCount.clear();
    if (this.beforeExitHook) {
      process.off('beforeExit', this.beforeExitHook);
      this.beforeExitHook = null;
    }
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
    this.detachCronHandler();
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.msgSeqMap.clear();
    this.botOpenIdByGroup.clear();
    this.seenMessages.clear();
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
    const tmpPath = this.qqStatePath + '.tmp';
    this.saveTimer = setTimeout(() => {
      if (this.disposed) return;
      try {
        writeFileSync(tmpPath, this.serializeQQState(), { mode: 0o600 });
        renameSync(tmpPath, this.qqStatePath);
      } catch (e) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
        process.stderr.write(
          `[QQ:${this.name}] saveQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
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
  /** Flush pending state writes immediately (called on disconnect). */
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
        /* best-effort */
      }
      process.stderr.write(
        `[QQ:${this.name}] flushQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      );
    }
  }

  /**
   * Restore QQ routing state from disk.
   * Validates and filters every entry on restore — corrupt or unexpected
   * entries (e.g. unknown chat types, oversized replyMsgIds, negative seqs)
   * are silently dropped so they don't propagate into runtime routing.
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
      if (raw.chatTypeMap && Array.isArray(raw.chatTypeMap)) {
        const rawCT = raw.chatTypeMap as Array<[string, unknown]>;
        // Validate: only accept 'c2c' | 'group' values
        this.chatTypeMap = new Map(
          rawCT.filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k.length <= 256 &&
              (v === 'c2c' || v === 'group'),
          ),
        ) as Map<string, 'c2c' | 'group'>;
        const dropped = rawCT.length - this.chatTypeMap.size;
        if (dropped > 0)
          process.stderr.write(
            `[QQ:${this.name}] Dropped ${dropped} invalid chatTypeMap entries during restore\n`,
          );
      }
      if (raw.replyMsgId && Array.isArray(raw.replyMsgId)) {
        const rawRM = raw.replyMsgId as Array<[string, unknown]>;
        // Validate: entries must be strings ≤ 128 chars
        this.replyMsgId = new Map(
          rawRM.filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k.length <= 256 &&
              typeof v === 'string' &&
              v.length <= 128,
          ),
        ) as Map<string, string>;
        const dropped = rawRM.length - this.replyMsgId.size;
        if (dropped > 0)
          process.stderr.write(
            `[QQ:${this.name}] Dropped ${dropped} invalid replyMsgId entries during restore\n`,
          );
      }
      if (raw.msgSeqMap && Array.isArray(raw.msgSeqMap)) {
        const rawMS = raw.msgSeqMap as Array<[string, unknown]>;
        // Validate: entries must be non-negative safe integers
        this.msgSeqMap = new Map(
          rawMS.filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k.length <= 256 &&
              typeof v === 'number' &&
              Number.isSafeInteger(v) &&
              v >= 0,
          ),
        ) as Map<string, number>;
        const dropped = rawMS.length - this.msgSeqMap.size;
        if (dropped > 0)
          process.stderr.write(
            `[QQ:${this.name}] Dropped ${dropped} invalid msgSeqMap entries during restore\n`,
          );
      }
      if (raw.groupActiveMsgEnabled && Array.isArray(raw.groupActiveMsgEnabled)) {
        const rawGA = raw.groupActiveMsgEnabled as Array<[string, unknown]>;
        this.groupActiveMsgEnabled = new Map(
          rawGA.filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k.length <= 256 &&
              typeof v === 'boolean',
          ),
        ) as Map<string, boolean>;
        const dropped = rawGA.length - this.groupActiveMsgEnabled.size;
        if (dropped > 0)
          process.stderr.write(
            `[QQ:${this.name}] Dropped ${dropped} invalid groupActiveMsgEnabled entries during restore\n`,
          );
      }
      if (raw.botOpenIdByGroup && Array.isArray(raw.botOpenIdByGroup)) {
        const rawBO = raw.botOpenIdByGroup as Array<[string, unknown]>;
        this.botOpenIdByGroup = new Map(
          rawBO.filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k.length <= 256 &&
              typeof v === 'string' &&
              /^[A-F0-9]{32}$/i.test(v),
          ),
        ) as Map<string, string>;
        const dropped = rawBO.length - this.botOpenIdByGroup.size;
        if (dropped > 0)
          process.stderr.write(
            `[QQ:${this.name}] Dropped ${dropped} invalid botOpenIdByGroup entries during restore\n`,
          );
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
    } catch {
      /* best-effort */
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
    } catch {
      /* best-effort */
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
    } catch {
      /* best-effort */
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
    const delay = Math.max(Math.min(ttl * 0.8, ttl - 60_000), 60_000);
    if (delay > 0) {
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          if (this.disposed) return;
          process.stderr.write(
            `[QQ:${this.name}] Token refresh failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, retrying in 60s\n`,
          );
          this.scheduleTokenRefreshRetry();
        });
      }, delay);
    }
  }

  private scheduleTokenRefreshRetry(): void {
    if (this.disposed) return;
    this.stopTokenRefresh();
    this.tokenRefreshTimer = setTimeout(() => {
      this.fetchToken().catch((e) => {
        if (this.disposed) return;
        process.stderr.write(
          `[QQ:${this.name}] Token refresh failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, retrying in 60s\n`,
        );
        this.scheduleTokenRefreshRetry();
      });
    }, 60_000);
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
    let gatewayAttempted = false;
    for (let attempt = 0; attempt < maxGwRetries; attempt++) {
      try {
        try {
          await this.fetchToken();
        } catch {
          process.stderr.write(
            `[QQ:${this.name}] RC: token refresh failed, retrying...\n`,
          );
          await this.sleep(2000);
          continue;
        }
        gatewayAttempted = true;
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
    if (gatewayAttempted) this.reconnectAttempts++;
    this.tryResume = false;
    this.isReconnecting = false;
    this.reconnectTimer = setTimeout(() => this.reconnectWithRetry(), 60000);
    this.reconnectTimer.unref();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Message Handlers ───────────────────────────────────────────
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
        const cutoff = Date.now() - 300_000;
        for (const [id, ts] of this.seenMessages) {
          if (ts < cutoff) this.seenMessages.delete(id);
        }
        if (this.seenMessages.size === 0) {
          clearInterval(this.seenCleanupTimer!);
          this.seenCleanupTimer = null;
        }
      }, 60_000);
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
  ): {
    isAtBot: boolean;
    isSlash: boolean;
    safeName: string;
    text: string;
    senderName: string;
  } | null {
    const senderName =
      event.author?.username ||
      event.author?.id ||
      event.author?.member_openid ||
      'QQ User';
    const safeName = sanitizeSenderName(senderName);

    const content = (event.content || '').trim();
    const cleanText = content.replace(/<@[^>]{1,64}>/g, '').trim();
    if (!cleanText) return null;

    const isAtBot = event.mentions?.some((m) => m.is_you) ?? false;

    if (isAtBot && !this.botOpenIdByGroup.has(chatId)) {
      this.extractBotOpenId(event.mentions, chatId);
    }

    const isSlash = isAtBot && cleanText.startsWith('/');

    if (isSlash) {
      const loggedCmd = sanitizeLogText(cleanText, 80);
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${safeName} (${chatId}): ${loggedCmd}\n`,
      );
    }

    const groupBotOpenId = this.botOpenIdByGroup.get(chatId);
    const openIdSuffix = groupBotOpenId ? ` [botOpenId:${groupBotOpenId}]` : '';
    const text = isSlash
      ? sanitizePromptText(cleanText)
      : `[atMention=${isAtBot}]${openIdSuffix} [${safeName}]: ${sanitizePromptText(this.qqConfig.allowMention !== false ? content : cleanText)}`;

    return { isAtBot, isSlash, safeName, text, senderName };
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
    const chatId = event.author.user_openid || event.author.id;
    if (!chatId) {
      process.stderr.write(
        `[QQ:${this.name}] C2C message dropped: no chatId for author\n`,
      );
      return;
    }
    this.chatTypeMap.set(chatId, 'c2c');
    this.replyMsgId.set(chatId, event.id);
    this.saveQQState();
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
      process.stderr.write(`[QQ:${this.name}] C2C handler error: ${e}\n`),
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
    if (event.author.bot) return;
    const chatId = event.group_openid;
    this.chatTypeMap.set(chatId, 'group');

    // Deduplicate after prepareGroupMessage so side effects
    // (extractBotOpenId) always run, even for replayed duplicates.
    // Only skip handleInbound on duplicates — this prevents silent
    // drops when GROUP_MESSAGE_CREATE fires before GROUP_AT_MESSAGE_CREATE
    // for the same message.

    const result = this.prepareGroupMessage(event, chatId);
    if (!result) return;
    const { isAtBot, isSlash, text, senderName } = result;

    // GROUP_AT_MESSAGE_CREATE only fires when the bot IS @mentioned, so
    // finalIsAtBot is unconditionally true. If isAtBot (from mentions array)
    // was false due to a platform-side mention detection quirk, still treat
    // it as @-bot to prevent silent message drops.
    if (!isAtBot) {
      process.stderr.write(
        `[QQ:${this.name}] GROUP_AT_MESSAGE_CREATE with isAtBot=false, forcing true (event type guarantees @-bot)\n`,
      );
    }
    const finalIsAtBot = true;

    // Fix the text template: replace [atMention=false] with [atMention=true]
    // since the event type guarantees the message was @-bot.
    const correctedText = !isAtBot
      ? text.replace('[atMention=false]', '[atMention=true]')
      : text;

    // GROUP_AT_MESSAGE_CREATE always has finalIsAtBot=true, so @-bot
    // messages are always delivered. Log when active messages are disabled.
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroup: active messages disabled but @-bot allowed through (passive)\n`,
      );
    }

    // Deduplicate before handleInbound — prepareGroupMessage already ran
    // so side effects (extractBotOpenId) are applied regardless of dedup.
    if (this.isDuplicate(event.id)) return;
    this.replyMsgId.set(chatId, event.id);
    this.saveQQState();
    this.handleInbound({
      channelName: this.name,
      senderId:
        event.author.id ||
        event.author.user_openid ||
        event.author.member_openid ||
        'unknown',
      senderName,
      chatId,
      text: correctedText,
      messageId: event.id,
      isGroup: true,
      isMentioned: finalIsAtBot,
      isReplyToBot: finalIsAtBot,
      ...(isSlash ? {} : { alreadyPrefixed: true as const }),
    }).catch((e) =>
      process.stderr.write(
        `[QQ:${this.name}] Group handler error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}\n`,
      ),
    );
  }
  private handleGroupAll(event: QQGroupMessageEvent): void {
    if (!event.group_openid) return;
    const chatId = event.group_openid;
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, 'group');
    if (isNewGroup) this.saveQQState();

    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(
        `[QQ:${this.name}] handleGroupAll blocked: active messages disabled for ${sanitizeLogText(chatId, 64)}\n`,
      );
      return;
    }

    if (!event.author) {
      process.stderr.write(
        `[QQ:${this.name}] Group all-message dropped: missing author\n`,
      );
      return;
    }
    if (event.author.bot) return;

    const rawPolicy = this.qqConfig.groupAllPolicy;
    const policy =
      rawPolicy === 'keyword' || rawPolicy === 'all' ? rawPolicy : 'log';

    if (policy === 'log') {
      const senderName =
        event.author?.username ||
        event.author?.id ||
        event.author?.member_openid ||
        'unknown';
      process.stderr.write(
        `[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: log policy — message from ${sanitizeLogText(senderName, 64)} not forwarded\n`,
      );
      return;
    }

    if (this.isDuplicate(event.id)) return;

    const result = this.prepareGroupMessage(event, chatId);
    if (!result) return;
    const { isSlash, text, senderName, isAtBot } = result;

    if (isAtBot) {
      this.replyMsgId.set(chatId, event.id);
      this.saveQQState();
    }

    if (policy === 'keyword') {
      if (!this._keywordTriggerCache) {
        this._keywordTriggerCache = (this.qqConfig.keywordTriggers ?? [])
          .filter((kw) => kw.length > 0)
          .map((kw) => kw.toLowerCase().normalize('NFC'));
      }
      if (this._keywordTriggerCache.length === 0) return;
      const cleanText = (event.content || '')
        .replace(/<@[^>]{1,64}>/g, '')
        .trim()
        .toLowerCase()
        .normalize('NFC');
      const matched = this._keywordTriggerCache.some((kw) =>
        cleanText.includes(kw),
      );
      if (!matched) return;
    }

    this.handleInbound({
      channelName: this.name,
      chatId,
      text,
      senderId:
        event.author.id ||
        event.author.user_openid ||
        event.author.member_openid ||
        'unknown',
      senderName,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      ...(isSlash ? {} : { alreadyPrefixed: true as const }),
    }).catch((e) => {
      process.stderr.write(`[QQ:${this.name}] handleGroupAll error: ${e}\n`);
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
    if (replyEntry) this.msgSeqMap.delete(replyEntry);
    this.replyMsgId.delete(groupId);
    this.botOpenIdByGroup.delete(groupId);
    // Clean up cron buffers targeting this group
    if (this.qqConfig['cron-msg-experimental']) {
      for (const [sid, entry] of this.cronBuffer) {
        const target = this.router.getTarget(sid);
        if (target?.chatId === groupId) {
          if (entry.timer) clearTimeout(entry.timer);
          this.cronBuffer.delete(sid);
        }
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
}
