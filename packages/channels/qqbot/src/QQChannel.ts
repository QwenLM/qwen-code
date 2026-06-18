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
import { qrConnect } from '@tencent-connect/qqbot-connector';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OpCode, Intent } from './types.js';
import type {
  QQChannelConfig,
  QQMessageEvent,
  QQGroupMessageEvent,
} from './types.js';

/** Validate chatId to prevent SSRF when constructing URLs. */
function isValidChatId(id: string): boolean {
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
  /** Timestamp of last received HEARTBEAT_ACK, for zombie-connection detection. */
  private lastHeartbeatAck: number = 0;
  /** Debounce timer for saveQQState to avoid blocking event loop. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch {
        process.stderr.write(
          `[QQ:${this.name}] Send skipped: token expired and refresh failed\n`,
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

    const base = this.qqConfig.sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com';

    const isGroup = this.chatTypeMap.get(chatId) === 'group';
    const path = isGroup
      ? `/v2/groups/${chatId}/messages`
      : `/v2/users/${chatId}/messages`;

    // Capture msgId at send-time to avoid race on replyMsgId
    const msgId = this.replyMsgId.get(chatId);

    for (const chunk of this.splitText(text)) {
      try {
        const body: Record<string, unknown> = {
          content: chunk,
          msg_type: 0,
        };
        // Multi-block streaming: set msg_id + incrementing msg_seq
        // seq incremented before send so we can track the next value
        const nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
        if (msgId) {
          body['msg_id'] = msgId;
          body['msg_seq'] = nextSeq;
        }

        const resp = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${this.accessToken}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });

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

  disconnect(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.stopTokenRefresh();
    if (this.seenCleanupTimer) {
      clearInterval(this.seenCleanupTimer);
      this.seenCleanupTimer = null;
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
    } catch {
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
   * ACP LoadSessionResponse has no sessionId field, so bridge.loadSession()
   * returns undefined. SessionRouter.restoreSessions() stores undefined
   * in its maps, which breaks session resolution. Fix by reading the
   * correct sessionIds from the persisted sessions.json.
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
    const credsFile = join(
      getGlobalQwenDir(),
      'channels',
      `${safeName}-credentials.json`,
    );
    let appID = this.qqConfig.appID;
    let appSecret = this.qqConfig.appSecret;

    // Try load from persisted credentials file first
    if ((!appID || !appSecret) && existsSync(credsFile)) {
      try {
        const saved = JSON.parse(readFileSync(credsFile, 'utf-8'));
        appID = saved.appId;
        appSecret = saved.appSecret;
        this.qqConfig.appID = appID;
        this.qqConfig.appSecret = appSecret;
      } catch {
        /* corrupt file, fall through */
      }
    }

    // If no credentials, launch QR code login
    if (!appID || !appSecret) {
      process.stderr.write(
        `[QQ:${this.name}] No credentials, scan QR code with QQ...\n`,
      );
      const [creds] = await qrConnect();
      appID = creds.appId;
      appSecret = creds.appSecret;
      this.qqConfig.appID = appID;
      this.qqConfig.appSecret = appSecret;
      // Persist to disk with restrictive permissions (mode: 0o600 avoids TOCTOU)
      try {
        const dir = join(getGlobalQwenDir(), 'channels');
        mkdirSync(dir, { recursive: true });
        writeFileSync(credsFile, JSON.stringify({ appId: appID, appSecret }), {
          mode: 0o600,
        });
      } catch {
        /* non-fatal */
      }
    }

    const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `QQ Bot token request failed (HTTP ${resp.status}): ${body}`,
      );
    }

    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error('QQ Bot token response missing access_token');
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    this.scheduleTokenRefresh();
  }

  private scheduleTokenRefresh(): void {
    this.stopTokenRefresh();
    const ttl = Math.max(0, this.tokenExpiresAt - Date.now());
    // Refresh at 80% of TTL, minimum 60s before expiry
    const delay = Math.max(Math.min(ttl * 0.8, ttl - 60_000), 60_000);
    if (delay > 0) {
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          process.stderr.write(
            `[QQ:${this.name}] Token refresh failed: ${e}, retrying in 60s\n`,
          );
          this.tokenRefreshTimer = setTimeout(
            () => this.scheduleTokenRefresh(),
            60_000,
          );
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
    const gw = this.qqConfig.sandbox
      ? 'https://sandbox.api.sgroup.qq.com/gateway'
      : 'https://api.sgroup.qq.com/gateway';

    const resp = await fetch(gw, {
      headers: { Authorization: `QQBot ${this.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
    }

    const data = (await resp.json()) as { url?: string };
    if (!data['url']) {
      throw new Error('QQ Bot gateway response missing WebSocket URL');
    }

    return new Promise<void>((resolve, reject) => {
      this.connectReject = reject;
      this.dialGateway(data['url']!, resolve, reject);
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
      } catch {
        // Ignore malformed messages
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

      if (shouldReconnect) {
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
        this.heartbeatInterval =
          ((msg['d'] as Record<string, unknown> | undefined)?.[
            'heartbeat_interval'
          ] as number) || 45000;
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
          // RESUME success — d is empty string, sessionId already stored from READY
          this.reconnectAttempts = 0;
          this.connectReject = null;
          this.startHeartbeat();
          this.router
            .restoreSessions()
            .then(() => {
              this.fixRestoredSessions();
              onReady();
            })
            .catch(() => onReady());
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
        this.tryResume = false; // RESUME failed, fall back to IDENTIFY
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
    setTimeout(() => this.reconnectWithRetry(), 60000);
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
    const cleanText = (event.content || '').replace(/<@!\d+>/g, '').trim();
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
      isReplyToBot: false,
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
