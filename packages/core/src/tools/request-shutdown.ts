/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * request_shutdown tool - ask a teammate to wind down.
 *
 * Leader-only **by registration**: `createToolRegistry` skips this tool when
 * building a subagent-context registry (`forSubAgent`), so a teammate's tool
 * list does not contain it and a teammate cannot emit a call for it at all.
 *
 * This used to be a `type: 'shutdown_request'` discriminator on `send_message`.
 * That shape was withdrawn because it made an illegal state *representable*:
 * the field was visible to every caller, its description ("structured message
 * type for control flow") reads as something a teammate writing a structured
 * report should set, and a teammate that set it had its report rejected and
 * discarded rather than delivered. Separating the tools makes the leader-only
 * property structural instead of a runtime error — see #9276.
 *
 * The delivered mailbox entry is unchanged: `sendStructuredMessage` still
 * writes `type: 'shutdown_request'` with `from: LEADER_NAME`. Only the tool
 * surface moved; the wire format did not.
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval,
  isSubagentLikeExecutionContext,
} from '../agents/runtime/subagent-plan-tool-policy.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface RequestShutdownParams {
  /** Teammate name to wind down. Bare name, no `@`. */
  to: string;
}

class RequestShutdownInvocation extends BaseToolInvocation<
  RequestShutdownParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: RequestShutdownParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Request shutdown for "${this.params.to}"`;
  }

  /**
   * Shutdown is cooperative — the teammate may reply `shutdown_rejected` — but
   * it still ends another agent's participation and releases its task
   * ownership. Keep the L4 default at 'ask' so AUTO routes through the
   * classifier rather than short-circuiting, matching `send_message`.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (isPlanRequiredTeammateAwaitingApproval(this.config)) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.REQUEST_SHUTDOWN,
      );
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    // Absence from a subagent registry is the primary guarantee, but it only
    // covers registries that were *built* with `forSubAgent`. Some dispatch
    // paths reuse the parent's registry untouched — `runSingleDispatch`'s
    // workflow fast path hands the leader's own registry to a subagent — and
    // that registry does contain this tool. So the runtime check has to cover
    // every subagent-like context, not just a teammate identity.
    //
    // Fail closed rather than impersonate the leader: `requestShutdown` writes
    // the mailbox entry as `from: LEADER_NAME` and arms shutdown_approved
    // tracking for the target.
    if (isSubagentLikeExecutionContext()) {
      const msg = 'Only the team leader can request shutdowns.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const teamManager = this.config.getTeamManager();
    if (!teamManager) {
      const msg = 'No active team. Create a team before requesting a shutdown.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const to = this.params.to?.trim();
    if (!to) {
      const msg = 'Recipient "to" is required.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    try {
      await teamManager.requestShutdown(to);
      const msg = `Shutdown requested for "${to}".`;
      return { llmContent: msg, returnDisplay: msg };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }
  }
}

export class RequestShutdownTool extends BaseDeclarativeTool<
  RequestShutdownParams,
  ToolResult
> {
  constructor(private readonly config: Config) {
    super(
      ToolNames.REQUEST_SHUTDOWN,
      ToolDisplayNames.REQUEST_SHUTDOWN,
      'Ask a teammate to finish its current work and wind down. ' +
        'The teammate replies "shutdown_approved" or "shutdown_rejected: <reason>". ' +
        'Once a shutdown is pending the teammate is excluded from automatic task assignment. ' +
        'Leader-only. To send a teammate ordinary text, use send_message instead.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Teammate name to wind down (bare name, no @).',
          },
        },
        required: ['to'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — shutting a teammate down is infrequent
      false, // alwaysLoad
      'shutdown teammate team stop wind down finish',
    );
  }

  protected createInvocation(
    params: RequestShutdownParams,
  ): ToolInvocation<RequestShutdownParams, ToolResult> {
    return new RequestShutdownInvocation(this.config, params);
  }

  /**
   * The recipient is the whole action — forward it so the classifier can see
   * which teammate is being wound down.
   */
  override toAutoClassifierInput(
    params: RequestShutdownParams,
  ): Record<string, unknown> {
    return { to: params.to };
  }
}
