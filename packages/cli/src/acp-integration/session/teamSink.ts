/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  ApprovalMode,
  TeamEventType,
  ToolConfirmationOutcome,
  createDebugLogger,
  type Config,
  type TeamManager,
  type TeammateApprovalRequestEvent,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import {
  buildPermissionRequestContent,
  interactionMetaFields,
  resolvePermissionOutcome,
  toPermissionOptions,
} from './permissionUtils.js';

const debugLogger = createDebugLogger('ACP_TEAM_SINK');

export interface TeamSinkDeps {
  readonly config: Config;
  readonly sessionId: string;
  /** Session lifetime. Aborting it cancels an in-flight teammate approval. */
  readonly signal: AbortSignal;
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
  let approvalListener: ((event: TeammateApprovalRequestEvent) => void) | null =
    null;
  let detached = false;

  const detachFromManager = (manager: TeamManager): void => {
    manager.setLeaderMessageCallback(null);
    if (approvalListener) {
      manager
        .getEventEmitter()
        .off(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
      approvalListener = null;
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

  const handleApproval = (event: TeammateApprovalRequestEvent): void => {
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

    const options = toPermissionOptions(full, false);
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
      options,
      toolCall: {
        toolCallId: `teammate-${event.teammateName}-${event.timestamp}`,
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

    void (async () => {
      try {
        const output = await deps.requestPermission(params, deps.signal);
        const outcome = resolvePermissionOutcome(output, offered);
        await event.respond(outcome, {
          answers:
            'answers' in output
              ? (output['answers'] as Record<string, string> | undefined)
              : undefined,
        });
      } catch (error) {
        debugLogger.error('Teammate permission request failed:', error);
        // Fail closed, matching SubAgentTracker: a teammate whose approval
        // cannot be answered must not proceed unreviewed.
        respondCancel(
          event,
          `The host could not answer the approval for ${who}.`,
        );
      }
    })();
  };

  const handleManagerChange = (manager: TeamManager | null): void => {
    if (detached) return;
    if (boundManager && boundManager !== manager) {
      detachFromManager(boundManager);
    }
    boundManager = manager;
    if (!manager) return;

    manager.setLeaderMessageCallback((modelText, displayText, senders) => {
      deps.injectLeaderMessage(modelText, displayText, senders);
    });
    approvalListener = handleApproval;
    manager
      .getEventEmitter()
      .on(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
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
