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
} from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  AcpBridge,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OpCode, Intent, FileType } from './types.js';
import type {
  QQChannelConfig,
  QQMessageEvent,
  QQGroupMessageEvent,
  ArkKV,
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
  uploadQQMedia,
} from './api.js';

/** Validate chatId to prevent SSRF when constructing URLs. */
function isValidChatId(id: string): boolean {
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
function hasMarkdownSyntax(text: string): boolean {
  return /^#{1,6}\s|`{3}|\*\*|__|~~|`[^`]+`|\[.+\]\(.+\)|^[-*+]\s|^\d+\.\s/m.test(
    text,
  );
}

/**
 * Parse !ark(template_id, key=val, …) syntax from LLM text.
 * Returns null if the text doesn't start with !ark(.
 */
function parseArkCommand(
  text: string,
): { templateId: number; kv: ArkKV[] } | null {
  const m = text.match(/^!ark\((\d+),\s*(.+)\)$/s);
  if (!m) return null;
  const templateId = parseInt(m[1]!, 10);
  const kv: ArkKV[] = [];
  // Split on commas, but respect quoted values and parentheses nesting
  const pairs = m[2]!.match(/(?:[^,"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim();
    const value = p
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    kv.push({ key, value });
  }
  return { templateId, kv };
}

/**
 * Parse !media(type, url, [caption]) syntax from LLM text.
 * Returns null if the text doesn't start with !media(.
 */
function parseMediaCommand(
  text: string,
): { fileType: number; url: string; caption?: string } | null {
  const m = text.match(/^!media\((\w+),\s*([^,\n]+?)(?:,\s*(.+))?\)$/s);
  if (!m) return null;
  const typeMap: Record<string, number> = {
    image: 1,
    img: 1,
    picture: 1,
    photo: 1,
    图片: 1,
    video: 2,
    视频: 2,
    voice: 3,
    audio: 3,
    语音: 3,
    音频: 3,
    file: 4,
    doc: 4,
    document: 4,
    文件: 4,
  };
  const fileType = typeMap[m[1]!.toLowerCase()];
  if (!fileType) return null;
  return {
    fileType,
    url: m[2]!.trim(),
    caption: m[3]?.trim() || undefined,
  };
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
  /** Timer for reconnectWithRetry fallback (unref'd so it doesn't block exit). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Track whether a chatId is a group or C2C for correct API routing. */
  private chatTypeMap: Map<string, 'c2c' | 'group'> = new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  private replyMsgId: Map<string, string> = new Map();
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();

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
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    const safeName = name.replace(/[^A-Za-z0-9_-]/g, '_');
    const stateDir = join(getGlobalQwenDir(), 'channels');
    mkdirSync(stateDir, { recursive: true });
    const sessionsPath = join(stateDir, `${safeName}-sessions.json`);

    const router =
      options?.router ??
      new SessionRouter(bridge, config.cwd, config.sessionScope, sessionsPath);

    super(name, config, bridge, { ...options, router });
    this.qqConfig = config as unknown as QQChannelConfig;
    this.qqStatePath = join(stateDir, `${safeName}-state.json`);
    this.globalSessionsPath = join(stateDir, 'sessions.json');
    this.sessionsBackupPath = join(
      stateDir,
      `${safeName}-sessions-backup.json`,
    );
  }

  // ── ChannelBase interface ──────────────────────────────────────

  async connect(): Promise<void> {
    this.disposed = false;
    if (!this.config.instructions) {
      this.config.instructions = [
        '## QQ Bot Channel',
        '',
        '你是通过 QQ Bot 与用户对话的 AI 助手。',
        '回复控制在 2000 字符以内（超长会自动分块），支持 Markdown 格式。',
        '',
        '### 富卡片消息（Ark 模板）',
        '如需发送结构化内容（带图/链接的卡片），在回复中用以下语法：',
        '  !ark(模板ID, 变量名=值, ...)',
        '模板ID:',
        '  23 — 链接+文本列表（适合多条目+跳转）',
        '  24 — 文字+缩略图（适合带图摘要）',
        '  37 — 大图（适合海报/封面）',
        '变量名以 # 开头，例如 `#TITLE#=标题`, `#META_URL#=https://...`',
        '',
        '### 图片/视频/语音/文件（Media 富媒体）',
        '如需发送图片、视频、语音或文件，在回复中用：',
        '  !media(类型, 文件URL, [说明文字])',
        '类型: image/picture/photo, video, voice/audio, file/doc',
        '文件URL 必须是公网可访问的链接。file 类型仅支持私聊（群聊会拦截）。',
        '',
        '### 恢复正常文本回复',
        '不需要卡片/媒体时，直接正常回复即可，不要带 !ark 或 !media 前缀。',
      ].join('\n');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.fetchToken();
        await this.connectGateway();
        return;
      } catch (e: unknown) {
        if (attempt < 2) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(
            `[QQ:${this.name}] Connect attempt ${attempt + 1} failed: ${msg}, retrying...\n`,
          );
          await this.sleep(2000);
        } else {
          throw e;
        }
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.disposed) return;

    // ── Route !ark / !media commands from LLM text ───────────
    const arkCmd = parseArkCommand(text.trim());
    if (arkCmd) {
      await this.sendArk(chatId, arkCmd.templateId, arkCmd.kv);
      return;
    }
    const mediaCmd = parseMediaCommand(text.trim());
    if (mediaCmd) {
      await this.sendMedia(
        chatId,
        mediaCmd.fileType,
        mediaCmd.url,
        mediaCmd.caption,
      );
      return;
    }
    // ── Normal text / markdown flow ──────────────────────────

    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch (e: unknown) {
        process.stderr.write(
          `[QQ:${this.name}] Send skipped: token refresh failed — ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return;
      }
    }
    if (!this.accessToken) {
      process.stderr.write(`[QQ:${this.name}] Send skipped: no access token\n`);
      return;
    }

    if (!isValidChatId(chatId)) {
      process.stderr.write(`[QQ:${this.name}] Send skipped: invalid chatId\n`);
      return;
    }

    const base = getApiBase(Boolean(this.qqConfig.sandbox));

    const isGroup = this.chatTypeMap.get(chatId) === 'group';
    const path = isGroup
      ? `/v2/groups/${chatId}/messages`
      : `/v2/users/${chatId}/messages`;

    // Capture msgId at send-time to avoid race on replyMsgId
    const msgId = this.replyMsgId.get(chatId);
    const useMarkdown = hasMarkdownSyntax(text);

    for (const chunk of this.splitText(text)) {
      try {
        const body: Record<string, unknown> = useMarkdown
          ? { msg_type: 2, markdown: { content: chunk } }
          : { content: chunk, msg_type: 0 };
        // Multi-block streaming: set msg_id + incrementing msg_seq
        // seq incremented before send so we can track the next value
        const nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
        if (msgId) {
          body['msg_id'] = msgId;
          body['msg_seq'] = nextSeq;
        }

        let resp = await sendQQMessage(base, path, this.accessToken, body);

        // Markdown is a fully available, zero-permission message type on the QQ
        // Bot Open Platform — bot.q.qq.com API docs list msg_type=2 alongside
        // text/ark/embed with no application gate. (q.qq.com/wiki/FAQ/robot
        // mentions a markdown permission application, but that FAQ targets a
        // different platform — likely older 群机器人 or mini-program bots —
        // not the Open Platform API we use here.) We retry as plaintext as
        // defense-in-depth against edge cases where a bot's markdown capability
        // might be restricted server-side.
        if (!resp.ok && useMarkdown) {
          const errBody = await resp.text().catch(() => '');
          process.stderr.write(
            `[QQ:${this.name}] Markdown rejected (HTTP ${resp.status}: ${errBody.slice(0, 100)}), retrying as plain text\n`,
          );
          const plainBody: Record<string, unknown> = {
            content: chunk,
            msg_type: 0,
          };
          if (msgId) {
            plainBody['msg_id'] = msgId;
            plainBody['msg_seq'] = nextSeq;
          }
          resp = await sendQQMessage(base, path, this.accessToken, plainBody);
        }

        if (!resp.ok) {
          // Drain response body to avoid socket leak
          const errBody = await resp.text().catch(() => '');
          process.stderr.write(
            `[QQ:${this.name}] Send HTTP ${resp.status} (msg_seq=${body['msg_seq'] ?? '-'}): ${errBody.slice(0, 200)}\n`,
          );
          break; // stop sending on failure to avoid msg_seq gaps
        }
        // Only persist seq on success
        if (msgId) this.msgSeqMap.set(msgId, nextSeq);
      } catch (e) {
        process.stderr.write(`[QQ:${this.name}] Send error: ${e}\n`);
        break;
      }
    }
    // Persist msgSeqMap once after all chunks are sent
    if (msgId) this.saveQQState();
  }

  /**
   * Send an Ark template message (msg_type=3).
   *
   * Ark messages use pre-defined templates with key-value substitution.
   * Three default templates are available:
   *   23 — link + text list
   *   24 — text + thumbnail
   *   37 — large image
   *
   * C2C replies: 60-min window, 5 replies per message.
   * Group replies: 5-min window, 5 replies per message.
   */
  async sendArk(
    chatId: string,
    templateId: number,
    kv: ArkKV[],
  ): Promise<void> {
    if (this.disposed) return;
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch {
        return;
      }
    }
    if (!this.accessToken || !isValidChatId(chatId)) return;

    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const isGroup = this.chatTypeMap.get(chatId) === 'group';
    const path = isGroup
      ? `/v2/groups/${chatId}/messages`
      : `/v2/users/${chatId}/messages`;
    const msgId = this.replyMsgId.get(chatId);

    const body: Record<string, unknown> = {
      msg_type: 3,
      ark: { template_id: templateId, kv },
    };
    if (msgId) body['msg_id'] = msgId;

    const resp = await sendQQMessage(base, path, this.accessToken, body);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      process.stderr.write(
        `[QQ:${this.name}] Ark send HTTP ${resp.status}: ${errBody.slice(0, 200)}\n`,
      );
    }
  }

  /**
   * Upload and send a rich media message (msg_type=7).
   *
   * C2C and group uploads are separate — a file_info from a C2C upload
   * cannot be sent to a group and vice versa. Uploaded files have a TTL
   * (typically 7 days) and must be re-uploaded after expiry.
   *
   * @param fileType — 1=image, 2=video, 3=voice, 4=file
   *   File type 4 (file/document) is C2C-only; group upload rejects it.
   * @param fileUrl — publicly-accessible URL of the media file
   * @param text — optional caption text sent alongside the media
   */
  async sendMedia(
    chatId: string,
    fileType: number,
    fileUrl: string,
    text?: string,
  ): Promise<void> {
    if (this.disposed) return;
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch {
        return;
      }
    }
    if (!this.accessToken || !isValidChatId(chatId)) return;

    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const isGroup = this.chatTypeMap.get(chatId) === 'group';

    // file_type=4 (文件) is rejected by group upload endpoint
    if (isGroup && fileType === FileType.FILE) {
      process.stderr.write(
        `[QQ:${this.name}] Media send skipped: file_type=4 (文件) not supported in group chats\n`,
      );
      return;
    }

    // Upload path: C2C vs group are separate
    const uploadPath = isGroup
      ? `/v2/groups/${chatId}/files`
      : `/v2/users/${chatId}/files`;
    const sendPath = isGroup
      ? `/v2/groups/${chatId}/messages`
      : `/v2/users/${chatId}/messages`;

    try {
      const uploaded = await uploadQQMedia(
        base,
        uploadPath,
        this.accessToken,
        fileType,
        fileUrl,
      );

      const msgId = this.replyMsgId.get(chatId);
      const body: Record<string, unknown> = {
        msg_type: 7,
        media: { file_info: uploaded.file_info },
      };
      if (msgId) body['msg_id'] = msgId;
      if (text) body['content'] = text;

      const resp = await sendQQMessage(base, sendPath, this.accessToken, body);
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        process.stderr.write(
          `[QQ:${this.name}] Media send HTTP ${resp.status}: ${errBody.slice(0, 200)}\n`,
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `[QQ:${this.name}] Media send error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  disconnect(): void {
    this.disposed = true;
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
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.msgSeqMap.clear();
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

  /** Debounced state persistence to avoid blocking event loop. */
  private saveQQState(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        writeFileSync(
          this.qqStatePath,
          JSON.stringify({
            chatTypeMap: Array.from(this.chatTypeMap.entries()),
            replyMsgId: Array.from(this.replyMsgId.entries()),
            msgSeqMap: Array.from(this.msgSeqMap.entries()),
          }),
        );
      } catch {
        /* best-effort */
      }
    }, 500);
  }

  /** Flush pending state writes immediately (called on disconnect). */
  private flushQQState(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeFileSync(
        this.qqStatePath,
        JSON.stringify({
          chatTypeMap: Array.from(this.chatTypeMap.entries()),
          replyMsgId: Array.from(this.replyMsgId.entries()),
          msgSeqMap: Array.from(this.msgSeqMap.entries()),
        }),
      );
    } catch {
      /* best-effort */
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
      if (raw.chatTypeMap) this.chatTypeMap = new Map(raw.chatTypeMap);
      if (raw.replyMsgId) this.replyMsgId = new Map(raw.replyMsgId);
      if (raw.msgSeqMap) this.msgSeqMap = new Map(raw.msgSeqMap);
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
        if (data.trim()) writeFileSync(this.sessionsBackupPath, data);
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
        );
      }
    } catch {
      /* best-effort */
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
      if (!tm || !tt) return;

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
    } catch {
      /* best-effort */
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
    // Refresh at 80% of TTL, minimum 60s before expiry
    const delay = Math.max(Math.min(ttl * 0.8, ttl - 60_000), 60_000);
    if (delay > 0) {
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          if (this.disposed) return;
          process.stderr.write(
            `[QQ:${this.name}] Token refresh failed: ${e}, retrying in 60s\n`,
          );
          // Retry fetchToken directly instead of going through
          // scheduleTokenRefresh (which would add another ~60s of
          // delay from the stale tokenExpiresAt).
          this.tokenRefreshTimer = setTimeout(() => {
            if (this.disposed) return;
            this.fetchToken().catch(() => {
              process.stderr.write(
                `[QQ:${this.name}] Token refresh failed again after retry\n`,
              );
            });
          }, 60_000);
        });
      }, delay);
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
      process.stderr.write(
        `[QQ:${this.name}] WebSocket closed (code=${code})\n`,
      );
      this.stopHeartbeat();
      this.ws = null;

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
        setTimeout(() => this.reconnectWithRetry(), delay);
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
          this.sessionId =
            ((msg['d'] as Record<string, unknown> | undefined)?.[
              'session_id'
            ] as string) || '';
          this.tryResume = true;
          this.connectReject = null;
          this.startHeartbeat();
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
              const sessions =
                all
                  ?.map((e) => `${e.target?.chatId}:${e.sessionId}`)
                  .join(', ') || 'none';
              process.stderr.write(
                `[QQ:${this.name}] Ready (sessions: ${sessions})\n`,
              );
              onReady();
            })
            .catch(() => onReady());
        } else if (t === 'C2C_MESSAGE_CREATE') {
          this.handleC2C(msg['d'] as unknown as QQMessageEvent);
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroup(msg['d'] as unknown as QQGroupMessageEvent);
        } else if (t === 'RESUMED') {
          // RESUME success — the process did NOT restart, all in-memory
          // session state, QQ routing state, and global sessions.json are
          // still intact. Calling restoreSessions() would drop and re-attach
          // every session, aborting in-flight LLM prompts.
          this.reconnectAttempts = 0;
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
    this.ws.send(
      JSON.stringify({
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents: Intent.C2C_MESSAGE | Intent.GROUP_AT_MESSAGE,
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

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      process.stderr.write(
        `[QQ:${this.name}] RC: reconnect attempts exhausted, giving up\n`,
      );
      return;
    }

    const maxGwRetries = 5;
    for (let attempt = 0; attempt < maxGwRetries; attempt++) {
      try {
        // Refresh token before reconnect attempt
        try {
          await this.fetchToken();
        } catch {
          process.stderr.write(
            `[QQ:${this.name}] RC: token refresh failed, retrying...\n`,
          );
          await this.sleep(2000);
          continue;
        }
        await this.connectGateway();
        return; // success
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const backoff = Math.min(1000 * 2 ** (attempt + 1), 30000);
        process.stderr.write(
          `[QQ:${this.name}] RC: ${msg} (retry in ${backoff}ms, attempt ${attempt + 1}/${maxGwRetries})\n`,
        );
        if (attempt < maxGwRetries - 1) await this.sleep(backoff);
      }
    }
    process.stderr.write(
      `[QQ:${this.name}] RC: exhausted ${maxGwRetries} gateway retries, will retry in 60s\n`,
    );
    this.tryResume = false; // fall back to full IDENTIFY next time
    // Schedule another attempt with longer delay
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
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    }
    return false;
  }

  private handleC2C(event: QQMessageEvent): void {
    if (this.isDuplicate(event.id)) return;
    // Ignore messages with no text content (images, stickers, etc.)
    if (!event.content?.trim()) return;
    // user_openid and author.id are scoped differently — falling back to
    // author.id may produce a different identity for the same user across
    // C2C and group contexts, creating two separate sessions. QQ Bot does
    // not expose a unified user identity, so this is unavoidable.
    const chatId = event.author.user_openid || event.author.id;
    this.chatTypeMap.set(chatId, 'c2c');
    this.replyMsgId.set(chatId, event.id);
    this.saveQQState();
    this.handleInbound({
      channelName: this.name,
      senderId: chatId,
      senderName: event.author.username || event.author.id || 'QQ User',
      chatId,
      text: event.content,
      messageId: event.id,
      isGroup: false,
      isMentioned: true,
      isReplyToBot: false,
    }).catch((e) =>
      process.stderr.write(`[QQ:${this.name}] C2C handler error: ${e}\n`),
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
    const chatId = event.group_openid;
    this.chatTypeMap.set(chatId, 'group');
    this.replyMsgId.set(chatId, event.id);
    this.saveQQState();
    const senderName = event.author.username || event.author.id || 'QQ User';
    // Strip @mention tags from message content. QQ Bot API docs state the API
    // cleans these, but the format varies across API versions:
    //   - Legacy: <@!12345> (numeric user ID with bang)
    //   - V2:     <@D5B53C...> (hex openid, no bang)
    // Use a broad pattern to handle both, and any future format changes.
    const cleanText = (event.content || '').replace(/<@[^>]+>/g, '').trim();
    // Ignore messages that have no meaningful text after @mention stripping
    // (pure @mention, image, or sticker messages).
    if (!cleanText) return;
    const isSlash = cleanText.startsWith('/');
    // Log slash commands with senderName for audit trail
    if (isSlash) {
      process.stderr.write(
        `[QQ:${this.name}] Slash cmd from ${senderName} (${chatId}): ${cleanText}\n`,
      );
    }
    // Don't prefix slash commands, keep [senderName] for normal messages
    const text = isSlash ? cleanText : `[${senderName}]: ${cleanText}`;
    this.handleInbound({
      channelName: this.name,
      senderId: event.author.user_openid || event.author.id,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: true,
      isMentioned: true,
      // QQ Bot only receives group messages when explicitly @mentioned, so
      // every group message is semantically a reply to the bot.
      isReplyToBot: true,
    }).catch((e) =>
      process.stderr.write(`[QQ:${this.name}] Group handler error: ${e}\n`),
    );
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Split long text into QQ-compatible chunks (max 2000 chars each).
   *
   * Uses UTF-16 code-unit length — in the extremely rare case that the
   * 2000-unit boundary falls in the middle of a surrogate pair (emoji),
   * that character will be garbled. QQ chat messages rarely approach
   * this limit at a boundary that aligns with a high-codepoint character.
   */
  private splitText(text: string): string[] {
    const MAX = 2000;
    if (text.length <= MAX) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX));
    }
    return chunks;
  }
}
