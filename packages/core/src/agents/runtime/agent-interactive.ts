/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentInteractive — persistent interactive agent.
 *
 * Composes AgentCore with on-demand message processing to provide an agent
 * that processes user inputs sequentially and settles between batches.
 * Used by InProcessBackend for Arena's in-process mode.
 *
 * AgentInteractive is the **sole consumer** of AgentCore events. It builds
 * conversation state (messages + in-progress stream) that the UI reads.
 * The UI never directly subscribes to AgentCore events for data — it reads
 * from AgentInteractive and uses notifications to know when to re-render.
 *
 * Lifecycle: start() → (running ↔ completed/failed)* → shutdown()/abort()
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import { type AgentEventEmitter, AgentEventType } from './agent-events.js';
import type {
  AgentStreamTextEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
} from './agent-events.js';
import type { AgentStatsSummary } from './agent-statistics.js';
import type { AgentCore } from './agent-core.js';
import type { ContextState } from './agent-headless.js';
import type { GeminiChat } from '../../core/geminiChat.js';
import type { FunctionDeclaration } from '@google/genai';
import { AsyncMessageQueue } from '../../utils/asyncMessageQueue.js';
import {
  AgentTerminateMode,
  AgentStatus,
  isTerminalStatus,
  type AgentInteractiveConfig,
  type AgentMessage,
  type InProgressStreamState,
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

  // Stream accumulator — separate buffers for thought and non-thought text.
  // Flushed to messages on ROUND_END (intermediate rounds), before TOOL_CALL
  // events (to preserve temporal ordering), and after runReasoningLoop returns
  // (final round, since ROUND_END doesn't fire for it).
  private thoughtBuffer = '';
  private textBuffer = '';
  private streamRound = -1;

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

      // Finalize any unflushed stream content from the last round.
      // ROUND_END doesn't fire for the final text-producing round
      // (AgentCore breaks before emitting it), so we flush here.
      this.flushStreamBuffers();

      // Surface non-normal termination so Arena (and other consumers)
      // can distinguish limit-triggered stops from successful completions.
      if (
        result.terminateMode &&
        result.terminateMode !== AgentTerminateMode.GOAL
      ) {
        this.lastRoundError = `Terminated: ${result.terminateMode}`;
      }
    } catch (err) {
      // Agent survives round errors — log and settle status in runLoop.
      // Flush any partial stream content accumulated before the error.
      this.flushStreamBuffers();
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.lastRoundError = errorMessage;
      debugLogger.error('AgentInteractive round error:', err);
      this.addMessage('assistant', `Error: ${errorMessage}`, {
        metadata: { error: true },
      });
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
   */
  cancelCurrentRound(): void {
    this.roundAbortController?.abort();
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

  /**
   * Returns the in-progress streaming state for UI mid-switch handoff.
   * The UI reads this when attaching to an agent that's currently streaming
   * to display content accumulated before the UI subscribed.
   */
  getInProgressStream(): InProgressStreamState | null {
    if (!this.textBuffer && !this.thoughtBuffer) return null;
    return {
      text: this.textBuffer,
      thinking: this.thoughtBuffer,
      round: this.streamRound,
    };
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

  /**
   * Flush accumulated stream buffers to finalized messages.
   *
   * Thought text → assistant message with thought=true.
   * Regular text → assistant message.
   * Called on ROUND_END, before TOOL_CALL (ordering), and after
   * runReasoningLoop returns (final round).
   */
  private flushStreamBuffers(): void {
    if (this.thoughtBuffer) {
      this.addMessage('assistant', this.thoughtBuffer, { thought: true });
      this.thoughtBuffer = '';
    }
    if (this.textBuffer) {
      this.addMessage('assistant', this.textBuffer);
      this.textBuffer = '';
    }
    this.streamRound = -1;
  }

  /**
   * Set up listeners on AgentCore's event emitter.
   *
   * AgentInteractive is the sole consumer of these events. It builds
   * the conversation state (messages + in-progress stream) that the
   * UI reads. Listeners use canonical event types from agent-events.ts.
   */
  private setupEventListeners(): void {
    const emitter = this.core.eventEmitter;
    if (!emitter) return;

    emitter.on(AgentEventType.STREAM_TEXT, (event: AgentStreamTextEvent) => {
      // Round boundary: flush previous round's buffers before starting a new one
      if (event.round !== this.streamRound && this.streamRound !== -1) {
        this.flushStreamBuffers();
      }
      this.streamRound = event.round;

      if (event.thought) {
        this.thoughtBuffer += event.text;
      } else {
        this.textBuffer += event.text;
      }
    });

    emitter.on(AgentEventType.TOOL_CALL, (event: AgentToolCallEvent) => {
      // Flush text buffers first — in the stream, text arrives before
      // tool calls, so flushing preserves temporal ordering in messages.
      this.flushStreamBuffers();

      this.addMessage('tool_call', `Tool call: ${event.name}`, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          args: event.args,
          round: event.round,
        },
      });
    });

    emitter.on(AgentEventType.TOOL_RESULT, (event: AgentToolResultEvent) => {
      const statusText = event.success ? 'succeeded' : 'failed';
      const summary = event.error
        ? `Tool ${event.name} ${statusText}: ${event.error}`
        : `Tool ${event.name} ${statusText}`;
      this.addMessage('tool_result', summary, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          success: event.success,
          round: event.round,
        },
      });
    });

    emitter.on(AgentEventType.ROUND_END, () => {
      this.flushStreamBuffers();
    });
  }
}
