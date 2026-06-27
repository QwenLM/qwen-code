import { basename } from 'node:path';
import type { ChannelConfig, DispatchMode, Envelope } from './types.js';
import { BlockStreamer } from './BlockStreamer.js';
import { GroupGate } from './GroupGate.js';
import { SenderGate } from './SenderGate.js';
import { PairingStore } from './PairingStore.js';
import { SessionRouter } from './SessionRouter.js';
import { sanitizeSenderName } from './sanitize.js';
import type { AcpBridge, ToolCallEvent } from './AcpBridge.js';

export interface ChannelBaseOptions {
  router?: SessionRouter;
  proxy?: string;
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
  /** Resolved proxy URL, available to subclasses for adapter-specific clients. */
  protected proxy?: string;
  private instructedSessions: Set<string> = new Set();
  private commands: Map<string, CommandHandler> = new Map();
  /** Per-session promise chain to serialize prompt + send (followup mode). */
  private sessionQueues: Map<string, Promise<void>> = new Map();
  /**
   * Per-session generation, bumped by /clear. A queued followup turn captures the
   * generation when it enqueues and bails if /clear bumped it before the turn ran,
   * so a cleared session can't be resurrected by an already-queued prompt.
   */
  private sessionGenerations: Map<string, number> = new Map();

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
    this.proxy = options?.proxy;

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
    const doClear = async (envelope: Envelope): Promise<void> => {
      const removedIds = this.router.removeSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
        envelope.threadId,
      );
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          // Bump the generation up-front (before any await) so a followup turn
          // already queued onto this session sees a stale generation and bails
          // instead of running bridge.prompt() against the cleared session.
          this.sessionGenerations.set(
            id,
            (this.sessionGenerations.get(id) ?? 0) + 1,
          );
          // Cancel an in-flight turn (and drop its buffered follow-ups) before
          // purging, so a running prompt can't deliver a stale response into —
          // or resurrect via collect-drain — the just-cleared session.
          const active = this.activePrompts.get(id);
          this.collectBuffers.delete(id);
          if (active) {
            active.cancelled = true;
            await this.bridge.cancelSession(id).catch(() => {});
            await active.done;
          }
          // Purge every per-session map (all keyed by sessionId) so a
          // long-running gateway doesn't leak dead entries after /clear.
          // sessionGenerations is intentionally kept: a still-queued turn needs
          // to read the bumped value to detect that it's stale.
          this.instructedSessions.delete(id);
          this.sessionQueues.delete(id);
          this.activePrompts.delete(id);
        }
        await this.sendMessage(
          envelope.chatId,
          'Session cleared. The next message starts a fresh conversation.',
        );
      } else {
        await this.sendMessage(envelope.chatId, 'No active session to clear.');
      }
    };

    const isSharedGroupSession = (envelope: Envelope): boolean =>
      envelope.isGroup && this.config.sessionScope === 'thread';

    // In a thread-scoped group the session is shared, so clearing it affects
    // everyone: restrict it to authorized senders (config.allowedUsers, when
    // set) and require an explicit "confirm". DMs and per-user groups clear
    // directly — there /clear only touches the caller's own session.
    const clearHandler: CommandHandler = async (envelope, args) => {
      if (isSharedGroupSession(envelope)) {
        const authorized = this.config.allowedUsers;
        if (authorized.length > 0 && !authorized.includes(envelope.senderId)) {
          await this.sendMessage(
            envelope.chatId,
            'Only authorized members can clear this group session.',
          );
          return true;
        }
        if (args.toLowerCase() !== 'confirm') {
          await this.sendMessage(
            envelope.chatId,
            'This clears the shared session for everyone in this group. Re-send with "confirm" (e.g. /clear confirm) to proceed.',
          );
          return true;
        }
      }
      await doClear(envelope);
      return true;
    };

    this.registerCommand('clear', clearHandler);
    this.registerCommand('reset', clearHandler);
    this.registerCommand('new', clearHandler);

    // Read-only: report the current (possibly group-shared) session and workspace.
    this.registerCommand('who', async (envelope) => {
      const active = this.router.hasSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
        envelope.threadId,
      );
      const scopeNote = envelope.isGroup
        ? isSharedGroupSession(envelope)
          ? ' (shared by this group)'
          : ' (private to you)'
        : '';
      await this.sendMessage(
        envelope.chatId,
        [
          `Channel: ${this.name}`,
          // Only the basename — don't leak the absolute cwd to group members.
          `Workspace: ${basename(this.config.cwd)}`,
          `Session: ${active ? 'active' : 'none'}${scopeNote}`,
        ].join('\n'),
      );
      return true;
    });

    this.registerCommand('help', async (envelope) => {
      const lines = [
        'Commands:',
        '/help — Show this help',
        isSharedGroupSession(envelope)
          ? '/clear confirm — Clear the shared group session (aliases: /reset, /new)'
          : '/clear — Clear your session (aliases: /reset, /new)',
        '/who — Show current session & workspace',
        '/status — Show session info',
      ];

      // Platform-specific commands (registered by adapters, not shared ones)
      const sharedCmds = new Set([
        'help',
        'clear',
        'reset',
        'new',
        'who',
        'status',
      ]);
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
        envelope.threadId,
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
    // Handle /command@botname format (Telegram groups). The token allows `-` and
    // `:` so hyphenated and namespaced agent commands (e.g. /compress-fast,
    // /git:commit) still parse as commands rather than being treated as text.
    const match = text.match(/^\/([a-zA-Z0-9_:-]+)(?:@\S+)?\s*(.*)/s);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  /**
   * Whether `text` is a real slash command rather than prose that merely starts
   * with `/`. Mirrors the CLI's classifier (cli `ui/utils/commandUtils.ts`
   * `isSlashCommand`): a command is `/<name>[ args]` whose first whitespace-
   * delimited token is non-empty and free of path separators, and is not a `//`
   * line comment or `/*` block comment. The CLI sends slash-prefixed paths
   * (`/tmp/foo`), comments and a bare `/` to the model as prose, so a group must
   * still attribute them. Purely lexical — never consults the async command
   * list, so it can't race a fresh session.
   */
  private isSlashCommand(text: string): boolean {
    const trimmed = text.trim();
    if (
      !trimmed.startsWith('/') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*')
    ) {
      return false;
    }
    const firstToken = trimmed.slice(1).trimStart().split(/\s+/u)[0] ?? '';
    return firstToken.length > 0 && !/[/\\]/.test(firstToken);
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

    // 3.5. Bang (!) shell command — direct execution, no LLM
    if (envelope.text.startsWith('!')) {
      const cmd = envelope.text.slice(1).trim();
      const bridgeShellCommand = (
        this.bridge as unknown as Record<string, unknown>
      )['shellCommand'];
      if (cmd && typeof bridgeShellCommand === 'function') {
        try {
          const result = (await bridgeShellCommand(sessionId, cmd)) as {
            exitCode: number | null;
            output: string;
            aborted: boolean;
          };
          const longestRun = Math.max(
            0,
            ...Array.from(
              (result.output || '').matchAll(/`+/g),
              (m) => m[0].length,
            ),
          );
          const fence = '`'.repeat(Math.max(3, longestRun + 1));
          const output = result.output
            ? `${fence}\n${result.output}\n${fence}`
            : '(no output)';
          const exitLine =
            result.exitCode !== null && result.exitCode !== 0
              ? `\nExit code: ${result.exitCode}`
              : '';
          await this.sendMessage(
            envelope.chatId,
            `$ ${cmd}\n${output}${exitLine}`,
          );
        } catch (error) {
          await this.sendMessage(
            envelope.chatId,
            `Shell command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
    }

    // Prepend referenced (quoted) message text for reply context
    let promptText = envelope.text;

    // Multiplayer attribution: in a group, tag each turn with the speaker so a
    // shared session can tell members apart. Sanitize the name so a crafted nick
    // can't break out of the [..] tag or inject newlines. Skipped for 1:1 chats
    // and for already-prefixed re-entries (collect-mode coalescing). Real slash
    // commands are also passed through verbatim — a [sender] prefix would stop
    // them from parsing — but only genuine command shapes (isSlashCommand, which
    // mirrors the CLI's classifier). Slash-prefixed paths (/tmp/foo) and comments
    // (//…, /*…*/) are prose to the CLI, so they still get attributed. The check
    // is purely lexical, so it never races the async command list.
    if (
      envelope.isGroup &&
      !envelope.alreadyPrefixed &&
      !this.isSlashCommand(envelope.text)
    ) {
      const who = sanitizeSenderName(
        envelope.senderName || envelope.senderId || 'unknown',
      );
      promptText = `[${who}] ${promptText}`;
    }

    if (envelope.referencedText) {
      // Quoted text is attacker-controlled: strip control chars and cap length so
      // it can't inject newlines/instructions or balloon the prompt.
      const quoted = envelope.referencedText
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        // Also strip the wrapper's own delimiters so a crafted quote (e.g.
        // `"] [SYSTEM] ...`) can't close [Replying to: "..."] and inject its
        // own top-level instructions.
        .replace(/["[\]]/g, ' ')
        .slice(0, 500);
      promptText = `[Replying to: "${quoted}"]\n\n${promptText}`;
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
    // Snapshot the session generation now (at enqueue time). If /clear bumps it
    // before this turn dequeues, the session we captured is gone — bail rather
    // than resurrect it.
    const generation = this.sessionGenerations.get(sessionId) ?? 0;
    const useBlockStreaming = this.config.blockStreaming === 'on';
    const current = prev.then(async () => {
      // A /clear (or reset/new) while we were queued bumps the generation; the
      // captured session is cleared, so don't run the prompt against it.
      if ((this.sessionGenerations.get(sessionId) ?? 0) !== generation) {
        return;
      }
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
          const lost = buffer.length;
          const coalesced = buffer.map((b) => b.text).join('\n\n');
          const lastEnvelope = buffer[buffer.length - 1]!.envelope;
          // Re-enter handleInbound with the coalesced message
          const syntheticEnvelope: Envelope = {
            ...lastEnvelope,
            text: coalesced,
            // Coalesced text already carries each message's [sender] prefix.
            alreadyPrefixed: true,
            // Clear attachments/references — already resolved in original text
            referencedText: undefined,
            attachments: undefined,
            imageBase64: undefined,
            imageMimeType: undefined,
          };
          // Queue the coalesced prompt (don't await to avoid deadlock on the queue).
          // Surface a drain failure instead of silently losing buffered turns.
          this.handleInbound(syntheticEnvelope).catch((err) => {
            process.stderr.write(
              `[${this.name}] dropped ${lost} buffered message(s) on collect re-entry for session ${sessionId} (last sender ${lastEnvelope.senderId}): ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          });
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
