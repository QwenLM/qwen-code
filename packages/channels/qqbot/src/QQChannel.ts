/**
 * QQ Bot channel adapter for Qwen Code.
 *
 * Connects QQ Bot via official QQ Bot WebSocket API.
 * Extends ChannelBase for streaming, access control, and session routing.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */

import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  AcpBridge,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
import { qrConnect } from '@tencent-connect/qqbot-connector';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpCode, Intent } from './types.js';
import type { QQChannelConfig, QQMessageEvent, QQGroupMessageEvent } from './types.js';

export class QQChannel extends ChannelBase {
  private ws: WebSocket | null = null;
  private accessToken: string = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: number = 45000;
  private seq: number = 0;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 10;
  private readonly qqConfig: QQChannelConfig;

  /** Track whether a chatId is a group or C2C for correct API routing. */
  private chatTypeMap: Map<string, 'c2c' | 'group'> = new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  private replyMsgId: Map<string, string> = new Map();
  /** msg_seq counter per user messageId, for multi-block streaming. */
  private msgSeqMap: Map<string, number> = new Map();

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.qqConfig = config as unknown as QQChannelConfig;
  }

  // ── ChannelBase interface ──────────────────────────────────────

  async connect(): Promise<void> {
    await this.fetchToken();
    await this.connectGateway();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.accessToken) return;

    const base = this.qqConfig.sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com';

    const isGroup = this.chatTypeMap.get(chatId) === 'group';
    const path = isGroup
      ? `/v2/groups/${chatId}/messages`
      : `/v2/users/${chatId}/messages`;

    for (const chunk of this.splitText(text)) {
      try {
        const body: Record<string, unknown> = {
          content: chunk,
          msg_type: 0,
        };
        // Multi-block streaming: set msg_id + incrementing msg_seq
        const msgId = this.replyMsgId.get(chatId);
        if (msgId) {
          const seq = (this.msgSeqMap.get(msgId) ?? 0) + 1;
          this.msgSeqMap.set(msgId, seq);
          body.msg_id = msgId;
          body.msg_seq = seq;
        }

        const resp = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${this.accessToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          process.stderr.write(
            `[QQ:${this.name}] Send HTTP ${resp.status} (msg_seq=${body.msg_seq ?? '-'})\n`,
          );
        }
      } catch (e) {
        process.stderr.write(`[QQ:${this.name}] Send error: ${e}\n`);
      }
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  // ── Token ──────────────────────────────────────────────────────

  private async fetchToken(): Promise<void> {
    const credsFile = join(
      homedir(),
      '.qwen',
      'channels',
      `${this.name}-credentials.json`,
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
      // Persist to disk
      try {
        mkdirSync(join(homedir(), '.qwen', 'channels'), { recursive: true });
        writeFileSync(credsFile, JSON.stringify({ appId: appID, appSecret }));
      } catch {
        /* non-fatal */
      }
    }

    const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `QQ Bot token request failed (HTTP ${resp.status}): ${body}`,
      );
    }

    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('QQ Bot token response missing access_token');
    }
    this.accessToken = data.access_token;
  }

  // ── WebSocket Gateway ──────────────────────────────────────────

  private async connectGateway(): Promise<void> {
    const gw = this.qqConfig.sandbox
      ? 'https://sandbox.api.sgroup.qq.com/gateway'
      : 'https://api.sgroup.qq.com/gateway';

    const resp = await fetch(gw, {
      headers: { Authorization: `QQBot ${this.accessToken}` },
    });

    if (!resp.ok) {
      throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
    }

    const data = (await resp.json()) as { url?: string };
    if (!data.url) {
      throw new Error('QQ Bot gateway response missing WebSocket URL');
    }

    return new Promise<void>((resolve, reject) => {
      this.dialGateway(data.url!, resolve, reject);
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
      process.stderr.write(`[QQ:${this.name}] WebSocket closed (code=${code})\n`);
      this.stopHeartbeat();
      this.ws = null;

      if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
        process.stderr.write(
          `[QQ:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})\n`,
        );
        setTimeout(() => {
          this.connectGateway().catch((e) =>
            process.stderr.write(`[QQ:${this.name}] Reconnect failed: ${e}\n`),
          );
        }, delay);
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
    const op = msg.op as number;

    switch (op) {
      case OpCode.HELLO: {
        this.heartbeatInterval =
          ((msg.d as Record<string, unknown>)?.heartbeat_interval as number) ||
          45000;
        this.sendIdentify();
        break;
      }
      case OpCode.DISPATCH: {
        const t = msg.t as string;
        const s = msg.s as number | undefined;
        if (s !== undefined) this.seq = s;

        if (t === 'READY') {
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          process.stderr.write(`[QQ:${this.name}] Ready\n`);
          onReady();
        } else if (t === 'C2C_MESSAGE_CREATE') {
          this.handleC2C(msg.d as unknown as QQMessageEvent);
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroup(msg.d as unknown as QQGroupMessageEvent);
        }
        break;
      }
      case OpCode.HEARTBEAT_ACK:
        // Expected, nothing to do
        break;
      case OpCode.RECONNECT:
        this.ws?.close(1000);
        break;
      case OpCode.INVALID_SESSION:
        this.sendIdentify();
        break;
    }
  }

  private sendIdentify(): void {
    if (!this.ws) return;
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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq }));
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Message Handlers ───────────────────────────────────────────

  private handleC2C(event: QQMessageEvent): void {
    const chatId = event.author.user_openid || event.author.id;
    this.chatTypeMap.set(chatId, 'c2c');
    this.replyMsgId.set(chatId, event.id);
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
    const chatId = event.group_openid || event.author.id;
    this.chatTypeMap.set(chatId, 'group');
    this.replyMsgId.set(chatId, event.id);
    // Strip bot @mention prefix from group messages
    const text = (event.content || '').replace(/<@!\d+>/g, '').trim();
    this.handleInbound({
      channelName: this.name,
      senderId: event.author.user_openid || event.author.id,
      senderName: event.author.username || event.author.id || 'QQ User',
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

  /** Split long text into QQ-compatible chunks (max 2000 chars each). */
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
