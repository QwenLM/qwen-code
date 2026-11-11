/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CronList tool — lists all active cron jobs.
 */

import { CRON_LIST_TOOL_NAME, CRON_LIST_DISPLAY_NAME } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type CronListResultDisplay,
} from './tools.js';
import { cronToHuman } from '../cron/index.js';
import type { Config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CronListToolParams {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CronListToolResult extends ToolResult {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class CronListToolInvocation extends BaseToolInvocation<
  CronListToolParams,
  CronListToolResult
> {
  constructor(
    private readonly config: Config,
    params: CronListToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return 'Listing all scheduled cron jobs';
  }

  async execute(_signal: AbortSignal): Promise<CronListToolResult> {
    // This session's cron manager: the merged list is the shared file plus this
    // session's own in-memory tasks, never another session's.
    const tasks = await this.config.getCronManager().listTasks();

    if (tasks.length === 0) {
      return {
        llmContent: 'No scheduled jobs.',
        returnDisplay: {
          cronResultType: 'list',
          jobs: [],
        } satisfies CronListResultDisplay,
        data: { jobs: [] },
      };
    }

    const jobs = tasks.map((t) => ({
      id: t.id,
      cron: t.cron,
      humanSchedule: cronToHuman(t.cron),
      prompt: t.prompt,
      recurring: t.recurring ?? false,
      durable: t.durable ?? true,
      permanent: t.permanent ?? false,
    }));

    const lines = jobs.map(
      (j) =>
        `${j.id} — ${j.humanSchedule}${j.recurring ? ' (recurring)' : ' (one-shot)'}${j.permanent ? ' [permanent]' : ''}${!j.durable ? ' [session-only]' : ''}: ${j.prompt.length > 80 ? j.prompt.slice(0, 77) + '...' : j.prompt}`,
    );

    const resultMessage = lines.join('\n');
    return {
      llmContent: resultMessage,
      returnDisplay: {
        cronResultType: 'list',
        jobs,
      } satisfies CronListResultDisplay,
      data: { jobs },
    };
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class CronListTool extends BaseDeclarativeTool<
  CronListToolParams,
  CronListToolResult
> {
  static readonly Name = CRON_LIST_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      CronListTool.Name,
      CRON_LIST_DISPLAY_NAME,
      'List all active scheduled cron jobs, including their IDs, schedules, prompts, and settings.',
      Kind.Read,
      {
        type: 'object',
        properties: {},
      },
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: CronListToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<CronListToolParams, CronListToolResult> {
    return new CronListToolInvocation(this.config, params, _toolName, _toolDisplayName);
  }
}
