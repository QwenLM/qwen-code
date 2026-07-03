import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve, win32, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { WSClient } from '@wecom/aibot-node-sdk';
import { ChannelBase, sanitizeLogText } from '@qwen-code/channel-base';
import type {
  Attachment,
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

type WeComMediaType = 'image' | 'file' | 'voice' | 'video';

interface WeComConfig {
  botId: string;
  secret: string;
  wsUrl?: string;
}

interface WeComClientOptions {
  botId: string;
  secret: string;
  wsUrl?: string;
  logger?: WeComLogger;
}

interface WeComClient {
  connect(): unknown;
  disconnect(): void;
  on(event: string, handler: (payload: unknown) => void): void;
  sendMessage(chatId: string, message: unknown): Promise<unknown>;
  uploadMedia(
    data: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<unknown>;
  sendMediaMessage(
    chatId: string,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<unknown>;
  downloadFile(
    url: string,
    aesKey?: string,
  ): Promise<{ buffer: Buffer; filename?: string }>;
}

interface WeComLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const ClientCtor = WSClient as unknown as new (
  options: WeComClientOptions,
) => WeComClient;

const MESSAGE_EVENTS = [
  'message.text',
  'message.image',
  'message.mixed',
  'message.voice',
  'message.file',
  'message.video',
] as const;

const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MARKDOWN_CHUNK_BYTES = 3800;
const AUTHENTICATION_TIMEOUT_MS = 30_000;

export class WeComChannel extends ChannelBase {
  private readonly wecom: WeComConfig;
  private client?: WeComClient;
  private readonly seenMessages = new Map<string, number>();
  private dedupTimer?: ReturnType<typeof setInterval>;

  constructor(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.wecom = parseWeComConfig(name, config);
  }

  async connect(): Promise<void> {
    if (this.client) return;

    const options: WeComClientOptions = {
      botId: this.wecom.botId,
      secret: this.wecom.secret,
      logger: createWeComLogger(this.name),
    };
    if (this.wecom.wsUrl) {
      options.wsUrl = this.wecom.wsUrl;
    }

    const client = new ClientCtor(options);
    for (const event of MESSAGE_EVENTS) {
      client.on(event, (payload) => {
        this.onMessage(payload).catch((err: unknown) => {
          process.stderr.write(
            `[WeCom:${this.name}] message handling failed: ${sanitizeLogText(
              String(err),
              200,
            )}\n`,
          );
        });
      });
    }
    client.on('error', (err) => {
      process.stderr.write(
        `[WeCom:${this.name}] SDK error: ${sanitizeLogText(String(err), 200)}\n`,
      );
    });
    const markDisconnected = (reason: string): void => {
      if (this.client !== client) return;
      this.client = undefined;
      if (this.dedupTimer) {
        clearInterval(this.dedupTimer);
        this.dedupTimer = undefined;
      }
      process.stderr.write(`[WeCom:${this.name}] WebSocket ${reason}.\n`);
    };
    client.on('disconnected', (reason) =>
      markDisconnected(formatDisconnectReason(reason)),
    );

    this.client = client;
    const authentication = waitForAuthentication(client);
    try {
      const connected = client.connect();
      if (isPromiseLike(connected)) await connected;
      await authentication.promise;
    } catch (err) {
      authentication.cancel();
      if (this.client === client) this.client = undefined;
      client.disconnect();
      throw err;
    }
    this.dedupTimer = setInterval(() => this.cleanupSeenMessages(), 60_000);
    process.stderr.write(`[WeCom:${this.name}] Connected via smart bot.\n`);
  }

  disconnect(): void {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = undefined;
    }
    this.seenMessages.clear();
    const client = this.client;
    this.client = undefined;
    client?.disconnect();
    process.stderr.write(`[WeCom:${this.name}] Disconnected.\n`);
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client) {
      process.stderr.write(
        `[WeCom:${this.name}] No active SDK client, cannot send.\n`,
      );
      return;
    }

    const { cleanedText, media } = parseOutboundMediaMarkers(text);
    for (const chunk of splitMarkdownChunks(cleanedText)) {
      await client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: chunk },
      });
    }

    for (const item of media) {
      if (item.type !== 'image') {
        process.stderr.write(
          `[WeCom:${this.name}] skipping unsupported outbound media marker: ${item.type}\n`,
        );
        continue;
      }
      try {
        const file = readOutboundMedia(item.path, this.config.cwd);
        const upload = await client.uploadMedia(file.data, {
          type: item.type,
          filename: file.fileName,
        });
        const mediaId = extractMediaId(upload);
        if (!mediaId) {
          process.stderr.write(
            `[WeCom:${this.name}] upload returned no media_id, skipping.\n`,
          );
          continue;
        }
        await client.sendMediaMessage(chatId, item.type, mediaId);
      } catch (err) {
        process.stderr.write(
          `[WeCom:${this.name}] media send failed for ${item.type}: ${sanitizeLogText(
            String(err),
            200,
          )}\n`,
        );
      }
    }
  }

  private async onMessage(payload: unknown): Promise<void> {
    const body = extractBody(payload);
    if (!body) return;

    const messageId = getString(body, 'msgid');
    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) this.seenMessages.set(messageId, Date.now());

    const from = getRecord(body, 'from');
    const senderId = getString(from, 'userid') || '';
    const senderName = getString(from, 'name') || senderId || 'Unknown';
    const isGroup = getString(body, 'chattype') === 'group';
    const rawChatId = getString(body, 'chatid');
    const chatId = isGroup ? rawChatId : rawChatId || senderId;
    if (!chatId || !senderId) {
      process.stderr.write(
        `[WeCom:${this.name}] dropping message ${
          messageId || '(no id)'
        }: missing ${!senderId ? 'senderId' : 'chatId'}.\n`,
      );
      return;
    }

    const text = extractText(body);
    const explicitMention = getExplicitMention(body, this.wecom.botId);
    const envelope: Envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      messageId,
      isGroup,
      isMentioned: !isGroup || (explicitMention ?? true),
      isReplyToBot: false,
      referencedText: extractQuoteText(body),
    };

    let attachments: Attachment[] = [];
    try {
      if (!(await this.preflightInbound(envelope))) return;
      attachments = await this.downloadAttachments(body, attachments);
      if (attachments.length) {
        envelope.attachments = attachments;
      }
      if (!envelope.text && attachments.length) {
        envelope.text = attachments.some((a) => a.type === 'image')
          ? '(image)'
          : `(file: ${attachments[0]?.fileName ?? 'file'})`;
      }
      await this.processInbound(envelope);
      cleanupAttachmentFiles(attachments);
    } catch (err) {
      if (messageId) this.seenMessages.delete(messageId);
      cleanupAttachmentFiles(attachments);
      throw err;
    }
  }

  private async downloadAttachments(
    body: Record<string, unknown>,
    attachments: Attachment[] = [],
  ): Promise<Attachment[]> {
    const client = this.client;
    if (!client) return [];

    const refs = collectInboundMediaRefs(body);
    for (const ref of refs) {
      if (!(await this.canDownloadAttachment(ref))) continue;
      const downloaded = await client.downloadFile(ref.url, ref.aesKey);
      const data = downloaded.buffer;
      if (data.length > MAX_MEDIA_BYTES) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping oversized ${ref.type} attachment (${data.length} bytes).\n`,
        );
        continue;
      }
      const fileName = ref.fileName || downloaded.filename;
      if (ref.type === 'image') {
        attachments.push({
          type: 'image',
          data: data.toString('base64'),
          mimeType: detectImageMime(data),
          fileName,
        });
      } else {
        const dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true });
        const safeName = sanitizeFileName(fileName) || `wecom_${ref.type}`;
        const filePath = join(dir, safeName);
        writeFileSync(filePath, data);
        attachments.push({
          type: ref.type === 'voice' ? 'audio' : ref.type,
          filePath,
          mimeType: mediaTypeToMime(ref.type),
          fileName: safeName,
        });
      }
    }
    return attachments;
  }

  private async canDownloadAttachment(ref: InboundMediaRef): Promise<boolean> {
    if (!(await isSafeInboundMediaUrl(ref.url))) {
      process.stderr.write(
        `[WeCom:${this.name}] skipping ${ref.type} attachment with unsafe media URL.\n`,
      );
      return false;
    }
    try {
      const response = await fetch(ref.url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping ${ref.type} attachment with redirect.\n`,
        );
        return false;
      }
      if (!response.ok) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping ${ref.type} attachment after media probe failed.\n`,
        );
        return false;
      }
      const contentLength = getContentLength(response);
      if (contentLength !== undefined && contentLength > MAX_MEDIA_BYTES) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping oversized ${ref.type} attachment (${contentLength} bytes).\n`,
        );
        return false;
      }
      if (!(await responseBodyWithinLimit(response))) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping oversized ${ref.type} attachment.\n`,
        );
        return false;
      }
      return true;
    } catch {
      process.stderr.write(
        `[WeCom:${this.name}] skipping ${ref.type} attachment after media metadata check failed.\n`,
      );
      return false;
    }
  }

  private cleanupSeenMessages(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }
}

function waitForAuthentication(client: WeComClient): {
  promise: Promise<void>;
  cancel(): void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let finish: (err?: Error) => void = () => {};

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (err) {
        rejectPromise(err);
      } else {
        resolvePromise();
      }
    };

    timeout = setTimeout(() => {
      finish(new Error('WeCom authentication timed out.'));
    }, AUTHENTICATION_TIMEOUT_MS);
    timeout.unref?.();

    client.on('authenticated', () => finish());
    client.on('error', (err) =>
      finish(
        new Error(
          `WeCom authentication failed: ${sanitizeLogText(String(err), 200)}`,
        ),
      ),
    );
    client.on('disconnected', (reason) =>
      finish(
        new Error(
          `WeCom disconnected before authentication: ${formatDisconnectReason(
            reason,
          )}`,
        ),
      ),
    );
  });
  return {
    promise,
    cancel: () => finish(),
  };
}

function formatDisconnectReason(reason: unknown): string {
  const text = typeof reason === 'string' && reason ? reason : 'disconnected';
  return sanitizeLogText(text, 120);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function parseWeComConfig(
  name: string,
  config: ChannelConfig & Record<string, unknown>,
): WeComConfig {
  const botId = readRequiredString(config, 'botId');
  const secret = readRequiredString(config, 'secret');
  if (!botId || !secret) {
    throw new Error(`Channel "${name}" requires botId and secret for WeCom.`);
  }
  const wsUrl = readOptionalString(config, 'wsUrl');
  if (wsUrl && !isSecureWebSocketUrl(wsUrl)) {
    throw new Error(`Channel "${name}" requires wsUrl to use wss://.`);
  }
  return wsUrl ? { botId, secret, wsUrl } : { botId, secret };
}

function cleanupAttachmentFiles(attachments: Attachment[]): void {
  for (const attachment of attachments) {
    if (!attachment.filePath) continue;
    try {
      unlinkSync(attachment.filePath);
    } catch {
      // Best effort cleanup only.
    }
  }
}

function readRequiredString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isSecureWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

function createWeComLogger(name: string): WeComLogger {
  const write = (level: 'warn' | 'error'): void => {
    process.stderr.write(`[WeCom:${name}] SDK ${level} event.\n`);
  };
  return {
    debug: () => {},
    info: () => {},
    warn: () => write('warn'),
    error: () => write('error'),
  };
}

function extractBody(payload: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(payload);
  if (!raw) return undefined;
  return getRecord(raw, 'body') ?? raw;
}

function extractText(body: Record<string, unknown>): string {
  const msgType = getString(body, 'msgtype');
  if (msgType === 'mixed') {
    const mixed = getRecord(body, 'mixed');
    const items = getArray(mixed, 'msg_item');
    return items
      .map((item) => {
        const record = asRecord(item);
        if (!record) return '';
        const itemType = getString(record, 'msgtype');
        if (itemType === 'text') {
          return getString(getRecord(record, 'text'), 'content');
        }
        if (itemType === 'voice') {
          return getString(getRecord(record, 'voice'), 'content');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  const text = getString(getRecord(body, 'text'), 'content');
  const voiceText = getString(getRecord(body, 'voice'), 'content');
  if (text) return text;
  if (voiceText) return voiceText;
  if (msgType === 'image') return '(image)';
  if (msgType === 'voice') return '(voice)';
  if (msgType === 'video') return '(video)';
  if (msgType === 'file') {
    const name = sanitizeFileName(
      getString(getRecord(body, 'file'), 'filename'),
    );
    return `(file: ${name || 'file'})`;
  }
  return '';
}

function extractQuoteText(body: Record<string, unknown>): string | undefined {
  const quote = getRecord(body, 'quote');
  if (!quote) return undefined;
  return extractText(quote) || undefined;
}

interface InboundMediaRef {
  type: WeComMediaType;
  url: string;
  aesKey?: string;
  fileName?: string;
}

function collectInboundMediaRefs(
  body: Record<string, unknown>,
  depth = 0,
): InboundMediaRef[] {
  if (depth > 3) return [];

  const refs: InboundMediaRef[] = [];
  const add = (type: WeComMediaType, source: Record<string, unknown>): void => {
    const url = getString(source, 'url');
    if (!url) return;
    refs.push({
      type,
      url,
      aesKey: getString(source, 'aeskey') || undefined,
      fileName:
        getString(source, 'filename') ||
        getString(source, 'file_name') ||
        undefined,
    });
  };

  const mixed = getRecord(body, 'mixed');
  for (const item of getArray(mixed, 'msg_item')) {
    const record = asRecord(item);
    if (!record) continue;
    const itemType = getString(record, 'msgtype');
    if (itemType === 'image') add('image', getRecord(record, 'image') ?? {});
  }

  add('image', getRecord(body, 'image') ?? {});
  add('file', getRecord(body, 'file') ?? {});
  add('video', getRecord(body, 'video') ?? {});
  add('voice', getRecord(body, 'voice') ?? {});

  const quote = getRecord(body, 'quote');
  if (quote) refs.push(...collectInboundMediaRefs(quote, depth + 1));

  return refs;
}

interface OutboundMediaMarker {
  type: WeComMediaType;
  path: string;
}

function parseOutboundMediaMarkers(text: string): {
  cleanedText: string;
  media: OutboundMediaMarker[];
} {
  const codeRanges = findCodeRanges(text);
  const markerRe = /\[(IMAGE|FILE|VIDEO|VOICE):\s*([^\]]+)\]/gi;
  const media: OutboundMediaMarker[] = [];
  const rangesToRemove: Array<[number, number]> = [];

  for (const match of text.matchAll(markerRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (codeRanges.some(([from, to]) => start >= from && start < to)) continue;
    const path = match[2]?.trim();
    const rawType = match[1]?.toLowerCase();
    if (!path || !isWeComMediaType(rawType)) continue;
    media.push({ type: rawType, path });
    rangesToRemove.push([start, end]);
  }

  let cleanedText = text;
  for (const [start, end] of rangesToRemove.toReversed()) {
    cleanedText = `${cleanedText.slice(0, start)}${cleanedText.slice(end)}`;
  }
  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    media,
  };
}

function findCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`]*`/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function isWeComMediaType(value: string | undefined): value is WeComMediaType {
  return (
    value === 'image' ||
    value === 'file' ||
    value === 'voice' ||
    value === 'video'
  );
}

function splitMarkdownChunks(text: string): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate, 'utf8') <= MARKDOWN_CHUNK_BYTES) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    let slice = '';
    let sliceBytes = 0;
    for (const char of line) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (sliceBytes + charBytes > MARKDOWN_CHUNK_BYTES) {
        if (slice) chunks.push(slice);
        slice = char;
        sliceBytes = charBytes;
      } else {
        slice += char;
        sliceBytes += charBytes;
      }
    }
    current = slice;
  }

  if (current) chunks.push(current);
  return chunks;
}

function readOutboundMedia(
  rawPath: string,
  cwd: string,
): {
  data: Buffer;
  fileName: string;
} {
  const resolved = resolve(cwd, rawPath);
  const real = realpathSync(resolved);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${real}`);
  if (stat.size > MAX_MEDIA_BYTES) {
    throw new Error(`Media file too large: ${stat.size} bytes`);
  }

  const allowedDirs = [
    ensureDirectoryRealpath(join(tmpdir(), 'channel-files')),
    ensureDirectoryRealpath('/tmp/channel-files'),
  ].filter((dir): dir is string => Boolean(dir));
  if (!allowedDirs.some((dir) => isInsideDir(real, dir))) {
    throw new Error(`Media path outside allowed outbound directory: ${real}`);
  }
  return { data: readFileSync(real), fileName: basename(real) };
}

export function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function ensureDirectoryRealpath(path: string): string | undefined {
  try {
    mkdirSync(path, { recursive: true });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isInsideDir(filePath: string, dir: string): boolean {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(filePath);
  const pathImpl = windowsStyle ? win32 : posix;
  const relative = pathImpl.relative(dir, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathImpl.isAbsolute(relative))
  );
}

function getContentLength(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  const size = Number(header);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

async function responseBodyWithinLimit(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return true;

  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel().catch(() => {});
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function isSafeInboundMediaUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return false;
  }
  if (host.endsWith('.local')) return false;

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = parseIpv4Parts(host);
    return parts ? isPublicIpv4(parts) : false;
  }
  if (ipVersion === 6) {
    const mapped = parseMappedIpv4(host);
    if (mapped) return isPublicIpv4(mapped);
    return !(
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    );
  }
  if (!host.includes('.')) return false;
  try {
    const records = await lookup(host, { all: true });
    return (
      records.length > 0 &&
      records.every((record) => isPublicIpAddress(record.address))
    );
  } catch {
    return false;
  }
}

function isPublicIpAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = parseIpv4Parts(host);
    return parts ? isPublicIpv4(parts) : false;
  }
  if (ipVersion === 6) {
    const mapped = parseMappedIpv4(host);
    if (mapped) return isPublicIpv4(mapped);
    return !(
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    );
  }
  return false;
}

function parseIpv4Parts(host: string): number[] | undefined {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts;
}

function parseMappedIpv4(host: string): number[] | undefined {
  if (!host.startsWith('::ffff:')) return undefined;
  const suffix = host.slice('::ffff:'.length);
  if (suffix.includes('.')) {
    return suffix.split('.').map((part) => Number(part));
  }
  const groups = suffix.split(':');
  if (groups.length !== 2) return undefined;
  const high = parseHexGroup(groups[0]);
  const low = parseHexGroup(groups[1]);
  if (high === undefined || low === undefined) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function parseHexGroup(value: string | undefined): number | undefined {
  if (!value || !/^[\da-f]{1,4}$/i.test(value)) return undefined;
  const parsed = Number.parseInt(value, 16);
  return parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
}

function isPublicIpv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function extractMediaId(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    getString(record, 'media_id') ||
    getString(record, 'mediaId') ||
    getString(getRecord(record, 'body'), 'media_id') ||
    undefined
  );
}

function detectImageMime(data: Buffer): string {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}

function mediaTypeToMime(type: WeComMediaType): string {
  switch (type) {
    case 'video':
      return 'video/mp4';
    case 'voice':
      return 'audio/amr';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeFileName(name: string | undefined): string {
  const base = basename(name || '').replace(/\0/g, '');
  return base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(value?.[key]);
}

function getArray(
  value: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const raw = value?.[key];
  return Array.isArray(raw) ? raw : [];
}

function getString(
  value: Record<string, unknown> | undefined,
  key: string,
): string {
  const raw = value?.[key];
  return typeof raw === 'string' ? raw : '';
}

function getBoolean(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const raw = value?.[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function getExplicitMention(
  body: Record<string, unknown>,
  botId: string,
): boolean | undefined {
  const botSpecificMention =
    getBoolean(body, 'isInAtList') ?? getBoolean(body, 'is_in_at_list');
  if (botSpecificMention !== undefined) return botSpecificMention;

  const mentions = collectMentionValues(body);
  if (!mentions.present) return getBoolean(body, 'isMentioned');

  return mentions.values.some(
    (mention) => mention === botId || mention === '@all' || mention === 'all',
  );
}

function collectMentionValues(body: Record<string, unknown>): {
  present: boolean;
  values: string[];
} {
  const values: string[] = [];
  let present = false;
  for (const key of [
    'mentions',
    'mentioned_list',
    'mentionedList',
    'at_list',
    'atList',
    'at_userids',
    'atUserIds',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      present = true;
    }
    for (const item of getArray(body, key)) {
      if (typeof item === 'string') {
        values.push(item);
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      for (const itemKey of ['userid', 'userId', 'id', 'open_id', 'openId']) {
        const value = getString(record, itemKey);
        if (value) values.push(value);
      }
    }
  }
  return { present, values };
}
