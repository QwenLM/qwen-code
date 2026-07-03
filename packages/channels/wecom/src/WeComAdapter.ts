import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve, win32, posix } from 'node:path';
import { tmpdir } from 'node:os';
import type { Buffer } from 'node:buffer';
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
}

interface WeComClient {
  connect(): Promise<void>;
  disconnect(): void;
  on(event: string, handler: (payload: unknown) => void): void;
  sendMessage(chatId: string, message: unknown): Promise<unknown>;
  uploadMedia(
    data: Buffer,
    options: { mediaType: WeComMediaType; filename: string },
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
const MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

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

    await client.connect();
    this.client = client;
    this.dedupTimer = setInterval(() => this.cleanupSeenMessages(), 60_000);
    process.stderr.write(`[WeCom:${this.name}] Connected via smart bot.\n`);
  }

  disconnect(): void {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = undefined;
    }
    this.seenMessages.clear();
    this.client?.disconnect();
    this.client = undefined;
    process.stderr.write(`[WeCom:${this.name}] Disconnected.\n`);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      process.stderr.write(
        `[WeCom:${this.name}] No active SDK client, cannot send.\n`,
      );
      return;
    }

    const { cleanedText, media } = parseOutboundMediaMarkers(text);
    if (cleanedText) {
      await this.client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: cleanedText },
      });
    }

    for (const item of media) {
      const file = readOutboundMedia(item.path, this.config.cwd);
      const upload = await this.client.uploadMedia(file.data, {
        mediaType: item.type,
        filename: file.fileName,
      });
      const mediaId = extractMediaId(upload);
      if (!mediaId) {
        throw new Error('WeCom media upload failed: missing media_id');
      }
      await this.client.sendMediaMessage(chatId, item.type, mediaId);
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
    const chatId = getString(body, 'chatid') || senderId;
    if (!chatId || !senderId) return;

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

    try {
      const attachments = await this.downloadAttachments(body);
      if (attachments.length) {
        envelope.attachments = attachments;
      }
      if (!envelope.text && attachments.length) {
        envelope.text = attachments.some((a) => a.type === 'image')
          ? '(image)'
          : `(file: ${attachments[0]?.fileName ?? 'file'})`;
      }
      await this.handleInbound(envelope);
    } catch (err) {
      if (messageId) this.seenMessages.delete(messageId);
      throw err;
    }
  }

  private async downloadAttachments(
    body: Record<string, unknown>,
  ): Promise<Attachment[]> {
    const client = this.client;
    if (!client) return [];

    const refs = collectInboundMediaRefs(body);
    const attachments: Attachment[] = [];
    for (const ref of refs) {
      const downloaded = await client.downloadFile(ref.url, ref.aesKey);
      const data = downloaded.buffer;
      if (data.length > MAX_OUTBOUND_MEDIA_BYTES) {
        process.stderr.write(
          `[WeCom:${this.name}] skipping oversized attachment (${data.length} bytes): ${sanitizeLogText(
            ref.url,
            200,
          )}\n`,
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

  private cleanupSeenMessages(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }
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
  return wsUrl ? { botId, secret, wsUrl } : { botId, secret };
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
        if (!record || getString(record, 'msgtype') !== 'text') return '';
        return getString(getRecord(record, 'text'), 'content');
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

function readOutboundMedia(
  rawPath: string,
  cwd: string,
): { data: Buffer; fileName: string } {
  const resolved = resolve(rawPath);
  const real = realpathSync(resolved);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${real}`);
  if (stat.size > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new Error(`Media file too large: ${stat.size} bytes`);
  }

  const allowedDirs = [
    safeRealpath(tmpdir()),
    safeRealpath(resolve(cwd)),
    safeRealpath('/tmp/'),
  ].filter((dir): dir is string => Boolean(dir));
  if (!allowedDirs.some((dir) => isInsideDir(real, dir))) {
    throw new Error(`Media path outside allowed directories: ${real}`);
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

function isInsideDir(filePath: string, dir: string): boolean {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(filePath);
  const pathImpl = windowsStyle ? win32 : posix;
  const relative = pathImpl.relative(dir, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathImpl.isAbsolute(relative))
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
  const explicitBoolean =
    getBoolean(body, 'isMentioned') ??
    getBoolean(body, 'isInAtList') ??
    getBoolean(body, 'is_in_at_list');
  if (explicitBoolean !== undefined) return explicitBoolean;

  const mentions = collectMentionValues(body);
  if (!mentions.length) return undefined;

  return mentions.some(
    (mention) => mention === botId || mention === '@all' || mention === 'all',
  );
}

function collectMentionValues(body: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of [
    'mentions',
    'mentioned_list',
    'mentionedList',
    'at_list',
    'atList',
    'at_userids',
    'atUserIds',
  ]) {
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
  return values;
}
