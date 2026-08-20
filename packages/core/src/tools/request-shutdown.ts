/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { isSubagentLikeExecutionContext } from '../agents/runtime/subagent-plan-tool-policy.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export interface RequestShutdownParams {
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

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    if (isSubagentLikeExecutionContext()) {
      const msg = 'Only the team leader can request shutdowns.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const teamManager = this.config.getTeamManager();
    if (!teamManager) {
      const msg = 'No active team. Create a team before requesting a shutdown.';
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const to = this.params.to.trim();
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
  static readonly Name = ToolNames.REQUEST_SHUTDOWN;

  constructor(private readonly config: Config) {
    super(
      RequestShutdownTool.Name,
      ToolDisplayNames.REQUEST_SHUTDOWN,
      'Ask a teammate to finish its current work and shut down. ' +
        'Leader-only. Use send_message for ordinary text.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Teammate name to shut down (bare name, no @).',
          },
        },
        required: ['to'],
        additionalProperties: false,
      },
      true,
      false,
      true,
      false,
      'shutdown teammate team stop finish',
    );
  }

  protected createInvocation(
    params: RequestShutdownParams,
  ): ToolInvocation<RequestShutdownParams, ToolResult> {
    return new RequestShutdownInvocation(this.config, params);
  }

  override toAutoClassifierInput(
    params: RequestShutdownParams,
  ): Record<string, unknown> {
    return { to: params.to };
  }
}
