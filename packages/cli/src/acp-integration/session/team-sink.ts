/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import {
  TeamEventType,
  type MessageSentEvent,
  type TeammateActivityEvent,
  type TeammateApprovalRequestEvent,
  type TeammateExitedEvent,
  type TeammateJoinedEvent,
} from '@qwen-code/qwen-code-core/agents/team/team-events.js';
import type { TeamManager } from '@qwen-code/qwen-code-core/agents/team/TeamManager.js';
import { LEADER_NAME } from '@qwen-code/qwen-code-core/agents/team/types.js';
import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  buildPermissionRequestContent,
  interactionMetaFields,
  resolvePermissionOutcome,
  toPermissionOptions,
  type PermissionPersistencePolicy,
} from './permissionUtils.js';

const debugLogger = createDebugLogger('ACP_TEAM_SINK');
let nextBindingId = 0;

export interface TeamSinkDeps {
  readonly config: Config;
  readonly sessionId: string;
  /** Session lifetime. Aborting it cancels an in-flight teammate approval. */
  readonly signal: AbortSignal;
  readonly permissionPersistencePolicy?: PermissionPersistencePolicy;
  /**
   * Hands a teammate's report to the leader. The implementation must feed a
   * queue that a model turn actually drains: attaching a sink makes
   * `TeamManager.pollLeaderInbox()` consume the inbox and mark it read, so a
   * callback that buffers without ever reaching the model would turn
   * "retained, undelivered" into "consumed, lost".
   */
  readonly injectLeaderMessage: (
    modelText: string,
    displayText: string,
    senders?: readonly string[],
  ) => void;
  /**
   * Roster membership changes. Status changes and idle pulses are deliberately
   * not reported: they fire on every transition, and each one would wake the
   * leader into an automatic turn for noise.
   */
  readonly reportRosterChange: (change: {
    type: 'joined' | 'exited';
    name: string;
    status?: string;
    /**
     * True when the team teardown published this exit as part of a burst. The
     * listener must still learn about every member, but turning each one into
     * its own leader turn is the noise the activity path exists to avoid.
     */
    teardown?: boolean;
  }) => void;
  /**
   * Observational teammate progress (tool calls/results) and inter-teammate
   * messages, for UI display only. Emitted as display frames without entering
   * the notification queue, so they never wake the leader into an automatic
   * turn.
   */
  readonly reportTeammateActivity: (activity: {
    kind: 'tool' | 'message';
    name: string;
    toolName?: string;
    phase?: 'call' | 'result';
    success?: boolean;
    description?: string;
    from?: string;
    to?: string;
    message?: string;
  }) => void;
  readonly retireTeamBinding: (bindingId: number) => Promise<void>;
  /**
   * Retires a single teammate's pending approvals on the host. A teammate's
   * approval is session-scoped, so it outlives the leader turn that happens to
   * be running — and the abort that clears the child-side await never crosses
   * the wire, so the host keeps advertising an unanswerable prompt unless the
   * exit is reported.
   */
  readonly retireTeammateApprovals: (teammateName: string) => Promise<void>;
  /** Asks the ACP client to decide a teammate's tool approval. */
  readonly requestPermission: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
}

/**
 * Wires Agent Team coordination into an ACP-hosted session.
 *
 * Team tool registration is gated on `Config.isAgentTeamEnabled()`, which knows
 * nothing about the host, while the leader callback and the approval listener
 * are attached by the TUI and the stream-json CLI only. On every other host the
 * result is a silent failure: a model creates a team, teammates run, and their
 * reports are never delivered — `pollLeaderInbox()` returns before consuming
 * when no callback is attached, so the leader is never woken — while
 * `TEAMMATE_APPROVAL_REQUEST` is emitted with no listener, so a blocked
 * teammate is neither approved nor cancelled.
 *
 * Returns an idempotent detach function.
 */
export function attachTeamSink(deps: TeamSinkDeps): () => void {
  let boundManager: TeamManager | null = null;
  let bindingId = 0;
  let bindingController: AbortController | null = null;
  let approvalListener: ((event: TeammateApprovalRequestEvent) => void) | null =
    null;
  let joinedListener: ((event: TeammateJoinedEvent) => void) | null = null;
  let exitedListener: ((event: TeammateExitedEvent) => void) | null = null;
  let activityListener: ((event: TeammateActivityEvent) => void) | null = null;
  let messageSentListener: ((event: MessageSentEvent) => void) | null = null;
  let detached = false;

  const detachFromManager = (manager: TeamManager): void => {
    bindingController?.abort();
    bindingController = null;
    void deps.retireTeamBinding(bindingId).catch((error) => {
      debugLogger.warn('Failed to retract teammate approvals:', error);
    });
    manager.setLeaderMessageCallback(null);
    const emitter = manager.getEventEmitter();
    if (approvalListener) {
      emitter.off(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
      approvalListener = null;
    }
    if (joinedListener) {
      emitter.off(TeamEventType.TEAMMATE_JOINED, joinedListener);
      joinedListener = null;
    }
    if (exitedListener) {
      emitter.off(TeamEventType.TEAMMATE_EXITED, exitedListener);
      exitedListener = null;
    }
    if (activityListener) {
      emitter.off(TeamEventType.TEAMMATE_ACTIVITY, activityListener);
      activityListener = null;
    }
    if (messageSentListener) {
      emitter.off(TeamEventType.MESSAGE_SENT, messageSentListener);
      messageSentListener = null;
    }
  };

  const swallow = (error: unknown, what: string): void => {
    debugLogger.warn(`Teammate approval ${what} failed:`, error);
  };

  const respondCancel = (
    event: TeammateApprovalRequestEvent,
    reason: string,
  ): void => {
    // `respond` rejects when the teammate terminates between the request and
    // the answer; an unhandled rejection here would take the process down.
    event
      .respond(ToolConfirmationOutcome.Cancel, { cancelMessage: reason })
      .catch((error) => swallow(error, 'Cancel'));
    // Tell the leader too, otherwise it only sees a teammate that gave up.
    deps.injectLeaderMessage(
      `<team_notice>\n${reason}\n</team_notice>`,
      `[team] ${reason}`,
    );
  };

  const handleApproval = (
    event: TeammateApprovalRequestEvent,
    signal: AbortSignal,
    requestBindingId: number,
  ): void => {
    const who = `tool ${event.toolName} requested by teammate "${event.teammateName}"`;
    const details = event.confirmationDetails;

    if (!details) {
      // Nothing renderable to prompt with. YOLO proceeds, matching the
      // stream-json fallback; any other mode fails closed rather than letting
      // a teammate run an unreviewed tool.
      if (deps.config.getApprovalMode() === ApprovalMode.YOLO) {
        event
          .respond(ToolConfirmationOutcome.ProceedOnce)
          .catch((error) => swallow(error, 'ProceedOnce'));
        return;
      }
      respondCancel(
        event,
        `Cannot prompt for ${who}: the request carried no approval details.`,
      );
      return;
    }

    const full = {
      ...details,
      // The runtime owns the callback; the permission helpers only read the
      // renderable fields, so a no-op satisfies the type without inventing a
      // second resolution path.
      onConfirm: async () => {},
    } as unknown as ToolCallConfirmationDetails;

    const options = toPermissionOptions(
      full,
      false,
      deps.permissionPersistencePolicy,
    );
    if (options.length === 0) {
      respondCancel(
        event,
        `Cannot prompt for ${who}: the approval offered no selectable options.`,
      );
      return;
    }
    const offered = options.map((option) => ({ ...option }));
    const params: RequestPermissionRequest = {
      sessionId: deps.sessionId,
      _meta: {
        permissionScope: 'session',
        teammateBindingId: requestBindingId,
      },
      options,
      toolCall: {
        toolCallId: `teammate-${randomUUID()}`,
        status: 'pending',
        title: `Teammate "${event.teammateName}" requests ${event.toolName}`,
        content: buildPermissionRequestContent(full),
        rawInput: event.toolInput,
        _meta: {
          toolName: event.toolName,
          teammateName: event.teammateName,
          ...interactionMetaFields(full),
        },
      },
    };

    const cancelOnAbort = (): void => {
      event
        .respond(ToolConfirmationOutcome.Cancel)
        .catch((error) => swallow(error, 'Cancel'));
    };
    if (signal.aborted) {
      cancelOnAbort();
      return;
    }
    signal.addEventListener('abort', cancelOnAbort, { once: true });

    void (async () => {
      try {
        const output = await deps.requestPermission(params, signal);
        if (signal.aborted) return;
        signal.removeEventListener('abort', cancelOnAbort);
        let outcome: ToolConfirmationOutcome;
        try {
          outcome = resolvePermissionOutcome(output, offered);
        } catch (error) {
          // The host answered, but named an option the policy filter stripped.
          // That is a client contract violation, not a host failure: cancel the
          // tool without telling the leader the host stayed silent.
          debugLogger.warn(
            `Teammate permission answer for ${who} named no offered option; cancelling without a leader notice.`,
            error,
          );
          // No `<team_notice>`: the host did answer, so the leader must not be
          // told it stayed silent. The tool still cannot proceed unreviewed.
          event
            .respond(ToolConfirmationOutcome.Cancel)
            .catch((respondError) => swallow(respondError, 'Cancel'));
          return;
        }
        // Past this point the host *has* answered, so a rejection from
        // `respond` is the resumed tool body failing, not an unanswered
        // approval. It must not reach the fail-closed branch: the cancel there
        // is a no-op (`agent-core` latches `responded` before awaiting
        // `onConfirm`) and its leader notice would say something false.
        try {
          await event.respond(outcome, {
            answers:
              'answers' in output
                ? (output['answers'] as Record<string, string> | undefined)
                : undefined,
          });
        } catch (error) {
          swallow(error, 'post-answer respond');
        }
      } catch (error) {
        if (signal.aborted) return;
        debugLogger.error('Teammate permission request failed:', error);
        // Fail closed, matching SubAgentTracker: a teammate whose approval
        // cannot be answered must not proceed unreviewed.
        respondCancel(
          event,
          `The host could not answer the approval for ${who}.`,
        );
      } finally {
        signal.removeEventListener('abort', cancelOnAbort);
      }
    })();
  };

  const handleJoined = (event: TeammateJoinedEvent): void => {
    deps.reportRosterChange({ type: 'joined', name: event.name });
  };

  const handleExited = (event: TeammateExitedEvent): void => {
    // Order matters only in that both must happen: the roster notice keeps a
    // membership-tracking client honest, and the retirement stops the host
    // advertising a prompt the exited teammate can no longer answer.
    deps
      .retireTeammateApprovals(event.name)
      .catch((error) => swallow(error, 'retireTeammateApprovals'));
    deps.reportRosterChange({
      type: 'exited',
      name: event.name,
      status: event.status,
      ...(event.teardown ? { teardown: true } : {}),
    });
  };

  const handleActivity = (event: TeammateActivityEvent): void => {
    deps.reportTeammateActivity({
      kind: 'tool',
      name: event.name,
      toolName: event.toolName,
      phase: event.phase,
      success: event.success,
      description: event.description,
    });
  };

  const handleMessageSent = (event: MessageSentEvent): void => {
    if (event.to === LEADER_NAME) return;
    deps.reportTeammateActivity({
      kind: 'message',
      name: event.from,
      from: event.from,
      to: event.to,
      message: event.message,
    });
  };

  const handleManagerChange = (manager: TeamManager | null): void => {
    if (detached) return;
    // Same-instance re-notification: Config.setTeamManager fires the change
    // callbacks even when the manager object is identical, so without this
    // guard the five emitter.on() calls below would register a second copy of
    // every listener — one approval request would prompt the host twice and
    // race two respond() calls, and detach() would leave one copy leaked.
    if (boundManager === manager) return;
    if (boundManager) {
      detachFromManager(boundManager);
    }
    boundManager = manager;
    if (!manager) return;

    manager.setLeaderMessageCallback((modelText, displayText, senders) => {
      deps.injectLeaderMessage(modelText, displayText, senders);
    });
    const emitter = manager.getEventEmitter();
    bindingController = new AbortController();
    bindingId = ++nextBindingId;
    const requestBindingId = bindingId;
    const signal = AbortSignal.any([deps.signal, bindingController.signal]);
    approvalListener = (event) =>
      handleApproval(event, signal, requestBindingId);
    emitter.on(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
    joinedListener = handleJoined;
    emitter.on(TeamEventType.TEAMMATE_JOINED, joinedListener);
    exitedListener = handleExited;
    emitter.on(TeamEventType.TEAMMATE_EXITED, exitedListener);
    activityListener = handleActivity;
    emitter.on(TeamEventType.TEAMMATE_ACTIVITY, activityListener);
    messageSentListener = handleMessageSent;
    emitter.on(TeamEventType.MESSAGE_SENT, messageSentListener);
  };

  deps.config.onTeamManagerChange(handleManagerChange);
  // A team may already exist before this session subscribes.
  const existing = deps.config.getTeamManager();
  if (existing) handleManagerChange(existing);

  return () => {
    if (detached) return;
    detached = true;
    deps.config.onTeamManagerChange(null, handleManagerChange);
    if (boundManager) {
      detachFromManager(boundManager);
      boundManager = null;
    }
  };
}
