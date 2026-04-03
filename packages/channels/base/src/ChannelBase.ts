import type { ChannelConfig, DispatchMode, Envelope } from './types.js';
import { BlockStreamer } from './BlockStreamer.js';
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
  /** Per-session promise chain to serialize prompt + send (followup mode). */
  private sessionQueues: Map<string, Promise<void>> = new Map();

  /** Per-session active prompt tracking for dispatch modes. */
  private activePrompts: Map<
    string,
    { cancelled: boolean; done: Promise<void>; resolve: () => void }
  > = new Map();
  /** Per-session message buffer for collect mode. */
  private collectBuffers: Map<
    string,
    Array<{ text: string; envelope: Envelope }>
  > = new Map();

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
   * Called when a prompt actually begins processing (inside the session queue).
   * Override to show a platform-specific working indicator (e.g., typing, reaction).
   * Not called for buffered messages (collect mode) or gated/blocked messages.
   */
  protected onPromptStart(
    _chatId: string,
    _sessionId: string,
    _messageId?: string,
  ): void {}

  /**
   * Called when a prompt finishes (response sent or cancelled).
   * Override to hide the working indicator.
   */
  protected onPromptEnd(
    _chatId: string,
    _sessionId: string,
    _messageId?: string,
  ): void {}

  /**
   * Called for each text chunk as the agent streams its response.
   * Override to implement progressive display (e.g., updating an AI card in-place).
   * Default: no-op (chunks are collected internally and delivered via onResponseComplete).
   */
  protected onResponseChunk(
    _chatId: string,
    _chunk: string,
    _sessionId: string,
  ): void {}

  /**
   * Called when the agent's full response is ready.
   * Override to customize delivery (e.g., finalize an AI card).
   * Default: calls sendMessage() with the full response text.
   */
  protected async onResponseComplete(
    chatId: string,
    fullText: string,
    _sessionId: string,
  ): Promise<void> {
    await this.sendMessage(chatId, fullText);
  }

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
      const removedIds = this.router.removeSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
      );
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          this.instructedSessions.delete(id);
        }
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

    // Resolve attachments: extract image for bridge, append file paths to text
    let imageBase64 = envelope.imageBase64;
    let imageMimeType = envelope.imageMimeType;
    if (envelope.attachments?.length) {
      const filePaths: string[] = [];
      for (const att of envelope.attachments) {
        if (att.type === 'image' && att.data && !imageBase64) {
          imageBase64 = att.data;
          imageMimeType = att.mimeType;
        } else if (att.filePath) {
          const label = att.type === 'file' ? 'file' : att.type;
          const name = att.fileName ? ` "${att.fileName}"` : '';
          filePaths.push(
            `User sent a ${label}${name}. It has been saved to: ${att.filePath}`,
          );
        }
      }
      if (filePaths.length > 0) {
        promptText = promptText + '\n\n' + filePaths.join('\n');
      }
    }

    // Prepend channel instructions on first message of a session
    if (this.config.instructions && !this.instructedSessions.has(sessionId)) {
      promptText = `${this.config.instructions}\n\n${promptText}`;
      this.instructedSessions.add(sessionId);
    }

    // Resolve dispatch mode: per-group override → channel config → default
    const groupCfg = envelope.isGroup
      ? this.config.groups[envelope.chatId] || this.config.groups['*']
      : undefined;
    const mode: DispatchMode =
      groupCfg?.dispatchMode || this.config.dispatchMode || 'steer';

    const active = this.activePrompts.get(sessionId);

    if (active) {
      // A prompt is already running for this session
      switch (mode) {
        case 'collect': {
          // Buffer the message; it will be coalesced when the active prompt finishes
          let buffer = this.collectBuffers.get(sessionId);
          if (!buffer) {
            buffer = [];
            this.collectBuffers.set(sessionId, buffer);
          }
          buffer.push({ text: promptText, envelope });
          return;
        }
        case 'steer': {
          // Cancel the running prompt, then fall through to send a new one
          active.cancelled = true;
          await this.bridge.cancelSession(sessionId).catch(() => {});
          // Wait for the active prompt to finish winding down
          await active.done;
          // Prepend a cancellation note so the agent understands context
          promptText = `[The user sent a new message while you were working. Their previous request has been cancelled.]\n\n${promptText}`;
          break;
        }
        case 'followup': {
          // Chain onto the session queue (existing sequential behavior)
          break;
        }
        default: {
          // Exhaustive check — should never happen
          const _exhaustive: never = mode;
          throw new Error(`Unknown dispatch mode: ${_exhaustive}`);
        }
      }
    }

    // Run the prompt (with followup-mode serialization for safety)
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const useBlockStreaming = this.config.blockStreaming === 'on';
    const current = prev.then(async () => {
      // Register this prompt as active
      let doneResolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        doneResolve = r;
      });
      const promptState = { cancelled: false, done, resolve: doneResolve };
      this.activePrompts.set(sessionId, promptState);

      this.onPromptStart(envelope.chatId, sessionId, envelope.messageId);

      const streamer = useBlockStreaming
        ? new BlockStreamer({
            minChars: this.config.blockStreamingChunk?.minChars ?? 400,
            maxChars: this.config.blockStreamingChunk?.maxChars ?? 1000,
            idleMs: this.config.blockStreamingCoalesce?.idleMs ?? 1500,
            send: (text) => this.sendMessage(envelope.chatId, text),
          })
        : null;

      const onChunk = (sid: string, chunk: string) => {
        if (sid === sessionId) {
          this.onResponseChunk(envelope.chatId, chunk, sessionId);
          streamer?.push(chunk);
        }
      };
      this.bridge.on('textChunk', onChunk);

      try {
        const response = await this.bridge.prompt(sessionId, promptText, {
          imageBase64,
          imageMimeType,
        });

        // If cancelled (steer mode), skip sending the response
        if (!promptState.cancelled && response) {
          if (streamer) {
            await streamer.flush();
          } else {
            await this.onResponseComplete(envelope.chatId, response, sessionId);
          }
        }
      } finally {
        this.bridge.off('textChunk', onChunk);
        this.onPromptEnd(envelope.chatId, sessionId, envelope.messageId);
        this.activePrompts.delete(sessionId);
        // Signal any steer waiter that we're done
        promptState.resolve();

        // Drain collect buffer if any messages accumulated
        const buffer = this.collectBuffers.get(sessionId);
        if (buffer && buffer.length > 0) {
          this.collectBuffers.delete(sessionId);
          const coalesced = buffer.map((b) => b.text).join('\n\n');
          const lastEnvelope = buffer[buffer.length - 1]!.envelope;
          // Re-enter handleInbound with the coalesced message
          const syntheticEnvelope: Envelope = {
            ...lastEnvelope,
            text: coalesced,
            // Clear attachments/references — already resolved in original text
            referencedText: undefined,
            attachments: undefined,
            imageBase64: undefined,
            imageMimeType: undefined,
          };
          // Queue the coalesced prompt (don't await to avoid deadlock on the queue)
          this.handleInbound(syntheticEnvelope).catch(() => {});
        }
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
