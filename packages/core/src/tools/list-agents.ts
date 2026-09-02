/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export type ListAgentsParams = Record<string, never>;

class ListAgentsInvocation extends BaseToolInvocation<
  ListAgentsParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ListAgentsParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'List background agents';
  }

  async execute(): Promise<ToolResult> {
    const agents = this.config
      .getBackgroundTaskRegistry()
      .getAll()
      .filter((entry) => entry.isBackgrounded)
      .map((entry) => ({
        task_id: entry.agentId,
        ...(entry.subagentType ? { subagent_type: entry.subagentType } : {}),
        description: entry.description,
        status: entry.status,
        can_message:
          !entry.resumeBlockedReason &&
          (entry.status === 'running' ||
            entry.status === 'paused' ||
            entry.status === 'completed'),
        ...(entry.resumeBlockedReason
          ? { resume_blocked_reason: entry.resumeBlockedReason }
          : {}),
      }));

    if (agents.length === 0) {
      const message = 'No background agents are available in this session.';
      return { llmContent: message, returnDisplay: message };
    }

    return {
      llmContent: JSON.stringify({ agents }),
      returnDisplay: `Listed ${agents.length} background agent${
        agents.length === 1 ? '' : 's'
      }.`,
    };
  }
}

export class ListAgentsTool extends BaseDeclarativeTool<
  ListAgentsParams,
  ToolResult
> {
  static readonly Name = ToolNames.LIST_AGENTS;

  constructor(private readonly config: Config) {
    super(
      ListAgentsTool.Name,
      ToolDisplayNames.LIST_AGENTS,
      'List addressable background agents in the current session, including ' +
        'agents restored from a prior session run. Use the returned task_id ' +
        'with send_message to continue a running, paused, or completed agent.',
      Kind.Read,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: ListAgentsParams,
  ): ToolInvocation<ListAgentsParams, ToolResult> {
    return new ListAgentsInvocation(this.config, params);
  }
}
