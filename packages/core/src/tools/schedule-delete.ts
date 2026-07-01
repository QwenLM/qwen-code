/**
 * schedule_delete tool — deletes a durable scheduled task by id.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';
import { deleteTask, sanitizeTaskId } from '../services/schedule/task-store.js';

export interface ScheduleDeleteParams {
  id: string;
}

class ScheduleDeleteInvocation extends BaseToolInvocation<
  ScheduleDeleteParams,
  ToolResult
> {
  getDescription(): string {
    return this.params.id;
  }

  async execute(): Promise<ToolResult> {
    const id = sanitizeTaskId(this.params.id);
    try {
      const deleted = await deleteTask(id);
      if (deleted) {
        const msg = `Deleted scheduled task "${id}".`;
        return { llmContent: msg, returnDisplay: `Deleted ${id}` };
      }
      const msg = `No scheduled task named "${id}".`;
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    } catch (error) {
      const message = `Failed to delete "${id}": ${getErrorMessage(error)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }
  }
}

export class ScheduleDeleteTool extends BaseDeclarativeTool<
  ScheduleDeleteParams,
  ToolResult
> {
  static readonly Name = ToolNames.SCHEDULE_DELETE;

  constructor(_config: Config) {
    super(
      ScheduleDeleteTool.Name,
      ToolDisplayNames.SCHEDULE_DELETE,
      'Delete a durable scheduled task (routine) by its id. Removes its ' +
        'definition, state, and run history from the store.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The task id (from schedule_list).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer
      false, // alwaysLoad
      'schedule delete remove cancel routine task',
    );
  }

  protected createInvocation(
    params: ScheduleDeleteParams,
  ): ToolInvocation<ScheduleDeleteParams, ToolResult> {
    return new ScheduleDeleteInvocation(params);
  }
}
