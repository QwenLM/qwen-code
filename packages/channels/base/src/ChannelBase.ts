import type { ChannelConfig, Envelope } from './types.js';
import { GroupGate } from './GroupGate.js';
import { SenderGate } from './SenderGate.js';
import { PairingStore } from './PairingStore.js';
import { SessionRouter } from './SessionRouter.js';
import type { AcpBridge, ToolCallEvent } from './AcpBridge.js';

export interface ChannelBaseOptions {
  router?: SessionRouter;
}

/** Handler for a slash command. Return true if handled, false to forward to agent. */
type CommandHandler = (envelope: Envelope, args: string) => Promise<boolean>;

export abstract class ChannelBase {
  protected config: ChannelConfig;
  protected bridge: AcpBridge;
  protected groupGate: GroupGate;
  protected gate: SenderGate;
  protected router: SessionRouter;
  protected name: string;
  private instructedSessions: Set<string> = new Set();
  private commands: Map<string, CommandHandler> = new Map();
  /** Per-session promise chain to serialize prompt + send. */
  private sessionQueues: Map<string, Promise<void>> = new Map();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
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
    this.router =
      options?.router ||
      new SessionRouter(bridge, config.cwd, config.sessionScope);

    this.registerSharedCommands();

    // When running standalone (no gateway), register toolCall listener directly.
    // In gateway mode, the ChannelManager dispatches events instead.
    if (!options?.router) {
      bridge.on('toolCall', (event: ToolCallEvent) => {
        const target = this.router.getTarget(event.sessionId);
        if (target) {
          this.onToolCall(target.chatId, event);
        }
      });
    }
  }

  abstract connect(): Promise<void>;
  abstract sendMessage(chatId: string, text: string): Promise<void>;
  abstract disconnect(): void;

  /** Replace the bridge instance (used after crash recovery restart). */
  setBridge(bridge: AcpBridge): void {
    this.bridge = bridge;
  }

  onToolCall(_chatId: string, _event: ToolCallEvent): void {}

  /**
   * Register a slash command handler. Subclasses can call this to add
   * platform-specific commands (e.g., /start for Telegram).
   * Overrides shared commands if the same name is registered.
   */
  protected registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name.toLowerCase(), handler);
  }

  /** Register shared slash commands. Called from constructor. */
  private registerSharedCommands(): void {
    const clearHandler: CommandHandler = async (envelope) => {
      const removed = this.router.removeSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
      );
      if (removed) {
        this.instructedSessions.clear();
        await this.sendMessage(
          envelope.chatId,
          'Session cleared. Your next message will start a fresh conversation.',
        );
      } else {
        await this.sendMessage(envelope.chatId, 'No active session to clear.');
      }
      return true;
    };

    this.registerCommand('clear', clearHandler);
    this.registerCommand('reset', clearHandler);
    this.registerCommand('new', clearHandler);

    this.registerCommand('help', async (envelope) => {
      const lines = [
        'Commands:',
        '/help — Show this help',
        '/clear — Clear your session (aliases: /reset, /new)',
        '/status — Show session info',
      ];

      // Platform-specific commands (registered by adapters, not shared ones)
      const sharedCmds = new Set(['help', 'clear', 'reset', 'new', 'status']);
      const platformCmds = [...this.commands.keys()].filter(
        (c) => !sharedCmds.has(c),
      );
      if (platformCmds.length > 0) {
        for (const cmd of platformCmds) {
          lines.push(`/${cmd}`);
        }
      }

      const agentCommands = this.bridge.availableCommands;
      if (agentCommands.length > 0) {
        lines.push('', 'Agent commands (forwarded to Qwen Code):');
        for (const cmd of agentCommands) {
          lines.push(`/${cmd.name} — ${cmd.description}`);
        }
      }

      lines.push('', 'Send any text to chat with the agent.');
      await this.sendMessage(envelope.chatId, lines.join('\n'));
      return true;
    });

    this.registerCommand('status', async (envelope) => {
      const hasSession = this.router.hasSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
      );
      const policy = this.config.senderPolicy;
      const lines = [
        `Session: ${hasSession ? 'active' : 'none'}`,
        `Access: ${policy}`,
        `Channel: ${this.name}`,
      ];
      await this.sendMessage(envelope.chatId, lines.join('\n'));
      return true;
    });
  }

  /** Check if a message text matches a registered local command. */
  protected isLocalCommand(text: string): boolean {
    const parsed = this.parseCommand(text);
    return parsed !== null && this.commands.has(parsed.command);
  }

  /**
   * Parse a slash command from message text.
   * Returns { command, args } or null if not a slash command.
   */
  private parseCommand(text: string): { command: string; args: string } | null {
    if (!text.startsWith('/')) return null;
    // Handle /command@botname format (Telegram groups)
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*(.*)/s);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

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

    // 3. Slash command handling — before session/agent routing
    const parsed = this.parseCommand(envelope.text);
    if (parsed) {
      const handler = this.commands.get(parsed.command);
      if (handler) {
        const handled = await handler(envelope, parsed.args);
        if (handled) return;
      }
      // Unrecognized commands fall through to the agent
    }

    const sessionId = await this.router.resolve(
      this.name,
      envelope.senderId,
      envelope.chatId,
      envelope.threadId,
      this.config.cwd,
    );

    // Prepend referenced (quoted) message text for reply context
    let promptText = envelope.text;
    if (envelope.referencedText) {
      promptText = `[Replying to: "${envelope.referencedText}"]\n\n${promptText}`;
    }

    // Prepend channel instructions on first message of a session
    if (this.config.instructions && !this.instructedSessions.has(sessionId)) {
      promptText = `${this.config.instructions}\n\n${promptText}`;
      this.instructedSessions.add(sessionId);
    }

    // Serialize prompt + send per session to prevent textChunk listener
    // pollution when concurrent messages hit the same session.
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = prev.then(async () => {
      const response = await this.bridge.prompt(sessionId, promptText, {
        imageBase64: envelope.imageBase64,
        imageMimeType: envelope.imageMimeType,
      });

      if (response) {
        await this.sendMessage(envelope.chatId, response);
      }
    });
    this.sessionQueues.set(
      sessionId,
      current.catch(() => {}),
    );
    await current;
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
