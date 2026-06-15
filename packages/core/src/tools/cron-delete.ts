/**
 * cron_delete tool — deletes a cron job by ID (in-session or durable).
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  CRON_TASKS_DISPLAY_PATH,
  removeCronTasks,
} from '../services/cronTasksFile.js';

export interface CronDeleteParams {
  id: string;
}

class CronDeleteInvocation extends BaseToolInvocation<
  CronDeleteParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: CronDeleteParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return this.params.id;
  }

  async execute(): Promise<ToolResult> {
    const scheduler = this.config.getCronScheduler();
    let deleted: boolean;
    try {
      deleted = await scheduler.delete(this.params.id);
      if (!deleted) {
        // File fallback: a durable job from another session — or any
        // durable job in headless mode — is on disk but unknown to this
        // scheduler. Management is file-first; the owning session's file
        // watcher picks up the removal.
        deleted =
          (await removeCronTasks(this.config.getProjectRoot(), [
            this.params.id,
          ])) > 0;
      }
    } catch (error) {
      // Durable removal failed to persist — the job is restored, so don't
      // claim it was cancelled.
      const message = `Failed to cancel job ${this.params.id}: ${getErrorMessage(error)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }

    if (deleted) {
      const llmContent = `Cancelled job ${this.params.id}.`;
      const returnDisplay = `Cancelled ${this.params.id}`;
      return { llmContent, returnDisplay };
    } else {
      const result = `Job ${this.params.id} not found.`;
      return {
        llmContent: result,
        returnDisplay: result,
        error: { message: result },
      };
    }
  }
}

export class CronDeleteTool extends BaseDeclarativeTool<
  CronDeleteParams,
  ToolResult
> {
  static readonly Name = ToolNames.CRON_DELETE;

  constructor(private config: Config) {
    super(
      CronDeleteTool.Name,
      ToolDisplayNames.CRON_DELETE,
      `Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store or from ${CRON_TASKS_DISPLAY_PATH} (durable jobs).`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Job ID returned by CronCreate.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — only needed after CronCreate/CronList
      false, // alwaysLoad
      'cron delete cancel remove',
    );
  }

  protected createInvocation(
    params: CronDeleteParams,
  ): ToolInvocation<CronDeleteParams, ToolResult> {
    return new CronDeleteInvocation(this.config, params);
  }
}
