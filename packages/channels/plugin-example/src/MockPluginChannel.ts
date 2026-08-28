import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  InboundMessage,
  OutboundMessage,
  ChunkMessage,
} from './protocol.js';

export interface MockPluginConfig extends ChannelConfig {
  serverWsUrl: string;
}

export class MockPluginChannel extends ChannelBase {
  private ws: WebSocket | null = null;
  private serverWsUrl: string;
  private inboundMessage = new AsyncLocalStorage<{ messageId?: string }>();
  private attributedSegments = new Set<string>();

  constructor(
    name: string,
    config: MockPluginConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.serverWsUrl = config.serverWsUrl;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.serverWsUrl);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as InboundMessage;
          if (msg.type === 'inbound') {
            this.onInboundMessage(msg);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
      });

      this.ws.on('error', (err: Error) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  private onInboundMessage(msg: InboundMessage): void {
    const envelope: Envelope = {
      channelName: this.name,
      senderId: msg.senderId,
      senderName: msg.senderName,
      chatId: msg.chatId,
      text: msg.text,
      messageId: msg.messageId,
      isGroup: false,
      isMentioned: false,
      isReplyToBot: false,
    };

    this.handleInbound(envelope).catch(() => {
      // errors handled internally by ChannelBase
    });
  }

  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: ChunkMessage = {
      type: 'chunk',
      messageId:
        segment?.messageId ?? this.getResponseMessageId(sessionId) ?? 'unknown',
      chatId,
      text:
        segment?.sourceLabel && !this.attributedSegments.has(segment.segmentId)
          ? this.formatAttributedText(chunk, segment.sourceLabel)
          : chunk,
    };
    if (segment?.sourceLabel) this.attributedSegments.add(segment.segmentId);
    this.ws.send(JSON.stringify(msg));
  }

  protected override onOutputSegmentEnd(
    chatId: string,
    sessionId: string,
    segment: ChannelOutputSegmentContext,
    reason: ChannelOutputSegmentEndReason,
  ): void | Promise<void> {
    this.attributedSegments.delete(segment.segmentId);
    return super.onOutputSegmentEnd(chatId, sessionId, segment, reason);
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): Promise<void> {
    this.sendOutbound(
      chatId,
      segment?.sourceLabel
        ? this.formatAttributedText(fullText, segment.sourceLabel)
        : fullText,
      segment?.messageId ?? this.getResponseMessageId(sessionId),
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sendOutbound(chatId, text, this.inboundMessage.getStore()?.messageId);
  }

  private sendOutbound(chatId: string, text: string, messageId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const outbound: OutboundMessage = {
      type: 'outbound',
      messageId: messageId ?? 'unknown',
      chatId,
      text,
    };

    this.ws.send(JSON.stringify(outbound));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    await this.inboundMessage.run({ messageId: envelope.messageId }, async () =>
      super.handleInbound(envelope),
    );
  }
}
