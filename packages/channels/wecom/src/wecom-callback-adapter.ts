import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  decodeCallbackKey,
  decryptCallback,
  parseCallbackXml,
  verifyCallbackSignature,
} from './wecom-callback-crypto.js';

const MAX_BODY_BYTES = 64 * 1024;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const API_ROOT = 'https://qyapi.weixin.qq.com/cgi-bin/';

export function parseCallbackConfig(config: Readonly<Record<string, unknown>>) {
  const required = (field: string): string => {
    const value = config[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`WeCom Callback requires ${field}`);
    }
    return value.trim();
  };
  const corpId = required('corpId');
  const agentId = required('agentId');
  if (!/^[1-9]\d*$/.test(agentId) || !Number.isSafeInteger(Number(agentId))) {
    throw new Error('WeCom Callback agentId must be a positive integer string');
  }
  const corpSecret = required('corpSecret');
  const token = required('token');
  const key = decodeCallbackKey(required('encodingAESKey'));
  const host = config['webhookHost'] ?? '127.0.0.1';
  const port = config['webhookPort'] ?? 8645;
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('WeCom Callback webhookHost must be a nonempty string');
  }
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      'WeCom Callback webhookPort must be an integer from 1 to 65535',
    );
  }
  return { corpId, agentId, corpSecret, token, key, host, port };
}

function isSingleUser(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    value.toLowerCase() !== '@all' &&
    !/[|\s]/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}

export class WeComCallbackChannel extends ChannelBase {
  private readonly callback;
  private server?: Server;
  private connecting?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly seen = new Map<string, number>();
  private accessToken?: { value: string; expiresAt: number };
  private refreshingToken?: Promise<string>;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.callback = parseCallbackConfig(config);
  }

  async connect(): Promise<void> {
    if (this.abort.signal.aborted)
      throw new Error('WeCom Callback is disconnected');
    if (this.connecting) return this.connecting;
    if (this.server) return;
    this.connecting = this.listen();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.receive(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end('Invalid callback');
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    this.server = server;
    const signal = this.abort.signal;
    let onAbort: () => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(new Error('WeCom Callback is disconnected'));
        signal.addEventListener('abort', onAbort, { once: true });
        server.on('error', (error) => {
          process.stderr.write('[WeCom Callback] HTTP server error.\n');
          reject(error);
        });
        server.listen(
          { port: this.callback.port, host: this.callback.host, signal },
          resolve,
        );
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async disconnect(): Promise<void> {
    this.abort.abort();
    this.accessToken = undefined;
    this.seen.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  protected override canStartInboundTurn(): boolean {
    return !this.abort.signal.aborted;
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return (
      !target.isGroup &&
      target.threadId === undefined &&
      isSingleUser(target.chatId)
    );
  }

  private async receive(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/wecom/callback') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' }).end();
      return;
    }
    const params = url.searchParams;
    const timestamp = params.get('timestamp') ?? '';
    const nonce = params.get('nonce') ?? '';
    if (
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > REPLAY_WINDOW_MS ||
      !nonce
    ) {
      throw new Error('Invalid callback timestamp or nonce');
    }
    let encrypted: string;
    if (req.method === 'GET') {
      encrypted = params.get('echostr') ?? '';
    } else {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const outer = parseCallbackXml(Buffer.concat(chunks).toString('utf8'));
      encrypted = outer['Encrypt'] ?? '';
    }
    verifyCallbackSignature(
      this.callback.token,
      timestamp,
      nonce,
      encrypted,
      params.get('msg_signature') ?? '',
    );
    const plaintext = decryptCallback(
      this.callback.key,
      this.callback.corpId,
      encrypted,
    );
    if (req.method === 'GET') {
      res
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(plaintext);
      return;
    }
    const message = parseCallbackXml(plaintext);
    if (
      message['ToUserName'] !== this.callback.corpId ||
      message['AgentID'] !== this.callback.agentId
    ) {
      throw new Error('Invalid callback application');
    }
    if (message['MsgType'] !== 'text') {
      res.end('success');
      return;
    }
    const sender = message['FromUserName'] ?? '';
    const id = message['MsgId'] ?? '';
    const content = message['Content'];
    if (!isSingleUser(sender) || !id || content === undefined) {
      throw new Error('Invalid callback message');
    }
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(key);
    }
    if (this.seen.has(id)) {
      res.end('success');
      return;
    }
    if (this.senderGateFor({ chatId: sender }).isAllowed(sender)) {
      if (this.seen.size >= 10_000) {
        res.writeHead(503).end();
        return;
      }
      this.seen.set(
        id,
        Math.max(now, Number(timestamp) * 1000) + REPLAY_WINDOW_MS,
      );
    }
    res.end('success');
    if (this.abort.signal.aborted) return;
    void this.handleInbound({
      channelName: this.name,
      senderId: sender,
      senderName: sender,
      chatId: sender,
      messageId: id,
      text: content,
      isGroup: false,
      isMentioned: false,
      isReplyToBot: false,
    }).catch(() => {
      process.stderr.write('[WeCom Callback] Message processing failed.\n');
    });
  }

  private async requestApi(
    path: string,
    params: URLSearchParams,
    body?: object,
  ): Promise<Record<string, unknown>> {
    let result: unknown;
    try {
      const response = await fetch(`${API_ROOT}${path}?${params}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(15_000),
        ]),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('HTTP failure');
      result = await response.json();
    } catch {
      throw new Error('WeCom Callback API request failed');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Invalid WeCom Callback API response');
    }
    return result as Record<string, unknown>;
  }

  private async getToken(): Promise<string> {
    if (this.abort.signal.aborted)
      throw new Error('WeCom Callback is disconnected');
    if (this.accessToken && this.accessToken.expiresAt > Date.now())
      return this.accessToken.value;
    if (this.refreshingToken) return this.refreshingToken;
    const refresh = (async () => {
      const data = await this.requestApi(
        'gettoken',
        new URLSearchParams({
          corpid: this.callback.corpId,
          corpsecret: this.callback.corpSecret,
        }),
      );
      if (
        data['errcode'] !== 0 ||
        typeof data['access_token'] !== 'string' ||
        !data['access_token'] ||
        typeof data['expires_in'] !== 'number' ||
        data['expires_in'] <= 0
      ) {
        throw new Error('WeCom Callback access token request failed');
      }
      this.accessToken = {
        value: data['access_token'],
        expiresAt: Date.now() + Math.max(0, data['expires_in'] - 60) * 1000,
      };
      return this.accessToken.value;
    })();
    this.refreshingToken = refresh;
    try {
      return await refresh;
    } finally {
      this.refreshingToken = undefined;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!isSingleUser(chatId))
      throw new Error('WeCom Callback requires a single user recipient');
    let chunk = '';
    let bytes = 0;
    const chunks: string[] = [];
    for (const character of text) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 2048) {
        chunks.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += character;
      bytes += length;
    }
    if (chunk) chunks.push(chunk);
    for (const content of chunks) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.getToken();
        const result = await this.requestApi(
          'message/send',
          new URLSearchParams({ access_token: token }),
          {
            touser: chatId,
            msgtype: 'text',
            agentid: Number(this.callback.agentId),
            text: { content },
          },
        );
        if (
          attempt === 0 &&
          (result['errcode'] === 40014 || result['errcode'] === 42001)
        ) {
          if (this.accessToken?.value === token) this.accessToken = undefined;
          continue;
        }
        if (
          result['errcode'] !== 0 ||
          result['invaliduser'] ||
          result['unlicenseduser']
        ) {
          const code =
            typeof result['errcode'] === 'number'
              ? result['errcode']
              : 'unknown';
          throw new Error(
            `WeCom Callback message delivery failed (code ${code})`,
          );
        }
        break;
      }
    }
  }
}
