import type { ChannelConfig, Envelope } from './types.js';
import { SenderGate } from './SenderGate.js';
import { SessionRouter } from './SessionRouter.js';
import type { AcpBridge } from './AcpBridge.js';

export abstract class ChannelBase {
  protected config: ChannelConfig;
  protected bridge: AcpBridge;
  protected gate: SenderGate;
  protected router: SessionRouter;
  protected name: string;
  private instructedSessions: Set<string> = new Set();

  constructor(name: string, config: ChannelConfig, bridge: AcpBridge) {
    this.name = name;
    this.config = config;
    this.bridge = bridge;
    this.gate = new SenderGate(config.senderPolicy, config.allowedUsers);
    this.router = new SessionRouter(bridge, config.cwd, config.sessionScope);
  }

  abstract connect(): Promise<void>;
  abstract sendMessage(chatId: string, text: string): Promise<void>;
  abstract disconnect(): void;

  async handleInbound(envelope: Envelope): Promise<void> {
    if (!this.gate.check(envelope.senderId)) {
      console.log(
        `[Channel:${this.name}] Sender ${envelope.senderId} denied by gate`,
      );
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

    console.log(
      `[Channel:${this.name}] Prompting session ${sessionId}: "${envelope.text.substring(0, 80)}"`,
    );

    console.log(`[Channel:${this.name}] Waiting for prompt response...`);
    const response = await this.bridge.prompt(sessionId, promptText);
    console.log(
      `[Channel:${this.name}] Got response (${response.length} chars): "${response.substring(0, 100)}"`,
    );

    if (response) {
      await this.sendMessage(envelope.chatId, response);
      console.log(
        `[Channel:${this.name}] Message sent to chat ${envelope.chatId}`,
      );
    }
  }
}
