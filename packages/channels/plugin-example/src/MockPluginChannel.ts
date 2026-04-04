import { ChannelBase } from '@qwen-code/channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
} from '@qwen-code/channel-base';
import WebSocket from 'ws';
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
  private pendingMessageId: string | undefined;

  constructor(
    name: string,
    config: MockPluginConfig & Record<string, unknown>,
    bridge: AcpBridge,
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
    _sessionId: string,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: ChunkMessage = {
      type: 'chunk',
      messageId: this.pendingMessageId || 'unknown',
      chatId,
      text: chunk,
    };
    this.ws.send(JSON.stringify(msg));
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    _sessionId: string,
  ): Promise<void> {
    await this.sendMessage(chatId, fullText);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const outbound: OutboundMessage = {
      type: 'outbound',
      messageId: this.pendingMessageId || 'unknown',
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
    this.pendingMessageId = envelope.messageId;
    try {
      await super.handleInbound(envelope);
    } finally {
      this.pendingMessageId = undefined;
    }
  }
}
