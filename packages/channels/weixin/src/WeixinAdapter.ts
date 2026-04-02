/**
 * WeChat channel adapter for Qwen Code.
 * Extends ChannelBase with WeChat iLink Bot API integration.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';
import { loadAccount, DEFAULT_BASE_URL } from './accounts.js';
import { startPollLoop, getContextToken } from './monitor.js';
import type { CdnRef, FileCdnRef } from './monitor.js';
import { sendText } from './send.js';
import { downloadAndDecrypt } from './media.js';
import { getConfig, sendTyping } from './api.js';
import { TypingStatus } from './types.js';

/** In-memory typing ticket cache: userId -> typingTicket */
const typingTickets = new Map<string, string>();

export class WeixinChannel extends ChannelBase {
  private abortController: AbortController | null = null;
  private baseUrl: string;
  private token: string = '';

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.baseUrl =
      (config as ChannelConfig & { baseUrl?: string }).baseUrl ||
      DEFAULT_BASE_URL;
  }

  async connect(): Promise<void> {
    const account = loadAccount();
    if (!account) {
      throw new Error(
        'WeChat account not configured. Run "qwen channel configure-weixin" first.',
      );
    }
    this.token = account.token;
    if (account.baseUrl) {
      this.baseUrl = account.baseUrl;
    }

    this.abortController = new AbortController();

    startPollLoop({
      baseUrl: this.baseUrl,
      token: this.token,
      onMessage: async (msg) => {
        const envelope: Envelope = {
          channelName: this.name,
          senderId: msg.fromUserId,
          senderName: msg.fromUserId,
          chatId: msg.fromUserId,
          text: msg.text,
          isGroup: false,
          isMentioned: false,
          isReplyToBot: false,
          referencedText: msg.refText,
        };

        this.handleInboundWithMedia(envelope, msg.image, msg.file).catch(
          (err) => {
            const errMsg =
              err instanceof Error ? err.message : JSON.stringify(err, null, 2);
            process.stderr.write(
              `[Weixin:${this.name}] Error handling message: ${errMsg}\n`,
            );
          },
        );
      },
      abortSignal: this.abortController.signal,
    }).catch((err) => {
      if (!this.abortController?.signal.aborted) {
        process.stderr.write(`[Weixin:${this.name}] Poll loop error: ${err}\n`);
      }
    });

    process.stderr.write(
      `[Weixin:${this.name}] Connected to WeChat (${this.baseUrl})\n`,
    );
  }

  protected override onPromptStart(chatId: string): void {
    this.setTyping(chatId, true).catch(() => {});
  }

  protected override onPromptEnd(chatId: string): void {
    this.setTyping(chatId, false).catch(() => {});
  }

  private async handleInboundWithMedia(
    envelope: Envelope,
    image?: CdnRef,
    file?: FileCdnRef,
  ): Promise<void> {
    // Download image from CDN
    if (image) {
      try {
        const imageData = await downloadAndDecrypt(
          image.encryptQueryParam,
          image.aesKey,
        );
        envelope.imageBase64 = imageData.toString('base64');
        envelope.imageMimeType = detectImageMime(imageData);
      } catch (err) {
        process.stderr.write(
          `[Weixin:${this.name}] Failed to download image: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }

    // Download file from CDN, save to temp dir
    if (file) {
      try {
        const fileData = await downloadAndDecrypt(
          file.encryptQueryParam,
          file.aesKey,
        );
        const dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true });
        const filePath = join(
          dir,
          basename(file.fileName) || `file_${Date.now()}`,
        );
        writeFileSync(filePath, fileData);
        envelope.attachments = [
          {
            type: 'file',
            filePath,
            mimeType: 'application/octet-stream',
            fileName: file.fileName,
          },
        ];
      } catch (err) {
        process.stderr.write(
          `[Weixin:${this.name}] Failed to download file: ${err instanceof Error ? err.message : err}\n`,
        );
        envelope.text = `(User sent a file "${file.fileName}" but download failed)`;
      }
    }

    await super.handleInbound(envelope);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const contextToken = getContextToken(chatId) || '';
    await sendText({
      to: chatId,
      text,
      baseUrl: this.baseUrl,
      token: this.token,
      contextToken,
    });
  }

  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async setTyping(userId: string, typing: boolean): Promise<void> {
    try {
      let ticket = typingTickets.get(userId);
      if (!ticket) {
        const contextToken = getContextToken(userId);
        const config = await getConfig(
          this.baseUrl,
          this.token,
          userId,
          contextToken,
        );
        if (config.typing_ticket) {
          ticket = config.typing_ticket;
          typingTickets.set(userId, ticket);
        }
      }
      if (!ticket) return;

      await sendTyping(this.baseUrl, this.token, {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
      });
    } catch {
      // Typing is best-effort — don't fail the message flow
    }
  }
}

/** Detect image MIME type from magic bytes. */
function detectImageMime(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) {
    return 'image/png';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
