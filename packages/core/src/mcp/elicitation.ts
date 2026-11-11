/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { NotificationType } from '../hooks/types.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import { getMcpErrorMessage } from './errors.js';
import type { McpProgressReporter } from './client/progress.js';
import type { ElicitationBridge } from './mcpClientContext.js';

/**
 * Per-session elicitation wiring. The session manager supplies this only for
 * session-owned and SDK-injected servers; shared plugin/disk connections never
 * receive one.
 */
export interface McpElicitationHandler {
  request(
    params: ElicitRequest['params'],
    signal: AbortSignal | undefined,
    progressReporter: McpProgressReporter | undefined,
  ): Promise<ElicitResult>;
  complete?(elicitationId: string): void;
}

export function registerElicitationHandlers(
  client: Client,
  handler: McpElicitationHandler,
  progressReporter: McpProgressReporter | undefined,
): void {
  client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
    handler.request(request.params, extra?.signal, progressReporter),
  );

  // URL-mode elicitations complete asynchronously via this notification.
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    async (notification) => {
      handler.complete?.(notification.params.elicitationId);
    },
  );
}

/** Host services the session-level elicitation flow reads. */
export interface McpElicitationHostOptions {
  getHookSystem?(): HookSystem | undefined;
  emitDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    serverName?: string,
  ): void;
}

/**
 * Session-scoped elicitation service. It is handed only to session-owned
 * servers (dynamic and SDK-injected), which are the only registrations that
 * carry an elicitation handler.
 */
export class McpElicitationHost {
  private readonly options: McpElicitationHostOptions;
  private bridge: ElicitationBridge | undefined;

  constructor(options: McpElicitationHostOptions) {
    this.options = options;
  }

  setElicitationBridge(bridge: ElicitationBridge | undefined): void {
    this.bridge = bridge;
  }

  /**
   * Forward MCP `elicitation/create` requests through the user-configured
   * Elicitation hooks (which may short-circuit with an auto-response), then up
   * to the host bridge if no hook decided. Runs the response through
   * ElicitationResult hooks so user hooks can override the action/content.
   */
  async request(
    mcpServerName: string,
    requestParams: ElicitRequest['params'],
    signal: AbortSignal | undefined,
    progressReporter: McpProgressReporter | undefined,
  ): Promise<ElicitResult> {
  const mode: 'form' | 'url' = requestParams.mode === 'url' ? 'url' : 'form';
  const elicitationId =
    'elicitationId' in requestParams
      ? (requestParams.elicitationId as string | undefined)
      : undefined;
  const requestedSchema =
    'requestedSchema' in requestParams
      ? (requestParams.requestedSchema as Record<string, unknown> | undefined)
      : undefined;
  const url =
    'url' in requestParams
      ? (requestParams.url as string | undefined)
      : undefined;

  const hookSystem = this.options.getHookSystem?.();

  // Step 1 — Elicitation hooks. Hooks may auto-respond (short-circuit), block
  // (return decline), or pass through.
  let preempted: ElicitResult | undefined;
  if (hookSystem) {
    try {
      const hookResult = await hookSystem.fireElicitationEvent(
        mcpServerName,
        requestParams.message,
        {
          mode,
          ...(url ? { url } : {}),
          ...(elicitationId ? { elicitationId } : {}),
          ...(requestedSchema ? { requestedSchema } : {}),
        },
        signal,
      );
      const finalOutput = hookResult.finalOutput;
      if (finalOutput?.isBlockingDecision()) {
        preempted = { action: 'decline' };
      } else {
        const action = (
          finalOutput as
            | { getAction?: () => ElicitResult['action'] | undefined }
            | undefined
        )?.getAction?.();
        if (action === 'accept') {
          const content = (
            finalOutput as { getContent?: () => unknown } | undefined
          )?.getContent?.();
          preempted = {
            action,
            ...(content && typeof content === 'object'
              ? { content: content as ElicitResult['content'] }
              : {}),
          };
        } else if (action === 'decline' || action === 'cancel') {
          preempted = { action };
        }
      }
    } catch (error) {
      this.options.emitDiagnostic(
        'warning',
        `Elicitation hook failed for '${mcpServerName}': ${getMcpErrorMessage(error)}`,
        error,
        mcpServerName,
      );
    }
  }

  // Step 2 — forward to host bridge if no hook decided.
  let rawResult: ElicitResult;
  if (preempted) {
    rawResult = preempted;
  } else {
    const bridge = this.bridge;
    if (!bridge) {
      rawResult = { action: 'cancel' };
    } else {
      // A dialog can stay open longer than the tool call's idle budget; the
      // user waiting on it is not a stalled server.
      progressReporter?.pauseIdleTimeouts?.();
      try {
        const result = await bridge.requestElicitation(
          mcpServerName,
          requestParams,
          signal,
        );
        // Defensive normalization — the host might return a partial shape.
        rawResult =
          result &&
          (result.action === 'accept' ||
            result.action === 'decline' ||
            result.action === 'cancel')
            ? result
            : { action: 'cancel' };
      } catch (error) {
        this.options.emitDiagnostic(
          'warning',
          `Elicitation bridge failed for '${mcpServerName}': ${getMcpErrorMessage(error)}`,
          error,
          mcpServerName,
        );
        rawResult = { action: 'cancel' };
      } finally {
        progressReporter?.resumeIdleTimeouts?.();
      }
    }
  }

  // Step 3 — ElicitationResult hooks. Hooks can override action/content or
  // block (force decline). The base hookSystem.fireElicitationEvent already
  // fires an ElicitationDialog notification, but the result side has no
  // built-in notification — fire one here for observability.
  if (!hookSystem) {
    return rawResult;
  }
  try {
    const resultHook = await hookSystem.fireElicitationResultEvent(
      mcpServerName,
      rawResult.action,
      {
        ...(rawResult.content
          ? { content: rawResult.content as Record<string, unknown> }
          : {}),
        mode,
        ...(elicitationId ? { elicitationId } : {}),
      },
      signal,
    );
    const finalOutput = resultHook.finalOutput;
    if (finalOutput?.isBlockingDecision()) {
      return { action: 'decline' };
    }
    const overrideAction = (
      finalOutput as
        | { getAction?: () => ElicitResult['action'] | undefined }
        | undefined
    )?.getAction?.();
    if (overrideAction) {
      const overrideContent = (
        finalOutput as { getContent?: () => unknown } | undefined
      )?.getContent?.();
      return {
        action: overrideAction,
        ...(overrideAction === 'accept'
          ? overrideContent && typeof overrideContent === 'object'
            ? { content: overrideContent as ElicitResult['content'] }
            : rawResult.content
              ? { content: rawResult.content }
              : {}
          : {}),
      };
    }
    return rawResult;
  } catch (error) {
    this.options.emitDiagnostic(
      'warning',
      `ElicitationResult hook failed for '${mcpServerName}': ${getMcpErrorMessage(error)}`,
      error,
      mcpServerName,
    );
    return rawResult;
  }
}

  complete(mcpServerName: string, elicitationId: string): void {
    this.bridge?.notifyElicitationComplete?.(mcpServerName, elicitationId);

    void this.options
      .getHookSystem?.()
      ?.fireNotificationEvent(
        NotificationType.ElicitationComplete,
        `MCP server "${mcpServerName}" confirmed elicitation ${elicitationId} complete`,
        { mcpServerName, elicitationId },
      );
  }
}
