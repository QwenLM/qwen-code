/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CronDelete tool — cancels a scheduled cron job by ID.
 */

import { DEFAULT_DEFERRED_HINTS } from '../codemode/types.js';
import { CRON_DELETE_TOOL_NAME, CRON_DELETE_DISPLAY_NAME } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type CronDeleteResultDisplay,
} from './tools.js';
import type { Config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface CronDeleteToolParams {
  id: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CronDeleteToolResult extends ToolResult {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class CronDeleteToolInvocation extends BaseToolInvocation<
  CronDeleteToolParams,
  CronDeleteToolResult
> {
  constructor(
    private readonly config: Config,
    params: CronDeleteToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return `Cancelling cron job: ${this.params.id}`;
  }

  async execute(_signal: AbortSignal): Promise<CronDeleteToolResult> {
    const { id } = this.params;
    // Through this session's cron manager, so a session-only task of another session
    // in the same process is neither listed nor deletable from here.
    const cronManager = this.config.getCronManager();

    // Validate task exists
    const tasks = await cronManager.listTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      return {
        llmContent: `Error: No scheduled job with id '${id}'.`,
        returnDisplay: `No scheduled job with id '${id}'.`,
        error: {
          message: `No scheduled job with id '${id}'.`,
        },
      };
    }

    // Delete the task
    await cronManager.removeTasks([id]);

    const resultMessage = `Cancelled job ${id}.`;
    return {
      llmContent: resultMessage,
      returnDisplay: {
        cronResultType: 'delete',
        id,
      } satisfies CronDeleteResultDisplay,
      data: { id },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class CronDeleteTool extends BaseDeclarativeTool<
  CronDeleteToolParams,
  CronDeleteToolResult
> {
  override get exposureHints() {
    return DEFAULT_DEFERRED_HINTS;
  }
  static readonly Name = CRON_DELETE_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      CronDeleteTool.Name,
      CRON_DELETE_DISPLAY_NAME,
      'Cancel a scheduled cron job by its ID. The job will no longer fire.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Job ID returned by CronCreate.',
          },
        },
        required: ['id'],
      },
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: CronDeleteToolParams,
  ): string | null {
    if (!params.id || params.id.trim() === '') {
      return "The 'id' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: CronDeleteToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<CronDeleteToolParams, CronDeleteToolResult> {
    return new CronDeleteToolInvocation(this.config, params, _toolName, _toolDisplayName);
  }
}
