import { basename } from 'node:path';
import type { ChannelConfig, DispatchMode, Envelope } from './types.js';
import { BlockStreamer } from './BlockStreamer.js';
import { GroupGate } from './GroupGate.js';
import { SenderGate } from './SenderGate.js';
import { PairingStore } from './PairingStore.js';
import { SessionRouter } from './SessionRouter.js';
import {
  sanitizeSenderName,
  sanitizeQuotedText,
  sanitizePromptPath,
} from './sanitize.js';
import type { AcpBridge, ToolCallEvent } from './AcpBridge.js';

/**
 * Max time /clear waits for a cancelled in-flight turn to wind down before
 * purging anyway. A wedged ACP child (stuck tool call, not reading stdin, or
 * crashed without closing) can leave active.done unresolved forever; without
 * this bound /clear — and the whole channel — would hang. Safe because the
 * purge runs regardless and the generation is bumped, so a turn that settles
 * later is already invalidated.
 */
export const CLEAR_CANCEL_TIMEOUT_MS = 3000;

export interface ChannelBaseOptions {
  router?: SessionRouter;
  proxy?: string;
}

/** Handler for a slash command. Return true if handled, false to forward to agent. */
type CommandHandler = (envelope: Envelope, args: string) => Promise<boolean>;
type ActivePrompt = {
  cancelled: boolean;
  cancelRequested?: Promise<boolean>;
  done: Promise<void>;
  resolve: () => void;
  stopStreaming?: () => void;
  /** The originating turn's chat/message, so a clear-time eviction can run this
   * turn's own onPromptEnd (its finally may settle long after — or never). */
  chatId: string;
  messageId?: string;
  /**
   * Set when /clear's bounded wait times out and evicts this (wedged) turn. /clear
   * has NO replacement turn, so it runs this turn's onPromptEnd at eviction time,
   * and the late-settling finally then skips it (via the clearEvicted guard) so a
   * turn the user started AFTER the clear can't have its working indicator
   * clobbered.
   */
  clearEvicted?: boolean;
};

/**
 * Character class (sans the enclosing `[]`) for a slash-command token: alphanumerics
 * plus `_`, `:` and `-`, so hyphenated and namespaced agent commands (e.g.
 * `/compress-fast`, `/git:commit`) parse as commands. Shared by parseCommand and
 * isSlashCommand below so the two classifiers can't drift apart.
 */
const COMMAND_TOKEN_CHARS = 'a-zA-Z0-9_:-';
/** parseCommand: capture the leading `/command` token (+ optional `@botname`) and the rest as args. */
const PARSE_COMMAND_RE = new RegExp(
  `^\\/([${COMMAND_TOKEN_CHARS}]+)(?:@\\S+)?\\s*(.*)`,
  's',
);
/** isSlashCommand: the first whitespace-delimited token alone must be a pure command token. */
const COMMAND_TOKEN_RE = new RegExp(`^[${COMMAND_TOKEN_CHARS}]+(?:@\\S+)?$`);

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
  private activePrompts: Map<string, ActivePrompt> = new Map();
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

  protected registerCancelCommand(name = 'cancel'): void {
    this.registerCommand(name, async (envelope) => {
      const activeSessionId = this.findActiveSessionId(envelope);
      if (!activeSessionId) {
        await this.sendMessage(
          envelope.chatId,
          'No request is currently running.',
        );
        return true;
      }

      const active = this.activePrompts.get(activeSessionId);
      if (!active) {
        await this.sendMessage(
          envelope.chatId,
          'No request is currently running.',
        );
        return true;
      }

      const cancelRequested =
        active.cancelRequested ??
        this.bridge.cancelSession(activeSessionId).then(
          () => true,
          (err) => {
            process.stderr.write(
              `[${this.name}] cancelSession failed for session=${activeSessionId}: ${err instanceof Error ? err.message : err}\n`,
            );
            active.cancelRequested = undefined;
            return false;
          },
        );
      active.cancelRequested = cancelRequested;

      const cancelSucceeded = await cancelRequested;
      if (!cancelSucceeded) {
        await this.sendMessage(
          envelope.chatId,
          'Failed to cancel current request.',
        );
        return true;
      }

      active.cancelled = true;
      active.stopStreaming?.();
      this.collectBuffers.delete(activeSessionId);
      await this.sendMessage(envelope.chatId, 'Cancelled current request.');
      return true;
    });
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
            // Bounded cancel + wind-down wait; purge regardless of the result.
            const settled = await this.cancelAndAwaitActive(active, id);
            if (!settled) {
              // Wedged: the turn never wound down within the bound. Surface it —
              // otherwise a zombie bridge.prompt() lingers in the child with zero
              // observability ("/clear worked" but a turn is still pinned).
              process.stderr.write(
                `[${this.name}] /clear abandoned a wedged turn for session ${id}: it did not wind down within ${CLEAR_CANCEL_TIMEOUT_MS}ms\n`,
              );
              // The wedged turn's finally may run much later (or never), so clean
              // up its OWN platform indicator now, while no replacement exists yet.
              // Mark it clearEvicted so that late finally skips onPromptEnd — a turn
              // the user starts after this /clear owns the chat indicator by then,
              // and re-running cleanup would clobber it.
              this.onPromptEnd(active.chatId, id, active.messageId);
              active.clearEvicted = true;
            }
          }
          // Purge every per-session map (all keyed by sessionId) so a
          // long-running gateway doesn't leak dead entries after /clear.
          this.instructedSessions.delete(id);
          // The queue's tail resolves only after every turn queued before this
          // /clear has dequeued and bailed on the bumped generation. Capture it
          // before deletion so we can reclaim sessionGenerations[id] once it
          // drains — otherwise the bumped entry leaks for the gateway's lifetime.
          const drained = this.sessionQueues.get(id);
          const bumpedGeneration = this.sessionGenerations.get(id);
          this.sessionQueues.delete(id);
          this.activePrompts.delete(id);
          if (drained) {
            // Deferred, never awaited: a wedged turn that never drains must not
            // block /clear (the entry just lingers, as before). The guards skip
            // reclamation if a newer turn re-queued onto this id or another
            // /clear re-bumped it, so an entry a queued turn still needs is never
            // deleted out from under it.
            void drained.then(() => {
              if (
                !this.sessionQueues.has(id) &&
                this.sessionGenerations.get(id) === bumpedGeneration
              ) {
                this.sessionGenerations.delete(id);
              }
            });
          } else {
            // Nothing was ever queued for this session, so no turn can read the
            // bumped value — reclaim it immediately.
            this.sessionGenerations.delete(id);
          }
        }
        await this.sendMessage(
          envelope.chatId,
          'Session cleared. The next message starts a fresh conversation.',
        );
      } else {
        await this.sendMessage(envelope.chatId, 'No active session to clear.');
      }
    };

    // For a shared session, clearing it affects everyone who shares it: restrict
    // it to authorized senders (config.allowedUsers, when set) and require an
    // explicit "confirm". DMs on per-user/thread scope and per-user groups clear
    // directly — there /clear only touches the caller's own session.
    const clearHandler: CommandHandler = async (envelope, args) => {
      if (this.isSharedSession(envelope)) {
        const authorized = this.config.allowedUsers;
        if (authorized.length > 0 && !authorized.includes(envelope.senderId)) {
          await this.sendMessage(
            envelope.chatId,
            'Only authorized members can clear this shared session.',
          );
          return true;
        }
        if (args.toLowerCase() !== 'confirm') {
          await this.sendMessage(
            envelope.chatId,
            'This clears the shared session for everyone who shares it. Re-send with "confirm" (e.g. /clear confirm) to proceed.',
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
    // For a shared session, gate it to authorized senders like /clear — /who
    // leaks the workspace basename, so non-members shouldn't see it either.
    this.registerCommand('who', async (envelope) => {
      if (this.isSharedSession(envelope)) {
        const authorized = this.config.allowedUsers;
        if (authorized.length > 0 && !authorized.includes(envelope.senderId)) {
          await this.sendMessage(
            envelope.chatId,
            'Only authorized members can view this shared session.',
          );
          return true;
        }
      }
      const active = this.router.hasSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
        envelope.threadId,
      );
      // `single` collapses EVERY DM and group to one `__single__` session, so it
      // is shared channel-wide regardless of where the /who came from — report
      // that explicitly (a group `single` session understates its blast radius as
      // "shared by this group"). Other scopes keep their existing wording.
      const scopeNote =
        this.config.sessionScope === 'single'
          ? ' (shared channel-wide)'
          : this.isSharedSession(envelope)
            ? envelope.isGroup
              ? ' (shared by this group)'
              : ''
            : envelope.isGroup
              ? ' (private to you)'
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
        this.isSharedSession(envelope)
          ? '/clear confirm — Clear the shared session (aliases: /reset, /new)'
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

  private findActiveSessionId(envelope: Envelope): string | undefined {
    const sessionId = this.router.getSession(
      this.name,
      envelope.senderId,
      envelope.chatId,
      envelope.threadId,
    );
    return sessionId && this.activePrompts.has(sessionId)
      ? sessionId
      : undefined;
  }

  /**
   * Whether the resolved session is SHARED across senders. `single` collapses
   * the whole channel to one `__single__` session for EVERY sender — group OR
   * DM — so it is ALWAYS shared (even a DM maps to `__single__`). `thread` is
   * shared only in a group (a DM maps to the lone caller's own chat). `user` is
   * per-sender, never shared. Drives both the destructive-/clear confirm gate
   * and the host-shell (`!`) gate.
   */
  private isSharedSession(envelope: Envelope): boolean {
    return (
      this.config.sessionScope === 'single' ||
      (envelope.isGroup && this.config.sessionScope === 'thread')
    );
  }

  /**
   * Cancel the active turn and wait (bounded) for it to wind down. Stops the
   * BlockStreamer so buffered text can't leak via the idle timer, then fires a
   * best-effort cancelSession (NOT awaited — a wedged child/daemon can leave the
   * request pending forever). Returns true if active.done settled first, false
   * if the CLEAR_CANCEL_TIMEOUT_MS bound won (the turn never wound down). Used by
   * /clear, which genuinely EVICTS the session and so must proceed even when the
   * turn is wedged. Steer no longer uses this: it best-effort cancels then chains
   * the new turn behind the old one (see handleInbound), so it never needs to
   * proceed past a still-active turn.
   */
  private async cancelAndAwaitActive(
    active: ActivePrompt,
    sessionId: string,
  ): Promise<boolean> {
    active.cancelled = true;
    active.stopStreaming?.();
    void this.bridge.cancelSession(sessionId).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      active.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLEAR_CANCEL_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    return settled;
  }

  /**
   * Parse a slash command from message text.
   * Returns { command, args } or null if not a slash command.
   */
  private parseCommand(text: string): { command: string; args: string } | null {
    // Trim first so a leading-whitespace slash command (common from IME /
    // copy-paste, e.g. " /help") parses, and so this agrees with isSlashCommand
    // (which already trims). Otherwise isSlashCommand suppresses the [sender] tag
    // while parseCommand returns null, leaking the command to the agent unattributed.
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    // Handle /command@botname format (Telegram groups). The token allows `-` and
    // `:` so hyphenated and namespaced agent commands (e.g. /compress-fast,
    // /git:commit) still parse as commands rather than being treated as text
    // (charset shared with isSlashCommand via PARSE_COMMAND_RE).
    const match = trimmed.match(PARSE_COMMAND_RE);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  /**
   * Whether `text` is a real slash command rather than prose that merely starts
   * with `/`. A command's first whitespace-delimited token must match
   * parseCommand()'s charset — `[a-zA-Z0-9_:-]+`, plus an optional `@botname`
   * suffix — and not be a `//` line comment or `/*` block comment. Slash-prefixed
   * paths (`/tmp/foo`), comments, and a bare `/` are prose and keep their
   * `[sender]` tag.
   *
   * Intentionally stricter than the CLI's looser classifier (cli
   * `ui/utils/commandUtils.ts`), which forwards any non-comment, non-path
   * `/<token>` (e.g. `/café`, a zero-width-laden token). Such inputs aren't
   * runnable commands, and in a SHARED group session forwarding them unattributed
   * is worse than a redundant tag — so anything off the command charset is
   * treated as prose and keeps its `[sender]` tag. Purely lexical — never
   * consults the async command list, so it can't race a fresh session.
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
    // No trimStart: the token must immediately follow `/`. A space after the
    // slash (`/ foo`) makes split()[0] empty, so this returns false — matching
    // parseCommand, whose regex also requires the token right after `/`. If they
    // diverged, `/ foo` in a shared group session would suppress the [sender] tag
    // (isSlashCommand true) yet run no command (parseCommand null), reaching the
    // agent unattributed.
    const firstToken = trimmed.slice(1).split(/\s+/u)[0] ?? '';
    return COMMAND_TOKEN_RE.test(firstToken);
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

    // 3.5. Bang (!) shell command — refuse outside a private 1:1 chat BEFORE
    // resolving a session, so a refused command never creates or persists one.
    // Phase 0 has no per-sender trust model (the [sender] marker is NOT a trust
    // boundary). Any group is multi-operator — even a user-scope group, which is
    // NOT a "shared session" — so an allowed member could `!rm -rf /` the host.
    if (envelope.text.startsWith('!')) {
      if (envelope.isGroup) {
        await this.sendMessage(
          envelope.chatId,
          'Shell commands (`!`) are disabled in group chats.',
        );
        return;
      }
      // A single-scope DM collapses every DM to one channel-wide session, so it
      // is multi-operator too despite not being a group.
      if (this.isSharedSession(envelope)) {
        await this.sendMessage(
          envelope.chatId,
          'Shell commands (`!`) are disabled in shared sessions.',
        );
        return;
      }
    }

    const sessionId = await this.router.resolve(
      this.name,
      envelope.senderId,
      envelope.chatId,
      envelope.threadId,
      this.config.cwd,
    );

    // Bang (!) execution — a private 1:1 session has a single operator, so
    // direct shell execution stays allowed. Group/shared contexts were refused
    // above, before the session was resolved.
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

    // Multiplayer attribution: when a session can carry multiple humans, tag each
    // turn with the speaker so the agent can tell members apart. That is any group
    // AND any single-scope DM — `single` collapses every sender's DM into one
    // __single__ session (the same multi-operator case the !-gate, /clear confirm
    // and /who already treat as shared), so without a tag it would merge different
    // people into one unattributed conversation. NOT gated on isSharedSession:
    // that is false for a user-scope GROUP, which still needs attribution. Sanitize
    // the name so a crafted nick can't break out of the [..] tag or inject
    // newlines. Skipped for a per-user 1:1 chat and for already-prefixed re-entries
    // (collect-mode coalescing). Real slash commands are also passed through
    // verbatim — a [sender] prefix would stop them from parsing — but only genuine
    // command shapes (isSlashCommand, which mirrors the CLI's classifier).
    // Slash-prefixed paths (/tmp/foo) and comments (//…, /*…*/) are prose to the
    // CLI, so they still get attributed. The check is purely lexical, so it never
    // races the async command list.
    if (
      (envelope.isGroup || this.config.sessionScope === 'single') &&
      !envelope.alreadyPrefixed &&
      !this.isSlashCommand(envelope.text)
    ) {
      const who = sanitizeSenderName(
        envelope.senderName || envelope.senderId || 'unknown',
      );
      promptText = `[${who}] ${promptText}`;
    }

    if (envelope.referencedText) {
      // Quoted text is attacker-controlled. sanitizeQuotedText strips C0/DEL
      // controls, Unicode line/paragraph separators (U+2028/U+2029) and bidi
      // overrides, and the wrapper's own `"[]` delimiters, then caps length -
      // so a crafted quote can't inject newlines/instructions, close the
      // [Replying to: "..."] wrapper, flip text direction, or balloon the prompt.
      const quoted = sanitizeQuotedText(envelope.referencedText, 500);
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
          // The filename is attacker-supplied (e.g. DingTalk), so neutralize both
          // the human-readable label and the on-disk path as they enter the
          // prompt. They need DIFFERENT rules: the quoted fileName label is just
          // prose, so sanitizeQuotedText (which also strips `"[]`) is fine — but
          // the rendered filePath must stay byte-resolvable. Brackets, quotes and
          // spaces are VALID, common path chars (e.g. `app/[slug]/page.tsx`), so
          // stripping them would advertise a path that doesn't exist on disk and
          // break the agent's read-file tool. sanitizePromptPath preserves them
          // and removes ONLY what could break/reorder the `saved to:` line
          // (CR/LF, C0/DEL, Unicode line/para separators, bidi overrides).
          const name = att.fileName
            ? ` "${sanitizeQuotedText(att.fileName, 128)}"`
            : '';
          const renderedPath = sanitizePromptPath(att.filePath);
          filePaths.push(
            `User sent a ${label}${name}. It has been saved to: ${renderedPath}`,
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
          // Best-effort cancel the running turn so it winds down sooner, then fall
          // through to CHAIN this new turn onto the session queue tail (see `prev`
          // below). The new turn therefore runs ONLY AFTER the old turn's finally
          // has actually run — onChunk detached, activePrompts cleared, indicator
          // released — so it never executes concurrently with the turn it
          // supersedes.
          //
          // We deliberately do NOT race a bounded wait and then proceed with a
          // replacement bridge.prompt() while the old turn is still active: both
          // bridges key active-prompt tracking AND streamed chunks by sessionId
          // alone, so a concurrent replacement on one session is bridge-unsafe —
          // DaemonChannelBridge.prompt() rejects while the prior prompt is still
          // active (the replacement is silently dropped), and the abandoned turn's
          // late chunks mix into the replacement's stream (duplicated/stale
          // output). So a genuinely wedged turn makes its successor WAIT rather
          // than be force-interrupted. Turn-scoped cancellation/routing (a new
          // turn that runs without waiting for a wedged predecessor) is the
          // deferred fix — it needs an API change across every adapter and is out
          // of scope for this phase (wenshao option (b)).
          active.cancelled = true;
          active.stopStreaming?.();
          void this.bridge.cancelSession(sessionId).catch(() => {});
          // Prepend a cancellation note so the agent understands context.
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

    // Run the prompt with per-session serialization. followup AND steer both chain
    // onto the existing queue tail; steer additionally best-effort cancelled the
    // running turn above so the tail resolves sooner. Chaining (rather than seeding
    // a fresh Promise.resolve()) is what guarantees this turn never runs while the
    // turn it supersedes is still active — see the steer branch above.
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    // Snapshot the session generation at enqueue time to guard against a /clear
    // racing this turn. There is no await between reading `active` above and this
    // snapshot, so the capture is atomic with the enqueue; if /clear bumps the
    // generation before this turn dequeues, the session we captured is gone — bail
    // (at the dequeue guard below) rather than resurrect it.
    const generation = this.sessionGenerations.get(sessionId) ?? 0;
    const useBlockStreaming = this.config.blockStreaming === 'on';
    const current = prev.then(async () => {
      // A /clear (or reset/new) while we were queued bumps the generation; the
      // captured session is cleared, so don't run the prompt against it.
      if ((this.sessionGenerations.get(sessionId) ?? 0) !== generation) {
        // Surface the drop — otherwise an unanswered queued message vanishes
        // silently, making "my message was never answered" undiagnosable.
        // envelope.text is attacker-controlled: render newline visibly, then strip
        // the remaining control chars (CR could overwrite the log line, ESC could
        // inject ANSI/OSC sequences) before they reach an operator's terminal —
        // matching the C0/DEL neutralization every other embed path does.
        const loggedText = envelope.text
          .slice(0, 80)
          .replace(/\n/g, '\\n')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]/g, ' ');
        process.stderr.write(
          `[${this.name}] dropped queued turn from ${envelope.senderId} for session ${sessionId}: session was cleared before it ran (text: ${loggedText})\n`,
        );
        return;
      }
      // Register this prompt as active
      let doneResolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        doneResolve = r;
      });
      const promptState: ActivePrompt = {
        cancelled: false,
        done,
        resolve: doneResolve,
        chatId: envelope.chatId,
        messageId: envelope.messageId,
      };
      // This turn is now the single owner of the session's active-prompt slot.
      // (Steer no longer hands a still-active session to a replacement; only
      // /clear evicts, and it gives the next turn a fresh session.)
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
      promptState.stopStreaming = () => streamer?.stop();

      const onChunk = (sid: string, chunk: string) => {
        if (sid === sessionId && !promptState.cancelled) {
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

        if (promptState.cancelRequested && !promptState.cancelled) {
          promptState.cancelled = await promptState.cancelRequested;
        }

        // If cancelled, skip sending the response
        if (!promptState.cancelled && response) {
          if (streamer) {
            await streamer.flush();
          } else {
            await this.onResponseComplete(envelope.chatId, response, sessionId);
          }
        }
      } finally {
        this.bridge.off('textChunk', onChunk);
        streamer?.stop();
        // Identity guard: a turn that wedged past /clear's bounded wait gets
        // EVICTED — /clear gives up on active.done, deletes activePrompts, and a
        // turn the user starts AFTER the clear can re-seed activePrompts (and own
        // the collect buffer) for this session. When the wedged bridge.prompt
        // finally settles and runs this finally, touching session-visible state
        // would clobber that live later turn — ending the working indicator it
        // re-seeded or draining a buffer it owns. So only touch session-scoped
        // state when the entry is still ours. (Steer no longer evicts: it cancels
        // and waits, so a steered turn is always stillCurrent when it completes.)
        const stillCurrent = this.activePrompts.get(sessionId) === promptState;
        // onPromptEnd runs platform cleanup (clear the typing interval, recall the
        // working reaction, finalize the card). Run it UNLESS this turn was a
        // /clear eviction (clearEvicted): /clear already ran this turn's onPromptEnd
        // at clear-time, and a turn the user started after the clear may now own the
        // chat-scoped indicator, so re-running cleanup here would clobber it. A
        // still-current turn (normal completion — which now includes every steered
        // turn) always cleans up.
        if (stillCurrent || !promptState.clearEvicted) {
          this.onPromptEnd(envelope.chatId, sessionId, envelope.messageId);
        }
        if (stillCurrent) {
          this.activePrompts.delete(sessionId);
        }
        // Signal any /clear waiter racing our done that we're done — even a
        // /clear-evicted wedged turn must release it (its bounded wait already
        // timed out). (Steer no longer waits on done; it chains on the queue tail.)
        promptState.resolve();

        // Drain collect buffer if any messages accumulated — but only while we're
        // still the active turn, so a /clear-evicted wedged turn whose bridge.prompt
        // settles late can't drain a buffer a later turn now owns. (Belt-and-
        // suspenders: /clear already deletes the buffer on eviction, so this guard
        // is defensive — but it keeps the invariant "only the current turn drains".)
        const buffer = this.collectBuffers.get(sessionId);
        if (stillCurrent && buffer && buffer.length > 0) {
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
