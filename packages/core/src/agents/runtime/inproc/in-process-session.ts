/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ApprovalMode } from '../../../config/config.js';
import type { SerializableConfirmationDetails } from '../../../confirmation-bus/types.js';
import { ApprovalRegistry } from '../../fleet/approvals.js';
import { serializeConfirmationDetails } from '../../fleet/serializable-confirmation.js';
import type {
  AgentSession,
  AgentSessionEvents,
  ApprovalDecision,
  TurnId,
} from '../../fleet/session.js';
import type { AgentSessionView } from '../../fleet/view.js';
import {
  AgentEventType,
  type AgentEventMap,
  type AgentApprovalRequestEvent,
  type AgentStatusChangeEvent,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type AgentTurnTextEvent,
} from '../agent-events.js';
import type { AgentInteractive } from '../agent-interactive.js';
import { AgentStatus } from '../agent-types.js';

export class InProcessSession implements AgentSession, AgentSessionView {
  readonly kind = 'in-process' as const;
  readonly workingDir: string;
  readonly modelId: string;

  private readonly events = new EventEmitter();
  private readonly approvals = new ApprovalRegistry();
  private readonly pendingApprovals = new Map<
    string,
    SerializableConfirmationDetails
  >();
  private readonly cleanups: Array<() => void> = [];
  private activeTurnId: TurnId | undefined;

  constructor(
    readonly agentId: string,
    readonly teamId: string,
    private readonly interactive: AgentInteractive,
  ) {
    const core = interactive.getCore();
    this.workingDir = core.runtimeContext.getTargetDir() ?? '';
    this.modelId = core.modelConfig.model ?? '';
    const latestTurn = [...interactive.getMessages()]
      .reverse()
      .find((message) => typeof message.metadata?.['turnId'] === 'string');
    this.activeTurnId = latestTurn?.metadata?.['turnId'] as TurnId | undefined;
    for (const [callId, details] of interactive.getPendingApprovals()) {
      this.approvals.register(callId, details.onConfirm);
      this.pendingApprovals.set(callId, serializeConfirmationDetails(details));
    }
    this.attach();
  }

  getStatus(): AgentStatus {
    return this.interactive.getStatus();
  }

  getError(): string | undefined {
    return this.interactive.getError();
  }

  async send(message: string): Promise<TurnId> {
    return this.interactive.enqueueMessage(message);
  }

  cancelTurn(): void {
    this.interactive.cancelCurrentRound();
  }

  abort(): void {
    this.interactive.abort();
  }

  on<E extends keyof AgentSessionEvents>(
    event: E,
    handler: (payload: AgentSessionEvents[E]) => void,
  ): () => void {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  async answer(decision: ApprovalDecision): Promise<void> {
    await this.approvals.answer(decision);
    this.pendingApprovals.delete(decision.callId);
    this.emitChange();
  }

  getMessages() {
    return this.interactive.getMessages();
  }

  getPendingApprovals(): ReadonlyMap<string, SerializableConfirmationDetails> {
    return this.pendingApprovals;
  }

  getLiveOutputs() {
    return this.interactive.getLiveOutputs();
  }

  getShellPids() {
    return this.interactive.getShellPids();
  }

  getExecutionStartTimes() {
    return this.interactive.getExecutionStartTimes();
  }

  getLastPromptTokenCount(): number {
    return this.interactive.getLastPromptTokenCount();
  }

  getLastRoundError(): string | undefined {
    return this.interactive.getLastRoundError();
  }

  getApprovalMode(): ApprovalMode {
    return this.interactive.getCore().runtimeContext.getApprovalMode();
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.interactive.getCore().runtimeContext.setApprovalMode(mode);
  }

  onChange(cb: () => void): () => void {
    this.events.on('change', cb);
    return () => this.events.off('change', cb);
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.approvals.clear();
    this.events.removeAllListeners();
  }

  private attach(): void {
    const emitter = this.interactive.getEventEmitter();
    const listen = <E extends keyof AgentEventMap>(
      event: E,
      handler: (payload: AgentEventMap[E]) => void,
    ) => {
      emitter.on(event, handler);
      this.cleanups.push(() => emitter.off(event, handler));
    };
    const onStatus = (event: AgentStatusChangeEvent) => {
      this.activeTurnId = event.turnId ?? this.activeTurnId;
      if (
        event.roundCancelledByUser ||
        event.newStatus === AgentStatus.COMPLETED ||
        event.newStatus === AgentStatus.FAILED ||
        event.newStatus === AgentStatus.CANCELLED
      ) {
        this.approvals.clear();
        this.pendingApprovals.clear();
      }
      this.events.emit('status', {
        previous: event.previousStatus,
        next: event.newStatus,
        turnId: event.turnId,
        cancelledByUser: event.roundCancelledByUser,
      } satisfies AgentSessionEvents['status']);
      this.emitChange();
      if (
        event.newStatus === AgentStatus.COMPLETED ||
        event.newStatus === AgentStatus.FAILED ||
        event.newStatus === AgentStatus.CANCELLED
      ) {
        this.events.emit('exited', {
          code:
            event.newStatus === AgentStatus.COMPLETED
              ? 0
              : event.newStatus === AgentStatus.FAILED
                ? 1
                : null,
          reason: event.newStatus,
        } satisfies AgentSessionEvents['exited']);
      }
    };
    const onTurnText = (event: AgentTurnTextEvent) => {
      this.events.emit('turnText', {
        turnId: event.turnId,
        text: event.text,
      } satisfies AgentSessionEvents['turnText']);
      this.emitChange();
    };
    const onToolCall = (event: AgentToolCallEvent) => {
      if (!this.activeTurnId) return;
      this.events.emit('toolActivity', {
        turnId: this.activeTurnId,
        phase: 'call',
        toolName: event.name,
        callId: event.callId,
      } satisfies AgentSessionEvents['toolActivity']);
      this.emitChange();
    };
    const onToolResult = (event: AgentToolResultEvent) => {
      this.approvals.delete(event.callId);
      this.pendingApprovals.delete(event.callId);
      if (this.activeTurnId) {
        this.events.emit('toolActivity', {
          turnId: this.activeTurnId,
          phase: 'result',
          toolName: event.name,
          callId: event.callId,
        } satisfies AgentSessionEvents['toolActivity']);
      }
      this.emitChange();
    };
    const onApproval = (event: AgentApprovalRequestEvent) => {
      if (!this.activeTurnId) return;
      const fullDetails = this.interactive
        .getPendingApprovals()
        .get(event.callId);
      this.approvals.register(
        event.callId,
        fullDetails?.onConfirm ?? event.respond,
      );
      this.pendingApprovals.set(
        event.callId,
        event.confirmationDetails as SerializableConfirmationDetails,
      );
      this.events.emit('approvalRequest', {
        callId: event.callId,
        turnId: this.activeTurnId,
        agentId: this.agentId,
        toolName: event.name,
        toolInput: event.args,
        details: event.confirmationDetails as SerializableConfirmationDetails,
      } satisfies AgentSessionEvents['approvalRequest']);
      this.emitChange();
    };
    const onChange = () => this.emitChange();

    listen(AgentEventType.STATUS_CHANGE, onStatus);
    listen(AgentEventType.TURN_TEXT, onTurnText);
    listen(AgentEventType.TOOL_CALL, onToolCall);
    listen(AgentEventType.TOOL_RESULT, onToolResult);
    listen(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    listen(AgentEventType.ROUND_TEXT, onChange);
    listen(AgentEventType.TOOL_OUTPUT_UPDATE, onChange);
    listen(AgentEventType.USAGE_METADATA, onChange);
  }

  private emitChange(): void {
    this.events.emit('change');
  }
}
