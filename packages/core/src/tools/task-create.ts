/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * task_create tool — create a new task in the team task list.
 */

import type {
  ToolCallConfirmationDetails,
  ToolInfoConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { resolveActiveTeamName } from '../agents/team/identity.js';
import { createTask } from '../agents/team/tasks.js';

export interface TaskCreateParams {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

/** Cap on how much of a task description the confirmation dialog shows. */
const CONFIRMATION_DESCRIPTION_LIMIT = 2000;

/**
 * Truncate a task description for the interactive confirmation dialog.
 * Descriptions can be up to 10KB; the dialog needs enough to judge the
 * instruction, not the whole payload.
 */
export function truncateForConfirmation(text: string): string {
  if (text.length <= CONFIRMATION_DESCRIPTION_LIMIT) return text;
  return (
    `${text.slice(0, CONFIRMATION_DESCRIPTION_LIMIT)}\n` +
    `… (${text.length - CONFIRMATION_DESCRIPTION_LIMIT} more characters)`
  );
}

class TaskCreateInvocation extends BaseToolInvocation<
  TaskCreateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: TaskCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Create task: ${this.params.subject}`;
  }

  /**
   * A task's `description` becomes the prompt an idle teammate auto-claims
   * and executes with full tool access — the same privileged-sink shape as
   * `send_message`, where free-form text turns into a new instruction for
   * another agent. The base default `'allow'` short-circuits the classifier
   * in AUTO mode, so override to `'ask'` to keep that injection path under
   * the classifier / human-in-the-loop.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  /**
   * Unlike the one-line getDescription() used for transcript rendering,
   * the confirmation prompt must show the instruction text itself: the
   * `description` is what an idle teammate will auto-claim and execute
   * with full tool access, so it is exactly what the human is approving.
   */
  override getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const details: ToolInfoConfirmationDetails = {
      type: 'info',
      title: 'Confirm TaskCreate',
      prompt:
        `Create task: ${this.params.subject}\n\n` +
        truncateForConfirmation(this.params.description),
      onConfirm: async () => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return Promise.resolve(details);
  }

  async execute(): Promise<ToolResult> {
    const teamName = resolveActiveTeamName(
      this.config.getTeamContext()?.teamName,
    );
    if (!teamName) {
      const msg = 'No active team. Create a team first.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg },
      };
    }

    const task = await createTask(teamName, {
      subject: this.params.subject,
      description: this.params.description,
      activeForm: this.params.activeForm,
      metadata: this.params.metadata,
    });

    const llmContent = `Task #${task.id} created: "${task.subject}"`;
    return { llmContent, returnDisplay: llmContent };
  }
}

export class TaskCreateTool extends BaseDeclarativeTool<
  TaskCreateParams,
  ToolResult
> {
  static readonly Name = ToolNames.TASK_CREATE;

  constructor(private config: Config) {
    super(
      TaskCreateTool.Name,
      ToolDisplayNames.TASK_CREATE,
      'Create a new task in the team task list. ' +
        'Tasks are automatically assigned to idle teammates.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Short title for the task.',
            maxLength: 200,
          },
          description: {
            type: 'string',
            description: 'Detailed description of the task.',
            maxLength: 10000,
          },
          activeForm: {
            type: 'string',
            maxLength: 200,
            description:
              'Present tense label for UI ' + '(e.g., "Running tests").',
          },
          metadata: {
            type: 'object',
            description: 'Optional arbitrary metadata.',
          },
        },
        required: ['subject', 'description'],
        additionalProperties: false,
      },
    );
  }

  protected createInvocation(
    params: TaskCreateParams,
  ): ToolInvocation<TaskCreateParams, ToolResult> {
    return new TaskCreateInvocation(this.config, params);
  }

  /**
   * Forward the task content to the classifier. The base sentinel `''`
   * projects to an empty args object, so without this override the AUTO
   * classifier rules on `task_create({})` — the injected payload that
   * `getDefaultPermission() === 'ask'` exists to inspect would be
   * invisible to it. Mirrors `send_message`'s projection.
   */
  override toAutoClassifierInput(
    params: TaskCreateParams,
  ): Record<string, unknown> {
    return {
      subject: params.subject,
      description: params.description,
    };
  }
}
