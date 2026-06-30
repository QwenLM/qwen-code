import { basename } from 'node:path';
import type {
  ChannelConfig,
  DispatchMode,
  Envelope,
  SessionTarget,
} from './types.js';
import { BlockStreamer } from './BlockStreamer.js';
import { GroupGate } from './GroupGate.js';
import { SenderGate } from './SenderGate.js';
import { PairingStore } from './PairingStore.js';
import { SessionRouter } from './SessionRouter.js';
import {
  sanitizeSenderName,
  sanitizeQuotedText,
  sanitizePromptText,
  sanitizePromptPath,
  sanitizeLogText,
} from './sanitize.js';
import type {
  AvailableCommand,
  ChannelAgentBridge,
  SessionDiedEvent,
  ToolCallEvent,
} from './ChannelAgentBridge.js';
import type {
  ChannelCronJob,
  ChannelCronJobInput,
} from './ChannelCronStore.js';

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
  /**
   * Set when a channel owns a supplied router and should consume bridge
   * events directly.
   */
  registerBridgeEvents?: boolean;
  scheduleController?: ChannelScheduleController;
}

export interface ChannelScheduleController {
  create(input: ChannelCronJobInput): Promise<ChannelCronJob>;
  createForTarget?(
    input: ChannelCronJobInput,
    maxEnabledJobs: number,
  ): Promise<ChannelCronJob | undefined>;
  listForTarget(
    channelName: string,
    target: SessionTarget,
  ): Promise<ChannelCronJob[]>;
  disable(id: string): Promise<boolean>;
  validateCron(cron: string): void;
}

export interface ChannelScheduledPromptOptions {
  timeoutMs?: number;
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
const SCHEDULE_ADD_RE = /^"([^"]+)"\s+(.+)$/su;
const MAX_SCHEDULE_JOBS_PER_TARGET = 10;
const MAX_SCHEDULE_PROMPT_CHARS = 4000;

/**
 * The command-providing surface of a bridge. AcpBridge runs a single agent and
 * exposes only the global `availableCommands` getter; DaemonChannelBridge keys
 * commands per session and ALSO exposes `getAvailableCommands(sessionId)`. Both
 * members are optional so any bridge type is checked STRUCTURALLY here instead of
 * through a blind `as unknown` cast — a future rename or return-type change then
 * fails to compile rather than breaking at runtime.
 */
interface AgentCommandsProvider {
  getAvailableCommands?: (sessionId: string) => AvailableCommand[];
  availableCommands?: AvailableCommand[];
}

function parseScheduleAddArgs(
  args: string,
): { cron: string; prompt: string } | null {
  const match = args.trim().match(SCHEDULE_ADD_RE);
  if (!match) return null;
  const cron = match[1].trim();
  const prompt = match[2].trim();
  return cron && prompt ? { cron, prompt } : null;
}

export abstract class ChannelBase {
  protected config: ChannelConfig;
  protected bridge: ChannelAgentBridge;
  protected groupGate: GroupGate;
  protected gate: SenderGate;
  protected router: SessionRouter;
  protected name: string;
  /** Resolved proxy URL, available to subclasses for adapter-specific clients. */
  protected proxy?: string;
  private readonly scheduleController?: ChannelScheduleController;
  private instructedSessions: Set<string> = new Set();
  private commands: Map<string, CommandHandler> = new Map();
  /** Per-session promise chain to serialize prompt + send (followup mode). */
  private sessionQueues: Map<string, Promise<void>> = new Map();
  private readonly registerBridgeEvents: boolean;
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
  private readonly bridgeToolCallListener = (event: ToolCallEvent): void => {
    const target = this.router.getTarget(event.sessionId);
    if (target) {
      this.onToolCall(target.chatId, event);
    }
  };
  private readonly bridgeSessionDiedListener = (
    event: SessionDiedEvent,
  ): void => {
    this.onSessionDied(event.sessionId);
  };

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    this.name = name;
    this.config = config;
    this.bridge = bridge;
    this.proxy = options?.proxy;
    this.scheduleController = options?.scheduleController;

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

    // When running standalone, register bridge listeners directly.
    // In gateway mode, the ChannelManager dispatches events instead.
    this.registerBridgeEvents =
      options?.registerBridgeEvents ?? !options?.router;
    if (this.registerBridgeEvents) {
      this.attachBridgeEvents(bridge);
    }
  }

  abstract connect(): Promise<void>;
  abstract sendMessage(chatId: string, text: string): Promise<void>;
  abstract disconnect(): void;

  supportsProactiveSend(): boolean {
    return false;
  }

  protected supportsProactiveTarget(target: SessionTarget): boolean {
    return target.threadId === undefined;
  }

  protected async pushProactive(
    target: SessionTarget,
    text: string,
  ): Promise<void> {
    if (target.threadId) {
      throw new Error(
        'Channel does not support proactive scheduled messages for threaded targets.',
      );
    }
    await this.sendMessage(target.chatId, text);
  }

  /** Replace the bridge instance (used after crash recovery restart). */
  setBridge(bridge: ChannelAgentBridge): void {
    if (this.registerBridgeEvents) {
      this.detachBridgeEvents(this.bridge);
    }
    this.router.setBridge(bridge);
    this.bridge = bridge;
    if (this.registerBridgeEvents) {
      this.attachBridgeEvents(bridge);
    }
  }

  async runScheduledPrompt(
    job: ChannelCronJob,
    options: ChannelScheduledPromptOptions = {},
  ): Promise<void> {
    if (!this.supportsProactiveSend()) {
      throw new Error('Channel does not support proactive scheduled messages.');
    }
    if (job.channelName !== this.name) {
      throw new Error(
        `Scheduled job ${job.id} belongs to ${job.channelName}, not ${this.name}.`,
      );
    }
    if (!this.supportsProactiveTarget(job.target)) {
      throw new Error(
        'Channel does not support proactive scheduled messages for this chat target.',
      );
    }
    if (!this.isStoredScheduleTargetAuthorized(job.target, job.createdBy)) {
      await this.scheduleController?.disable(job.id);
      throw new Error(
        `Scheduled job ${job.id} target is no longer authorized.`,
      );
    }

    const sessionId = await this.router.resolve(
      this.name,
      job.target.senderId,
      job.target.chatId,
      job.target.threadId,
      job.cwd,
    );
    const label = sanitizeQuotedText(job.label || job.id, 80);
    const createdBy = sanitizeSenderName(job.createdBy || 'unknown');
    let promptText = `[Scheduled task "${label}" set by ${createdBy}]\n\n${sanitizePromptText(job.prompt)}`;
    if (this.config.instructions && !this.instructedSessions.has(sessionId)) {
      promptText = `${this.config.instructions}\n\n${promptText}`;
      this.instructedSessions.add(sessionId);
    }

    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const generation = this.sessionGenerations.get(sessionId) ?? 0;
    const current = prev.then(async () => {
      if ((this.sessionGenerations.get(sessionId) ?? 0) !== generation) {
        process.stderr.write(
          `[${this.name}] dropped scheduled job ${job.id} for session ${sessionId}: session was cleared before it ran\n`,
        );
        return;
      }

      let doneResolve: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        doneResolve = resolve;
      });
      const promptState: ActivePrompt = {
        cancelled: false,
        done,
        resolve: doneResolve,
        chatId: job.target.chatId,
      };
      this.activePrompts.set(sessionId, promptState);
      this.onPromptStart(job.target.chatId, sessionId);

      const onChunk = (sid: string, chunk: string) => {
        if (sid === sessionId && !promptState.cancelled) {
          this.onResponseChunk(job.target.chatId, chunk, sessionId);
        }
      };
      const promptBridge = this.bridge;
      promptBridge.on('textChunk', onChunk);

      try {
        const response = await this.runScheduledBridgePrompt(
          promptBridge,
          sessionId,
          promptText,
          promptState,
          job.id,
          options.timeoutMs,
        );
        if (!promptState.cancelled && response) {
          await this.pushProactive(job.target, response);
        }
      } finally {
        promptBridge.off('textChunk', onChunk);
        const stillCurrent = this.activePrompts.get(sessionId) === promptState;
        if (!promptState.clearEvicted) {
          try {
            this.onPromptEnd(job.target.chatId, sessionId);
          } catch (err) {
            process.stderr.write(
              `[${this.name}] onPromptEnd threw in scheduled job ${job.id} for session ${sessionId}: ${err instanceof Error ? err.message : err}\n`,
            );
          }
        }
        if (stillCurrent) {
          this.activePrompts.delete(sessionId);
        }
        promptState.resolve();
        const buffer = this.collectBuffers.get(sessionId);
        if (stillCurrent && buffer && buffer.length > 0) {
          this.collectBuffers.delete(sessionId);
          const lost = buffer.length;
          const coalesced = buffer.map((b) => b.text).join('\n\n');
          const lastEnvelope = buffer[buffer.length - 1]!.envelope;
          const syntheticEnvelope: Envelope = {
            ...lastEnvelope,
            text: coalesced,
            alreadyPrefixed: true,
            referencedText: undefined,
            attachments: undefined,
            imageBase64: undefined,
            imageMimeType: undefined,
          };
          this.handleInbound(syntheticEnvelope).catch((err) => {
            process.stderr.write(
              `[${this.name}] dropped ${lost} buffered message(s) after scheduled job ${job.id} for session ${sessionId} (last sender ${lastEnvelope.senderId}): ${
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

  private async runScheduledBridgePrompt(
    promptBridge: ChannelAgentBridge,
    sessionId: string,
    promptText: string,
    promptState: ActivePrompt,
    jobId: string,
    timeoutMs: number | undefined,
  ): Promise<string> {
    const prompt = promptBridge.prompt(sessionId, promptText, {});
    if (timeoutMs === undefined) {
      return prompt;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        prompt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('scheduled job timed out'));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === 'scheduled job timed out') {
        promptState.cancelled = true;
        void promptBridge.cancelSession(sessionId).catch((cancelErr) => {
          process.stderr.write(
            `[${this.name}] cancelSession failed for timed out scheduled job ${jobId} in session ${sessionId}: ${
              cancelErr instanceof Error ? cancelErr.message : cancelErr
            }\n`,
          );
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  onToolCall(_chatId: string, _event: ToolCallEvent): void {}

  onSessionDied(sessionId: string): void {
    this.router.removeSessionId(sessionId);
    this.instructedSessions.delete(sessionId);
  }

  private attachBridgeEvents(bridge: ChannelAgentBridge): void {
    bridge.on('toolCall', this.bridgeToolCallListener);
    bridge.on('sessionDied', this.bridgeSessionDiedListener);
  }

  private detachBridgeEvents(bridge: ChannelAgentBridge): void {
    bridge.off('toolCall', this.bridgeToolCallListener);
    bridge.off('sessionDied', this.bridgeSessionDiedListener);
  }

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
      // /cancel aborts an in-flight turn — destructive in a shared session, where
      // it would otherwise let any member kill another user's running turn. Gate it
      // to authorized senders like /clear (auth gate only — no confirm step). A
      // non-shared (1:1) session is always authorized, so behavior is unchanged.
      if (!this.isAuthorizedForSharedSession(envelope)) {
        await this.sendMessage(
          envelope.chatId,
          'Only authorized members can cancel requests in this shared session.',
        );
        return true;
      }
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
          // Audit: clearing a SHARED session wipes the conversation for every
          // participant, so record who triggered it (sanitized display name +
          // stable senderId) and which session — mirrors the file's stderr audit
          // style. A 1:1 DM clear only touches the caller, so it isn't logged.
          if (this.isSharedSession(envelope)) {
            const who = sanitizeSenderName(
              envelope.senderName || envelope.senderId || 'unknown',
            );
            process.stderr.write(
              `[${this.name}] shared session ${id} cleared by ${who} (sender ${envelope.senderId})\n`,
            );
          }
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
              // Include the originating chat/message (sanitized — platform IDs can
              // be attacker-influenced) so oncall can correlate the wedged turn. Both
              // are read defensively (fallback / omitted) so a partial entry can't
              // crash /clear, the recovery path.
              const wedgedChat = active.chatId
                ? sanitizeLogText(active.chatId, 64)
                : 'unknown';
              const wedgedMessage = active.messageId
                ? `, message ${sanitizeLogText(active.messageId, 64)}`
                : '';
              process.stderr.write(
                `[${this.name}] /clear abandoned a wedged turn for session ${id} (chat ${wedgedChat}${wedgedMessage}): it did not wind down within ${CLEAR_CANCEL_TIMEOUT_MS}ms\n`,
              );
              // The wedged turn's finally may run much later (or never), so clean
              // up its OWN platform indicator now, while no replacement exists yet.
              // Mark it clearEvicted FIRST so the late finally skips onPromptEnd — a
              // turn the user starts after this /clear owns the chat indicator by
              // then, and re-running cleanup would clobber it.
              active.clearEvicted = true;
              // onPromptEnd runs adapter cleanup (platform API calls that can throw).
              // Swallow + audit any throw: an uncaught one would abort the purge
              // below, leaving this turn in activePrompts so its late finally sees it
              // as still-current (`stillCurrent || !clearEvicted`) and re-runs
              // onPromptEnd anyway. Letting the purge proceed makes the turn
              // non-current, so the clearEvicted guard then skips correctly.
              try {
                this.onPromptEnd(active.chatId, id, active.messageId);
              } catch (err) {
                process.stderr.write(
                  `[${this.name}] onPromptEnd threw during /clear eviction for session ${id}: ${err instanceof Error ? err.message : err}\n`,
                );
              }
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
      if (!this.isAuthorizedForSharedSession(envelope)) {
        await this.sendMessage(
          envelope.chatId,
          'Only authorized members can clear this shared session.',
        );
        return true;
      }
      if (this.isSharedSession(envelope) && args.toLowerCase() !== 'confirm') {
        await this.sendMessage(
          envelope.chatId,
          'This clears the shared session for everyone who shares it. Re-send with "confirm" (e.g. /clear confirm) to proceed.',
        );
        return true;
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
      if (!this.isAuthorizedForSharedSession(envelope)) {
        await this.sendMessage(
          envelope.chatId,
          'Only authorized members can view this shared session.',
        );
        return true;
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

      const sessionId = this.router.getSession(
        this.name,
        envelope.senderId,
        envelope.chatId,
        envelope.threadId,
      );
      const agentCommands = sessionId
        ? this.getAgentCommandsForSession(sessionId)
        : this.bridge.availableCommands;
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
      // For a shared session, gate it to authorized senders like /who — /status
      // reports session & access state, so non-members shouldn't read it either.
      if (!this.isAuthorizedForSharedSession(envelope)) {
        await this.sendMessage(
          envelope.chatId,
          'Only authorized members can view this shared session.',
        );
        return true;
      }
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

    this.registerCommand('schedule', async (envelope, args) =>
      this.handleScheduleCommand(envelope, args),
    );
  }

  private async handleScheduleCommand(
    envelope: Envelope,
    args: string,
  ): Promise<boolean> {
    if (!this.scheduleController) {
      await this.sendMessage(
        envelope.chatId,
        'Scheduled tasks are not available.',
      );
      return true;
    }
    if (!this.isAuthorizedForSharedSession(envelope)) {
      await this.sendMessage(
        envelope.chatId,
        'Only authorized members can use scheduled tasks in this shared session.',
      );
      return true;
    }

    const [subcommand = '', ...rest] = args.trim().split(/\s+/u);
    switch (subcommand.toLowerCase()) {
      case 'add':
        return this.handleScheduleAdd(envelope, rest.join(' '));
      case 'list':
        return this.handleScheduleList(envelope);
      case 'cancel':
        return this.handleScheduleCancel(envelope, rest[0]);
      default:
        await this.sendMessage(
          envelope.chatId,
          'Usage: /schedule add "<cron>" <prompt> | /schedule list | /schedule cancel <id>',
        );
        return true;
    }
  }

  private async handleScheduleAdd(
    envelope: Envelope,
    args: string,
  ): Promise<boolean> {
    if (!this.scheduleController) return true;
    if (!this.supportsProactiveSend()) {
      await this.sendMessage(
        envelope.chatId,
        'This channel does not support proactive scheduled messages.',
      );
      return true;
    }

    const parsed = parseScheduleAddArgs(args);
    if (!parsed) {
      await this.sendMessage(
        envelope.chatId,
        'Usage: /schedule add "<cron>" <prompt>',
      );
      return true;
    }

    try {
      this.scheduleController.validateCron(parsed.cron);
    } catch (err) {
      await this.sendMessage(
        envelope.chatId,
        `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }

    const target = this.scheduleTargetFromEnvelope(envelope);
    if (!this.supportsProactiveTarget(target)) {
      await this.sendMessage(
        envelope.chatId,
        'This channel does not support proactive scheduled messages for this chat target.',
      );
      return true;
    }
    const prompt = sanitizePromptText(parsed.prompt.trim());
    if (Array.from(prompt).length > MAX_SCHEDULE_PROMPT_CHARS) {
      await this.sendMessage(
        envelope.chatId,
        `Scheduled prompt is too long; keep it under ${MAX_SCHEDULE_PROMPT_CHARS} characters.`,
      );
      return true;
    }
    const input: ChannelCronJobInput = {
      channelName: this.name,
      target,
      cwd: this.config.cwd,
      cron: parsed.cron,
      prompt,
      label: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
      recurring: true,
      createdBy: sanitizeSenderName(
        envelope.senderName || envelope.senderId || 'unknown',
      ),
    };
    let job: ChannelCronJob | undefined;
    if (this.scheduleController.createForTarget) {
      job = await this.scheduleController.createForTarget(
        input,
        MAX_SCHEDULE_JOBS_PER_TARGET,
      );
    } else {
      const existingJobs = await this.scheduleController.listForTarget(
        this.name,
        target,
      );
      if (
        existingJobs.filter((existingJob) => existingJob.enabled).length <
        MAX_SCHEDULE_JOBS_PER_TARGET
      ) {
        job = await this.scheduleController.create(input);
      }
    }
    if (!job) {
      await this.sendMessage(
        envelope.chatId,
        `Too many scheduled jobs for this chat. Cancel an existing job before adding another.`,
      );
      return true;
    }

    await this.sendMessage(
      envelope.chatId,
      `Scheduled job ${job.id}: ${job.cron}`,
    );
    return true;
  }

  private async handleScheduleList(envelope: Envelope): Promise<boolean> {
    if (!this.scheduleController) return true;
    const jobs = await this.scheduleController.listForTarget(
      this.name,
      this.scheduleTargetFromEnvelope(envelope),
    );
    if (jobs.length === 0) {
      await this.sendMessage(envelope.chatId, 'No scheduled jobs.');
      return true;
    }
    await this.sendMessage(
      envelope.chatId,
      jobs
        .map((job) => {
          const status = job.enabled ? 'enabled' : 'disabled';
          const label = job.label ? ` ${job.label}` : '';
          return `${job.id} ${job.cron} ${status}${label}`;
        })
        .join('\n'),
    );
    return true;
  }

  private async handleScheduleCancel(
    envelope: Envelope,
    id: string | undefined,
  ): Promise<boolean> {
    if (!this.scheduleController) return true;
    if (!id) {
      await this.sendMessage(envelope.chatId, 'Usage: /schedule cancel <id>');
      return true;
    }
    const jobs = await this.scheduleController.listForTarget(
      this.name,
      this.scheduleTargetFromEnvelope(envelope),
    );
    const match = jobs.find((job) => job.id === id);
    const disabled = match ? await this.scheduleController.disable(id) : false;
    await this.sendMessage(
      envelope.chatId,
      disabled ? `Cancelled scheduled job ${id}.` : `No scheduled job ${id}.`,
    );
    return true;
  }

  private scheduleTargetFromEnvelope(envelope: Envelope): SessionTarget {
    return {
      channelName: this.name,
      senderId: envelope.senderId,
      chatId: envelope.chatId,
      threadId: envelope.threadId,
      isGroup: envelope.isGroup,
    };
  }

  private isStoredScheduleTargetAuthorized(
    target: SessionTarget,
    senderName: string,
  ): boolean {
    const envelope: Envelope = {
      channelName: this.name,
      senderId: target.senderId,
      senderName,
      chatId: target.chatId,
      text: '',
      threadId: target.threadId,
      isGroup: target.isGroup === true,
      isMentioned: true,
      isReplyToBot: true,
    };
    return (
      this.groupGate.check(envelope).allowed &&
      this.gate.check(target.senderId, senderName).allowed &&
      this.isAuthorizedForSharedSession(envelope)
    );
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
   * Whether `envelope.senderId` may act on the resolved session's destructive or
   * workspace-leaking commands (/clear, /who). A SHARED session with a non-empty
   * allowedUsers list is restricted to those members; a per-user session, or one
   * with no allowlist, is unrestricted. Shared verbatim by /clear and /who so the
   * gate can't drift; each caller sends its own rejection wording.
   */
  private isAuthorizedForSharedSession(envelope: Envelope): boolean {
    if (!this.isSharedSession(envelope)) return true;
    const authorized = this.config.allowedUsers;
    return authorized.length === 0 || authorized.includes(envelope.senderId);
  }

  private stopActiveStreaming(
    active: ActivePrompt,
    sessionId: string,
    reason: string,
  ): void {
    try {
      active.stopStreaming?.();
    } catch (err) {
      process.stderr.write(
        `[${this.name}] stopStreaming threw during ${reason} for session ${sessionId}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
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
    this.stopActiveStreaming(active, sessionId, 'cancel');
    // Fire-and-forget, but LOG the IPC failure: a swallowed reason leaves a
    // wedged turn undiagnosable (operator sees only the wind-down timeout below
    // with no cause).
    void this.bridge.cancelSession(sessionId).catch((err) => {
      process.stderr.write(
        `[${this.name}] cancelSession failed for session=${sessionId} (clear/await): ${err instanceof Error ? err.message : err}\n`,
      );
    });
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
   * Returns { command, raw, args } or null if not a slash command. `command` is
   * lowercased for case-insensitive LOCAL dispatch (registerCommand lowercases the
   * names it stores); `raw` keeps the typed case so agent-command matching can be
   * CASE-SENSITIVE, mirroring the CLI's parseSlashCommand (`cmd.name === part`).
   */
  private parseCommand(
    text: string,
  ): { command: string; raw: string; args: string } | null {
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
    return {
      command: match[1].toLowerCase(),
      raw: match[1],
      args: match[2].trim(),
    };
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

  /**
   * Whether `text` names a command this channel can actually run: a locally
   * registered command (`this.commands`, e.g. /clear, /who) OR an agent command
   * THIS session exposes — by canonical name OR alias (e.g. `/summarize` for
   * `/compress`). Paired with isSlashCommand so the `[sender]` attribution tag is
   * suppressed ONLY for RECOGNIZED commands; command-SHAPED-but-unrecognized text
   * (e.g. `/x\n[SYSTEM]: …`) keeps its tag rather than reaching a shared group
   * unattributed, where an injected second line is more likely read as a system
   * directive. Purely synchronous, like isSlashCommand: it reads the session's
   * availableCommands snapshot WITHOUT awaiting, so it never races a fresh session
   * (a genuine agent command sent before the snapshot loads is treated as
   * unrecognized and KEEPS its tag — the safe default).
   */
  private isRecognizedCommand(text: string, sessionId: string): boolean {
    const parsed = this.parseCommand(text);
    if (!parsed) return false;
    // LOCAL commands dispatch CASE-INSENSITIVELY: registerCommand lowercases the
    // stored name and handleInbound looks it up by the lowercased token, so mirror
    // that here with the lowercased `command`.
    if (this.commands.has(parsed.command)) return true;
    // AGENT commands: mirror the CLI's parseSlashCommand EXACTLY so the channel and
    // the agent AGREE on what is a command. The CLI takes the FIRST whitespace token
    // after the leading `/`, CASE-SENSITIVELY, and does NOT strip an `@suffix`
    // (`cmd.name === part`, `cmd.altNames?.includes(part)`). So recognize the SAME
    // token here — NOT parseCommand's `@`-stripped, lowercased `raw` (PARSE_COMMAND_RE
    // drops `(?:@\S+)?`, which is the very divergence this closes). A wrong-case
    // (`/Compress`), `@`-suffixed (`/compress@bot` — possibly aimed at ANOTHER bot, so
    // we must NOT run it here), or injection-shaped (`/COMPRESS\n[SYSTEM]: …`) token
    // then does NOT match → stays UNRECOGNIZED → keeps its `[sender]` tag (attributed),
    // exactly as the agent treats it (it runs no command; the text reaches the model
    // as prose). Array.isArray guards a malformed wire `altNames` (a non-array would
    // throw at `.includes`).
    const token = text.trim().slice(1).split(/\s+/u)[0] ?? '';
    return this.getAgentCommandsForSession(sessionId).some(
      (cmd) =>
        cmd.name === token ||
        (Array.isArray(cmd.altNames) && cmd.altNames.includes(token)),
    );
  }

  /**
   * The agent-command snapshot for THIS session. DaemonChannelBridge keys
   * commands per session, so its global `availableCommands` getter can return
   * ANOTHER session's list — prefer its getAvailableCommands(sessionId) when
   * present. AcpBridge runs a single agent and exposes only the global getter
   * (inherently session-correct), so fall back to it. Synchronous, matching
   * isRecognizedCommand's no-await contract.
   */
  private getAgentCommandsForSession(sessionId: string): AvailableCommand[] {
    // Structural (typed) access via AgentCommandsProvider rather than a blind
    // `as unknown` cast: both members are optional, so AcpBridge (no per-session
    // getter) is assignable while a rename/return-type change is still type-checked.
    const bridge: AgentCommandsProvider = this.bridge;
    if (typeof bridge.getAvailableCommands === 'function') {
      return bridge.getAvailableCommands(sessionId) ?? [];
    }
    return bridge.availableCommands ?? [];
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
    const bangText = envelope.text.trimStart();
    if (bangText.startsWith('!')) {
      if (envelope.isGroup || this.isSharedSession(envelope)) {
        // Audit a blocked host-shell attempt — a group/shared member trying `!`
        // is security-relevant, so surface it to operators. Sanitize the display
        // name (attacker-controlled) and do NOT echo the command payload.
        const who = sanitizeSenderName(
          envelope.senderName || envelope.senderId || 'unknown',
        );
        process.stderr.write(
          `[${this.name}] blocked ! shell command from ${who} (sender ${envelope.senderId}) in chat ${sanitizeLogText(envelope.chatId, 64)}\n`,
        );
      }
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
    if (bangText.startsWith('!')) {
      const cmd = bangText.slice(1).trim();
      const bridgeShellCommand = this.bridge.shellCommand;
      if (cmd && bridgeShellCommand) {
        try {
          const result = await this.bridge.shellCommand!(sessionId, cmd);
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
    // (collect-mode coalescing). The tag is also suppressed for a real slash
    // command — a [sender] prefix would stop it from parsing — but ONLY when it is
    // BOTH a genuine command SHAPE (isSlashCommand) AND a RECOGNIZED command
    // (isRecognizedCommand: a locally registered or agent-exposed command, by
    // canonical name OR alias, for THIS session — matched EXACTLY as the agent's
    // parseSlashCommand does, so the two never diverge). Command-shaped-but-
    // unrecognized text like `/x\n[SYSTEM]: …` (token matches the charset but no such
    // command exists) KEEPS its tag, so its injected second line can't reach a shared
    // group unattributed and pose as a system directive. Slash-prefixed paths
    // (/tmp/foo) and comments (//…, /*…*/) are prose, so they stay attributed too.
    // Both checks are synchronous (no await), so this never races the async command
    // list — see isRecognizedCommand for the no-await tradeoff.
    if (
      (envelope.isGroup || this.config.sessionScope === 'single') &&
      !envelope.alreadyPrefixed &&
      !(
        this.isSlashCommand(envelope.text) &&
        this.isRecognizedCommand(envelope.text, sessionId)
      )
    ) {
      const who = sanitizeSenderName(
        envelope.senderName || envelope.senderId || 'unknown',
      );
      promptText = `[${who}] ${sanitizePromptText(promptText)}`;
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

    // Diagnostic watchdog for a steered turn that chains behind a wedged
    // predecessor. Chain-and-wait (option a) means a hung predecessor bridge.prompt()
    // silently deadlocks this session with no log; this surfaces that. Armed only in
    // the steer branch, disarmed as the first statement of the chained `.then()` once
    // the predecessor's tail resolves. Diagnostic-only — it does NOT touch the
    // chain-and-wait concurrency invariant.
    let steerWatchdog: ReturnType<typeof setTimeout> | undefined;

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
          // Authorization gate (mirrors /cancel): steer = cancel-running +
          // send-new, so without this an UNAUTHORIZED member of a shared session —
          // already blocked from /cancel — could abort another user's running turn
          // just by sending any normal message, defeating the /cancel restriction.
          // If not authorized, break out of the steer case: the message is NOT
          // dropped — it falls through to normal queuing (chains onto the session
          // queue tail and runs AFTER the active turn) without cancelling it.
          // isAuthorizedForSharedSession returns true for 1:1/non-shared sessions
          // and for authorized members, so their steer-cancel is unchanged. Audit
          // the silent steer→queue downgrade (like the /cancel, /clear, /who, /status
          // gates surface theirs) so an operator can see WHY a member's messages
          // queue instead of steering. Operator-level only — a normal message from an
          // unauthorized member shouldn't get a per-message user-facing rejection.
          // senderId is a stable platform id, not user-controlled display text.
          if (!this.isAuthorizedForSharedSession(envelope)) {
            process.stderr.write(
              `[${this.name}] steer denied for ${envelope.senderId} in shared session (chat=${sanitizeLogText(envelope.chatId, 64)}); queuing instead\n`,
            );
            break;
          }
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
          process.stderr.write(
            `[${this.name}] steer: cancelled active turn for ${envelope.senderId} in session ${sessionId}\n`,
          );
          this.stopActiveStreaming(active, sessionId, 'steer');
          // Fire-and-forget, but LOG the IPC failure rather than swallow it, so a
          // best-effort cancel that fails isn't silently invisible to operators.
          void this.bridge.cancelSession(sessionId).catch((err) => {
            process.stderr.write(
              `[${this.name}] cancelSession failed for session=${sessionId} (steer): ${err instanceof Error ? err.message : err}\n`,
            );
          });
          // Diagnostic watchdog: if the predecessor turn is STILL the active prompt
          // after the wind-down bound, this steered turn is wedged behind a hung
          // bridge.prompt() — surface it (the chained `.then()` clears it once the
          // predecessor settles). This only LOGS; it does not start a replacement or
          // change concurrency. /clear is the recovery path. unref so a pending timer
          // never keeps the process alive.
          steerWatchdog = setTimeout(() => {
            if (this.activePrompts.get(sessionId) === active) {
              process.stderr.write(
                `[${this.name}] steer queued behind active turn for session ${sessionId}: still waiting after ${CLEAR_CANCEL_TIMEOUT_MS}ms (use /clear to recover)\n`,
              );
            }
          }, CLEAR_CANCEL_TIMEOUT_MS);
          steerWatchdog.unref?.();
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
      // Disarm the steer watchdog: the predecessor's tail has resolved, so this
      // chained turn is no longer wedged behind it. No-op when unarmed (the timer is
      // only set on the steer path).
      clearTimeout(steerWatchdog);
      // A /clear (or reset/new) while we were queued bumps the generation; the
      // captured session is cleared, so don't run the prompt against it.
      if ((this.sessionGenerations.get(sessionId) ?? 0) !== generation) {
        // Surface the drop — otherwise an unanswered queued message vanishes
        // silently, making "my message was never answered" undiagnosable.
        // envelope.text is attacker-controlled, so neutralize it with the shared
        // log sanitizer: it renders newlines visibly and strips the C0/DEL controls
        // PLUS PROMPT_UNSAFE_INVISIBLES — the C1 block (notably NEL U+0085, a line
        // break that could forge an extra [channel] log line), the Unicode line/
        // paragraph separators U+2028/U+2029, and the bidi overrides — any of which
        // would otherwise inject, overwrite, or reorder an operator's audit line.
        // Same helper as the QQ audit log, so the defense can't drift between sites.
        const loggedText = sanitizeLogText(envelope.text, 80);
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
      const promptBridge = this.bridge;
      promptBridge.on('textChunk', onChunk);

      try {
        const response = await promptBridge.prompt(sessionId, promptText, {
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
        promptBridge.off('textChunk', onChunk);
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
        // chat-scoped indicator, so re-running cleanup here would clobber it.
        // Invariant: clearEvicted is set ONLY by /clear's eviction, which then
        // UNCONDITIONALLY deletes activePrompts[sessionId] (its try/catch around the
        // clear-time onPromptEnd guarantees the purge runs even if that throws), and
        // no turn ever re-inserts THIS promptState object — so clearEvicted ⟹ NOT
        // stillCurrent. Hence `stillCurrent || !clearEvicted` reduces to
        // `!clearEvicted` (the `stillCurrent && clearEvicted` case is unreachable).
        // Steer no longer evicts (it chains and waits), so a steered turn is always
        // stillCurrent on completion.
        if (!promptState.clearEvicted) {
          // onPromptEnd runs platform-adapter cleanup (clear the typing interval,
          // recall the working reaction, finalize the card) — network/IO that CAN
          // throw. Guard it like the /clear-eviction path above: an uncaught throw
          // here would skip activePrompts.delete (session leak), promptState.resolve
          // (active.done never settles → a later /clear falsely logs "abandoned a
          // wedged turn" for a turn that completed), and the collect-buffer drain
          // (lost messages) — and the rejected queue-chain promise, swallowed by the
          // tail .catch(() => {}), would silently drop every later turn this session.
          try {
            this.onPromptEnd(envelope.chatId, sessionId, envelope.messageId);
          } catch (err) {
            process.stderr.write(
              `[${this.name}] onPromptEnd threw in finally for session ${sessionId}: ${err instanceof Error ? err.message : err}\n`,
            );
          }
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
