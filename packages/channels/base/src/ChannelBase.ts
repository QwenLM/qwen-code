import type { ChannelConfig, Envelope } from './types.js';
import { GroupGate } from './GroupGate.js';
import { SenderGate } from './SenderGate.js';
import { PairingStore } from './PairingStore.js';
import { SessionRouter } from './SessionRouter.js';
import type { AcpBridge, ToolCallEvent } from './AcpBridge.js';

export abstract class ChannelBase {
  protected config: ChannelConfig;
  protected bridge: AcpBridge;
  protected groupGate: GroupGate;
  protected gate: SenderGate;
  protected router: SessionRouter;
  protected name: string;
  private instructedSessions: Set<string> = new Set();

  constructor(name: string, config: ChannelConfig, bridge: AcpBridge) {
    this.name = name;
    this.config = config;
    this.bridge = bridge;

    this.groupGate = new GroupGate(config.groupPolicy, config.groups);

    const pairingStore =
      config.senderPolicy === 'pairing' ? new PairingStore(name) : undefined;
    this.gate = new SenderGate(
      config.senderPolicy,
      config.allowedUsers,
      pairingStore,
    );
    this.router = new SessionRouter(bridge, config.cwd, config.sessionScope);

    bridge.on('toolCall', (event: ToolCallEvent) => {
      const target = this.router.getTarget(event.sessionId);
      if (target) {
        this.onToolCall(target.chatId, event);
      }
    });
  }

  abstract connect(): Promise<void>;
  abstract sendMessage(chatId: string, text: string): Promise<void>;
  abstract disconnect(): void;

  onToolCall(_chatId: string, _event: ToolCallEvent): void {}

  async handleInbound(envelope: Envelope): Promise<void> {
    // 1. Group gate: policy + allowlist + mention gating
    const groupResult = this.groupGate.check(envelope);
    if (!groupResult.allowed) {
      return; // silently drop — no pairing, no reply
    }

    // 2. Sender gate: allowlist / pairing / open
    const result = this.gate.check(envelope.senderId, envelope.senderName);
    if (!result.allowed) {
      if (result.pairingCode !== undefined) {
        await this.onPairingRequired(envelope.chatId, result.pairingCode);
      }
      return;
    }

    const sessionId = await this.router.resolve(
      this.name,
      envelope.senderId,
      envelope.chatId,
      envelope.threadId,
    );

    // Prepend channel instructions on first message of a session
    let promptText = envelope.text;
    if (this.config.instructions && !this.instructedSessions.has(sessionId)) {
      promptText = `${this.config.instructions}\n\n${envelope.text}`;
      this.instructedSessions.add(sessionId);
    }

    const response = await this.bridge.prompt(sessionId, promptText, {
      imageBase64: envelope.imageBase64,
      imageMimeType: envelope.imageMimeType,
    });

    if (response) {
      await this.sendMessage(envelope.chatId, response);
    }
  }

  protected async onPairingRequired(
    chatId: string,
    code: string | null,
  ): Promise<void> {
    if (code) {
      await this.sendMessage(
        chatId,
        `Your pairing code is: ${code}\n\nAsk the bot operator to approve you with:\n  qwen channel pairing approve ${this.name} ${code}`,
      );
    } else {
      await this.sendMessage(
        chatId,
        'Too many pending pairing requests. Please try again later.',
      );
    }
  }
}
