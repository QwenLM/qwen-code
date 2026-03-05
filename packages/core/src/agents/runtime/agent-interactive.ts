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
} from './agent-events.js';
import type { AgentStatsSummary } from './agent-statistics.js';
import type { AgentCore } from './agent-core.js';
import type { ContextState } from './agent-headless.js';
import type { GeminiChat } from '../../core/geminiChat.js';
import type { FunctionDeclaration } from '@google/genai';
import type {
  ToolCallConfirmationDetails,
  ToolResultDisplay,
} from '../../tools/tools.js';
import { AsyncMessageQueue } from '../../utils/asyncMessageQueue.js';
import {
  AgentTerminateMode,
  AgentStatus,
  isTerminalStatus,
  type AgentInteractiveConfig,
  type AgentMessage,
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

    this.chat = await this.core.createChat(context, { interactive: true });
    if (!this.chat) {
      this.error = 'Failed to create chat session';
      this.setStatus(AgentStatus.FAILED);
      return;
    }

    this.toolsList = this.core.prepareTools();
    this.core.stats.start(Date.now());

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

  /** Emit terminal status for the just-completed round. */
  private settleRoundStatus(): void {
    if (this.lastRoundError) {
      this.setStatus(AgentStatus.FAILED);
    } else {
      this.setStatus(AgentStatus.COMPLETED);
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
