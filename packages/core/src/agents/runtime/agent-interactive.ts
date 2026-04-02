/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentInteractive — persistent interactive agent.
 *
 * Composes AgentCore with on-demand message processing. Builds conversation
 * state (messages, pending approvals, live outputs) that the UI reads.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import { type AgentEventEmitter, AgentEventType } from './agent-events.js';
import type {
  AgentRoundTextEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentToolOutputUpdateEvent,
  AgentApprovalRequestEvent,
  AgentTurnStartEvent,
  AgentTurnEndEvent,
} from './agent-events.js';
import type { AgentStatsSummary } from './agent-statistics.js';
import type { AgentCore } from './agent-core.js';
import type { ContextState } from './agent-headless.js';
import type { GeminiChat } from '../../core/geminiChat.js';
import type { FunctionDeclaration } from '@google/genai';
import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
  type ToolResultDisplay,
} from '../../tools/tools.js';
import { AsyncMessageQueue } from '../../utils/asyncMessageQueue.js';
import {
  AgentTerminateMode,
  AgentStatus,
  isTerminalStatus,
  type AgentInteractiveConfig,
  type AgentMessage,
  type SessionResult,
} from './agent-types.js';

const debugLogger = createDebugLogger('AGENT_INTERACTIVE');

/**
 * AgentInteractive — persistent interactive agent that processes
 * messages on demand.
 *
 * Three-level cancellation:
 * - `cancelCurrentRound()` — abort the current reasoning loop only
 * - `shutdown()` — graceful: stop accepting messages, wait for cycle
 * - `abort()` — immediate: master abort, set cancelled
 */
export class AgentInteractive {
  readonly config: AgentInteractiveConfig;
  private readonly core: AgentCore;
  private readonly queue = new AsyncMessageQueue<string>();
  private readonly messages: AgentMessage[] = [];

  private status: AgentStatus = AgentStatus.INITIALIZING;
  private error: string | undefined;
  private lastRoundError: string | undefined;
  private executionPromise: Promise<void> | undefined;
  private masterAbortController = new AbortController();
  private roundAbortController: AbortController | undefined;
  private chat: GeminiChat | undefined;
  private toolsList: FunctionDeclaration[] = [];
  private processing = false;
  private roundCancelledByUser = false;

  // ─── Multi-turn session state (used by execute()) ──────────

  /**
   * Resolver for the pending `waitForNextMessage()` promise.
   * Set when `execute()` is waiting for the next user turn;
   * called by `sendMessage()` to inject the next prompt.
   */
  private resolveNextMessage: ((msg: string) => void) | undefined;

  /**
   * Pre-queued message sent via sendMessage() before execute()
   * reaches its wait point for the next turn.
   */
  private pendingNextMessage: string | undefined;

  /** Session-level turn counter for execute() calls. */
  private sessionTurnCount = 0;

  /** Session start time in ms, set when execute() begins. */
  private sessionStartTimeMs = 0;

  /** The final terminate mode for a completed execute() session. */
  private sessionTerminateMode: AgentTerminateMode = AgentTerminateMode.GOAL;

  // Pending tool approval requests. Keyed by callId.
  // Populated by TOOL_WAITING_APPROVAL, removed by TOOL_RESULT or when
  // the user responds. The UI reads this to show confirmation dialogs.
  private readonly pendingApprovals = new Map<
    string,
    ToolCallConfirmationDetails
  >();

  // Live streaming output for currently-executing tools. Keyed by callId.
  // Populated by TOOL_OUTPUT_UPDATE (replaces previous), cleared on TOOL_RESULT.
  // The UI reads this via getLiveOutputs() to show real-time stdout.
  private readonly liveOutputs = new Map<string, ToolResultDisplay>();

  // PTY PIDs for currently-executing shell tools. Keyed by callId.
  // Populated by TOOL_OUTPUT_UPDATE when pid is present, cleared on TOOL_RESULT.
  // The UI reads this via getShellPids() to enable interactive shell input.
  private readonly shellPids = new Map<string, number>();

  constructor(config: AgentInteractiveConfig, core: AgentCore) {
    this.config = config;
    this.core = core;
    this.setupEventListeners();
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the agent. Initializes the chat session, then kicks off
   * processing if an initialTask is configured.
   */
  async start(context: ContextState): Promise<void> {
    this.setStatus(AgentStatus.INITIALIZING);

    this.chat = await this.core.createChat(context, {
      interactive: true,
      extraHistory: this.config.chatHistory,
    });
    if (!this.chat) {
      this.error = 'Failed to create chat session';
      this.setStatus(AgentStatus.FAILED);
      return;
    }

    this.toolsList = this.core.prepareTools();
    this.core.stats.start(Date.now());

    if (this.config.chatHistory?.length) {
      this.addMessage(
        'info',
        `History context from parent session included (${this.config.chatHistory.length} messages)`,
      );
    }

    if (this.config.initialTask) {
      this.queue.enqueue(this.config.initialTask);
      this.executionPromise = this.runLoop();
    }
  }

  /**
   * Run loop: process all pending messages, then settle status.
   * Exits when the queue is empty or the agent is aborted.
   */
  private async runLoop(): Promise<void> {
    this.processing = true;
    try {
      let message = this.queue.dequeue();
      while (message !== null && !this.masterAbortController.signal.aborted) {
        this.addMessage('user', message);
        await this.runOneRound(message);
        message = this.queue.dequeue();
      }

      if (this.masterAbortController.signal.aborted) {
        this.setStatus(AgentStatus.CANCELLED);
      } else {
        this.settleRoundStatus();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus(AgentStatus.FAILED);
      debugLogger.error('AgentInteractive processing failed:', err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Run a single reasoning round for one message.
   * Creates a per-round AbortController so cancellation is scoped.
   */
  private async runOneRound(message: string): Promise<void> {
    if (!this.chat) return;

    this.setStatus(AgentStatus.RUNNING);
    this.lastRoundError = undefined;
    this.roundCancelledByUser = false;
    this.roundAbortController = new AbortController();

    // Propagate master abort to round
    const onMasterAbort = () => this.roundAbortController?.abort();
    this.masterAbortController.signal.addEventListener('abort', onMasterAbort);
    if (this.masterAbortController.signal.aborted) {
      this.roundAbortController.abort();
    }

    try {
      const initialMessages = [
        { role: 'user' as const, parts: [{ text: message }] },
      ];

      const result = await this.core.runReasoningLoop(
        this.chat,
        initialMessages,
        this.toolsList,
        this.roundAbortController,
        {
          maxTurns: this.config.maxTurnsPerMessage,
          maxTimeMinutes: this.config.maxTimeMinutesPerMessage,
        },
      );

      // Surface non-normal termination as a visible info message and as
      // lastRoundError so Arena can distinguish limit stops from successes.
      if (
        result.terminateMode &&
        result.terminateMode !== AgentTerminateMode.GOAL
      ) {
        const msg = terminateModeMessage(result.terminateMode);
        if (msg) {
          this.addMessage('info', msg.text, { metadata: { level: msg.level } });
        }
        this.lastRoundError = `Terminated: ${result.terminateMode}`;
      }
    } catch (err) {
      // User-initiated cancellation already logged by cancelCurrentRound().
      if (this.roundCancelledByUser) return;
      // Agent survives round errors — log and settle status in runLoop.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.lastRoundError = errorMessage;
      debugLogger.error('AgentInteractive round error:', err);
      this.addMessage('info', errorMessage, { metadata: { level: 'error' } });
    } finally {
      this.masterAbortController.signal.removeEventListener(
        'abort',
        onMasterAbort,
      );
      this.roundAbortController = undefined;
    }
  }

  // ─── Cancellation ──────────────────────────────────────────

  /**
   * Cancel only the current reasoning round.
   * Adds a visible "cancelled" info message and clears pending approvals.
   */
  cancelCurrentRound(): void {
    this.roundCancelledByUser = true;
    this.roundAbortController?.abort();
    this.pendingApprovals.clear();
    this.addMessage('info', 'Agent round cancelled.', {
      metadata: { level: 'warning' },
    });
  }

  /**
   * Graceful shutdown: stop accepting messages and wait for current
   * processing to finish.
   */
  async shutdown(): Promise<void> {
    this.queue.drain();
    if (this.executionPromise) {
      await this.executionPromise;
    }
    // If no processing cycle ever ran (no initialTask, no messages),
    // ensure the agent reaches a terminal status.
    if (!isTerminalStatus(this.status)) {
      this.setStatus(AgentStatus.COMPLETED);
    }
  }

  /**
   * Immediate abort: cancel everything and set status to cancelled.
   */
  abort(): void {
    this.masterAbortController.abort();
    this.queue.drain();
    this.pendingApprovals.clear();
  }

  // ─── Message Queue ─────────────────────────────────────────

  /**
   * Enqueue a message for the agent to process.
   */
  enqueueMessage(message: string): void {
    this.queue.enqueue(message);
    if (!this.processing) {
      this.executionPromise = this.runLoop();
    }
  }

  // ─── Multi-turn Session API ─────────────────────────────────

  /**
   * Inject the next user message into a running execute() session.
   *
   * If execute() is already waiting for a message (via waitForNextMessage),
   * the promise is resolved immediately. Otherwise the message is buffered
   * and consumed when execute() reaches its next wait point.
   *
   * This is the external API for feeding user turns into the session.
   */
  sendMessage(text: string): void {
    if (this.resolveNextMessage) {
      const resolve = this.resolveNextMessage;
      this.resolveNextMessage = undefined;
      resolve(text);
    } else {
      // Buffer for consumption at the next waitForNextMessage() call.
      this.pendingNextMessage = text;
    }
  }

  /**
   * Run the multi-turn persistent execution loop.
   *
   * Starts a chat session, processes the initial prompt, then alternates
   * between:
   *   1. Running AgentCore for one turn (runOneRound).
   *   2. Waiting for the next user message (waitForNextMessage / sendMessage).
   *
   * Session-level `max_turns` and `max_time_minutes` (from AgentInteractiveConfig)
   * are enforced across all turns, not per-turn.
   *
   * Returns a SessionResult with the full message history and the reason the
   * session ended.
   *
   * @param initialPrompt - The first user message to kick off the session.
   * @param context - Runtime context state (forwarded to createChat).
   * @param maxTurns - Session-wide turn limit (overrides config if set).
   * @param maxTimeMinutes - Session-wide time limit in minutes (overrides config if set).
   */
  async execute(
    initialPrompt: string,
    context: ContextState,
    maxTurns?: number,
    maxTimeMinutes?: number,
  ): Promise<SessionResult> {
    this.sessionStartTimeMs = Date.now();
    this.sessionTurnCount = 0;
    this.sessionTerminateMode = AgentTerminateMode.GOAL;

    // Allow explicit args to override per-session config.
    const turnLimit = maxTurns ?? this.config.maxTurnsPerMessage;
    const timeLimit = maxTimeMinutes ?? this.config.maxTimeMinutesPerMessage;

    // Initialize chat + tools if not already done.
    // We do NOT call start() here to avoid triggering the initialTask runLoop.
    if (!this.chat) {
      this.setStatus(AgentStatus.INITIALIZING);
      this.chat = await this.core.createChat(context, {
        interactive: true,
        extraHistory: this.config.chatHistory,
      });
      if (!this.chat) {
        this.error = 'Failed to create chat session';
        this.setStatus(AgentStatus.FAILED);
        return {
          messageHistory: [...this.messages],
          terminateMode: AgentTerminateMode.ERROR,
        };
      }
      this.toolsList = this.core.prepareTools();
      this.core.stats.start(Date.now());

      if (this.config.chatHistory?.length) {
        this.addMessage(
          'info',
          `History context from parent session included (${this.config.chatHistory.length} messages)`,
        );
      }
    }

    let currentPrompt = initialPrompt;

    while (!this.masterAbortController.signal.aborted) {
      // ── Pre-turn: check session turn limit ──────────────────
      if (turnLimit !== undefined && this.sessionTurnCount >= turnLimit) {
        this.sessionTerminateMode = AgentTerminateMode.MAX_TURNS;
        break;
      }

      // ── Emit TURN_START ─────────────────────────────────────
      this.core.eventEmitter?.emit(AgentEventType.TURN_START, {
        agentId: this.config.agentId,
        turn: this.sessionTurnCount,
        prompt: currentPrompt,
        timestamp: Date.now(),
      } as AgentTurnStartEvent);

      // ── Run one reasoning round ─────────────────────────────
      this.addMessage('user', currentPrompt);
      await this.runOneRound(currentPrompt);
      const hadError = !!this.lastRoundError;
      this.sessionTurnCount++;

      // ── Emit TURN_END ───────────────────────────────────────
      this.core.eventEmitter?.emit(AgentEventType.TURN_END, {
        agentId: this.config.agentId,
        turn: this.sessionTurnCount - 1,
        terminateMode: hadError ? AgentTerminateMode.ERROR : null,
        timestamp: Date.now(),
      } as AgentTurnEndEvent);

      // ── Post-turn: check abort / status / session limits ────
      if (this.masterAbortController.signal.aborted) {
        this.sessionTerminateMode = AgentTerminateMode.CANCELLED;
        break;
      }

      if (
        this.status === AgentStatus.FAILED ||
        this.status === AgentStatus.CANCELLED
      ) {
        this.sessionTerminateMode =
          this.status === AgentStatus.CANCELLED
            ? AgentTerminateMode.CANCELLED
            : AgentTerminateMode.ERROR;
        break;
      }

      if (turnLimit !== undefined && this.sessionTurnCount >= turnLimit) {
        this.sessionTerminateMode = AgentTerminateMode.MAX_TURNS;
        break;
      }

      const elapsedMin = (Date.now() - this.sessionStartTimeMs) / (1000 * 60);
      if (timeLimit !== undefined && elapsedMin >= timeLimit) {
        this.sessionTerminateMode = AgentTerminateMode.TIMEOUT;
        break;
      }

      // ── Wait for next user message ──────────────────────────
      try {
        currentPrompt = await this.waitForNextMessage();
      } catch {
        // Thrown when the session is terminated while waiting (e.g., abort).
        if (this.masterAbortController.signal.aborted) {
          this.sessionTerminateMode = AgentTerminateMode.CANCELLED;
        }
        break;
      }
    }

    if (this.masterAbortController.signal.aborted) {
      this.sessionTerminateMode = AgentTerminateMode.CANCELLED;
    }

    return {
      messageHistory: [...this.messages],
      terminateMode: this.sessionTerminateMode,
    };
  }

  /**
   * Await the next message injected by sendMessage().
   * Returns a Promise that resolves when sendMessage() is called.
   * Rejects if the master abort fires while waiting.
   */
  private waitForNextMessage(): Promise<string> {
    // Fast path: a message was buffered before we got here.
    if (this.pendingNextMessage !== undefined) {
      const msg = this.pendingNextMessage;
      this.pendingNextMessage = undefined;
      return Promise.resolve(msg);
    }

    return new Promise<string>((resolve, reject) => {
      this.resolveNextMessage = resolve;

      // Abort cleans up and rejects so execute() can exit cleanly.
      const onAbort = () => {
        this.resolveNextMessage = undefined;
        reject(new Error('Session aborted while waiting for next message'));
      };
      this.masterAbortController.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    });
  }

  // ─── State Accessors ───────────────────────────────────────

  getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.error;
  }

  getLastRoundError(): string | undefined {
    return this.lastRoundError;
  }

  getStats(): AgentStatsSummary {
    return this.core.getExecutionSummary();
  }

  /** The prompt token count from the most recent model call. */
  getLastPromptTokenCount(): number {
    return this.core.lastPromptTokenCount;
  }

  getCore(): AgentCore {
    return this.core;
  }

  getEventEmitter(): AgentEventEmitter | undefined {
    return this.core.getEventEmitter();
  }

  /**
   * Returns tool calls currently awaiting user approval.
   * Keyed by callId → full ToolCallConfirmationDetails (with onConfirm).
   * The UI reads this to render confirmation dialogs inside ToolGroupMessage.
   */
  getPendingApprovals(): ReadonlyMap<string, ToolCallConfirmationDetails> {
    return this.pendingApprovals;
  }

  /**
   * Returns live output for currently-executing tools.
   * Keyed by callId → latest ToolResultDisplay (replaces on each update).
   * Entries are cleared when TOOL_RESULT arrives for the call.
   */
  getLiveOutputs(): ReadonlyMap<string, ToolResultDisplay> {
    return this.liveOutputs;
  }

  /**
   * Returns PTY PIDs for currently-executing interactive shell tools.
   * Keyed by callId → PID. Populated from TOOL_OUTPUT_UPDATE when pid is
   * present; cleared when TOOL_RESULT arrives. The UI uses this to enable
   * interactive shell input via HistoryItemDisplay's activeShellPtyId prop.
   */
  getShellPids(): ReadonlyMap<string, number> {
    return this.shellPids;
  }

  /**
   * Wait for the run loop to finish (used by InProcessBackend).
   */
  async waitForCompletion(): Promise<void> {
    if (this.executionPromise) {
      await this.executionPromise;
    }
  }

  // ─── Private Helpers ───────────────────────────────────────

  /**
   * Settle status after the run loop empties.
   * On success → IDLE (agent stays alive for follow-up messages).
   * On error → FAILED (terminal).
   */
  private settleRoundStatus(): void {
    if (this.lastRoundError && !this.roundCancelledByUser) {
      this.setStatus(AgentStatus.FAILED);
    } else {
      this.setStatus(AgentStatus.IDLE);
    }
  }

  private setStatus(newStatus: AgentStatus): void {
    const previousStatus = this.status;
    if (previousStatus === newStatus) return;

    this.status = newStatus;

    this.core.eventEmitter?.emit(AgentEventType.STATUS_CHANGE, {
      agentId: this.config.agentId,
      previousStatus,
      newStatus,
      roundCancelledByUser: this.roundCancelledByUser || undefined,
      timestamp: Date.now(),
    });
  }

  private addMessage(
    role: AgentMessage['role'],
    content: string,
    options?: { thought?: boolean; metadata?: Record<string, unknown> },
  ): void {
    const message: AgentMessage = {
      role,
      content,
      timestamp: Date.now(),
    };
    if (options?.thought) {
      message.thought = true;
    }
    if (options?.metadata) {
      message.metadata = options.metadata;
    }
    this.messages.push(message);
  }

  private setupEventListeners(): void {
    const emitter = this.core.eventEmitter;
    if (!emitter) return;

    emitter.on(AgentEventType.ROUND_TEXT, (event: AgentRoundTextEvent) => {
      if (event.thoughtText) {
        this.addMessage('assistant', event.thoughtText, { thought: true });
      }
      if (event.text) {
        this.addMessage('assistant', event.text);
      }
    });

    emitter.on(AgentEventType.TOOL_CALL, (event: AgentToolCallEvent) => {
      this.addMessage('tool_call', `Tool call: ${event.name}`, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          args: event.args,
          description: event.description,
          renderOutputAsMarkdown: event.isOutputMarkdown,
          round: event.round,
        },
      });
    });

    emitter.on(
      AgentEventType.TOOL_OUTPUT_UPDATE,
      (event: AgentToolOutputUpdateEvent) => {
        this.liveOutputs.set(event.callId, event.outputChunk);
        if (event.pid !== undefined) {
          this.shellPids.set(event.callId, event.pid);
        }
      },
    );

    emitter.on(AgentEventType.TOOL_RESULT, (event: AgentToolResultEvent) => {
      this.liveOutputs.delete(event.callId);
      this.shellPids.delete(event.callId);
      this.pendingApprovals.delete(event.callId);

      const statusText = event.success ? 'succeeded' : 'failed';
      const summary = event.error
        ? `Tool ${event.name} ${statusText}: ${event.error}`
        : `Tool ${event.name} ${statusText}`;
      this.addMessage('tool_result', summary, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          success: event.success,
          resultDisplay: event.resultDisplay,
          outputFile: event.outputFile,
          round: event.round,
        },
      });
    });

    emitter.on(
      AgentEventType.TOOL_WAITING_APPROVAL,
      (event: AgentApprovalRequestEvent) => {
        const fullDetails = {
          ...event.confirmationDetails,
          onConfirm: async (
            outcome: Parameters<ToolCallConfirmationDetails['onConfirm']>[0],
            payload?: Parameters<ToolCallConfirmationDetails['onConfirm']>[1],
          ) => {
            this.pendingApprovals.delete(event.callId);
            // Nudge the UI to re-render so the tool transitions visually
            // from Confirming → Executing without waiting for the first
            // real TOOL_OUTPUT_UPDATE from the tool's execution.
            this.core.eventEmitter?.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
              subagentId: this.core.subagentId,
              round: event.round,
              callId: event.callId,
              outputChunk: '',
              timestamp: Date.now(),
            } as AgentToolOutputUpdateEvent);
            await event.respond(outcome, payload);
            // When the user denies a tool, cancel the round immediately
            // so the agent doesn't waste a turn "acknowledging" the denial.
            if (outcome === ToolConfirmationOutcome.Cancel) {
              this.cancelCurrentRound();
            }
          },
        } as ToolCallConfirmationDetails;

        this.pendingApprovals.set(event.callId, fullDetails);
      },
    );
  }
}

/**
 * Map a non-GOAL terminate mode to a visible status message for the UI,
 * or return null to suppress the message entirely.
 *
 * CANCELLED is suppressed here because cancelCurrentRound() already emits
 * its own warning. SHUTDOWN is suppressed as a normal lifecycle end.
 */
function terminateModeMessage(
  mode: AgentTerminateMode,
): { text: string; level: 'info' | 'warning' | 'error' } | null {
  switch (mode) {
    case AgentTerminateMode.MAX_TURNS:
      return {
        text: 'Agent stopped: maximum turns reached.',
        level: 'warning',
      };
    case AgentTerminateMode.TIMEOUT:
      return { text: 'Agent stopped: time limit reached.', level: 'warning' };
    case AgentTerminateMode.ERROR:
      return { text: 'Agent stopped due to an error.', level: 'error' };
    case AgentTerminateMode.CANCELLED:
    case AgentTerminateMode.SHUTDOWN:
      return null;
    default:
      return null;
  }
}
