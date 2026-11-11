/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getBusinessInfoFromContext,
  getCustomContextFromContext,
} from '../utils/sessionIdContext.js';
import type { Config } from '../config/config.js';
import {
  isInternalTask,
  type CreateTaskInput,
  type TaskListItem,
  type UpdateTaskInput,
} from '../tasks/task-list-types.js';
import {
  TASK_CREATE_DECLARATION,
  TASK_GET_DECLARATION,
  TASK_LIST_DECLARATION,
  TASK_UPDATE_DECLARATION,
} from './definitions/taskTools.js';
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { isRecord } from '../utils/markdownUtils.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolUseContext } from './tool-types.js';
import { getAgentContext } from '../utils/agentContext.js';
import {
  deriveSessionTeamName,
  isInProcessTeammateFeatureEnabled,
} from '../agents/teams/agent-teams-feature.js';
import {
  readAgentTeamConfig,
  sendTeamMessage,
  TEAM_LEAD_MEMBER_NAME,
} from '../agents/teams/agent-team-runtime.js';
import { signalTeammateController } from '../agents/teams/agent-team-controller.js';
import { wakeTeamMemberIfIdle } from '../agents/teams/agent-team-wakeup.js';

export type TaskCreateToolParams = CreateTaskInput;
export interface TaskGetToolParams {
  taskId: string;
}
export interface TaskUpdateToolParams extends UpdateTaskInput {
  taskId: string;
}
export type TaskListToolParams = Record<string, never>;

export interface TaskCreateToolOutput {
  task: {
    id: string;
    subject: string;
  };
}

export interface TaskGetToolOutput {
  task: {
    id: string;
    subject: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed';
    blocks: string[];
    blockedBy: string[];
  } | null;
}

export interface TaskUpdateToolOutput {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: {
    from: string;
    to: string;
  };
}

export interface TaskListToolOutput {
  tasks: Array<{
    id: string;
    subject: string;
    status: 'pending' | 'in_progress' | 'completed';
    owner?: string;
    blockedBy: string[];
  }>;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim() !== '';
}

/** A batch payload — the caller tried to pass multiple items in one call. */
function looksLikeBatchInput(record: Record<string, unknown>): boolean {
  return 'tasks' in record || 'todos' in record;
}

/** Agent-tool parameters — the caller confused TaskCreate with the Agent tool. */
function hasAgentToolParams(record: Record<string, unknown>): boolean {
  return 'prompt' in record || 'subagent_type' in record;
}

/** Both required TaskCreate fields are present and non-empty. */
function hasBothRequiredFields(record: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(record['subject']) &&
    isNonEmptyString(record['description'])
  );
}

function replaceRecord(
  target: Record<string, unknown>,
  replacement: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function truncateSubject(description: string): string {
  const trimmed = description.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= 80) return trimmed;
  const prefix = characters.slice(0, 80).join('');
  const lastSpace = prefix.lastIndexOf(' ');
  return (lastSpace > 40 ? prefix.slice(0, lastSpace) : prefix).trim();
}

function coerceTaskCreateInput(value: unknown): boolean {
  if (!isRecord(value) || looksLikeBatchInput(value)) return false;

  const input = { ...value };
  if (hasAgentToolParams(input) && !hasBothRequiredFields(input)) {
    return false;
  }

  let changed = false;
  if (
    !('subject' in input) &&
    !('description' in input) &&
    'task' in input
  ) {
    const task = input['task'];
    if (isNonEmptyString(task)) {
      delete input['task'];
      input['description'] = task;
      changed = true;
    } else if (isRecord(task)) {
      if (looksLikeBatchInput(task)) return false;
      if (hasAgentToolParams(task) && !hasBothRequiredFields(task)) {
        return false;
      }
      delete input['task'];
      Object.assign(input, task);
      changed = true;
    } else {
      return false;
    }
  }

  const aliases: ReadonlyArray<readonly [readonly string[], string]> = [
    [['title', 'name'], 'subject'],
    [['content'], 'description'],
    [['active_form'], 'activeForm'],
  ];
  for (const [sourceNames, targetName] of aliases) {
    for (const sourceName of sourceNames) {
      if (
        sourceName in input &&
        !(targetName in input) &&
        isNonEmptyString(input[sourceName])
      ) {
        input[targetName] = input[sourceName];
        delete input[sourceName];
        changed = true;
      }
    }
  }

  if (isNonEmptyString(input['subject']) && !('description' in input)) {
    input['description'] = input['subject'];
    changed = true;
  } else if (
    isNonEmptyString(input['description']) &&
    !('subject' in input)
  ) {
    input['subject'] = truncateSubject(input['description']);
    changed = true;
  }

  if (
    isNonEmptyString(input['subject']) &&
    isNonEmptyString(input['description'])
  ) {
    const allowedKeys = new Set([
      'subject',
      'description',
      'activeForm',
      'metadata',
    ]);
    for (const key of Object.keys(input)) {
      if (!allowedKeys.has(key)) {
        delete input[key];
        changed = true;
      }
    }
    if ('activeForm' in input && !isString(input['activeForm'])) {
      delete input['activeForm'];
      changed = true;
    }
    if ('metadata' in input && !isRecord(input['metadata'])) {
      delete input['metadata'];
      changed = true;
    }
  }

  if (!changed) return false;
  replaceRecord(value, input);
  return true;
}

function getTaskCreateValidationSteer(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const wrappedTask = isRecord(value['task']) ? value['task'] : undefined;
  if (
    looksLikeBatchInput(value) ||
    (wrappedTask && looksLikeBatchInput(wrappedTask))
  ) {
    return 'TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.';
  }
  if (
    (hasAgentToolParams(value) ||
      (wrappedTask && hasAgentToolParams(wrappedTask))) &&
    !hasBothRequiredFields(value)
  ) {
    return 'This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.';
  }
  return null;
}

function coerceTaskUpdateInput(value: unknown): void {
  if (!isRecord(value)) return;
  const input = { ...value };
  let changed = false;
  const aliases: ReadonlyArray<readonly [readonly string[], string]> = [
    [['id', 'task_id'], 'taskId'],
    [['active_form'], 'activeForm'],
  ];
  for (const [sourceNames, targetName] of aliases) {
    for (const sourceName of sourceNames) {
      if (
        sourceName in input &&
        !(targetName in input) &&
        isNonEmptyString(input[sourceName])
      ) {
        input[targetName] = input[sourceName];
        delete input[sourceName];
        changed = true;
      }
    }
  }
  if (changed) replaceRecord(value, input);
}

function executionFailure(action: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    llmContent: `Error ${action}: ${message}`,
    returnDisplay: message,
    error: {
      message,
      type: ToolErrorType.EXECUTION_FAILED,
    },
  };
}

function formatTaskDetails(task: TaskListItem): string {
  const details = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ];
  if (task.blockedBy.length > 0) {
    details.push(
      `Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(', ')}`,
    );
  }
  if (task.blocks.length > 0) {
    details.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(', ')}`);
  }
  return details.join('\n');
}

function buildTaskGetOutput(task: TaskListItem | null): TaskGetToolOutput {
  if (!task || isInternalTask(task)) return { task: null };
  return {
    task: {
      id: task.id,
      subject: task.subject,
      description: task.description,
      status: task.status,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
    },
  };
}

function buildTaskListOutput(tasks: TaskListItem[]): TaskListToolOutput {
  const completedIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.id),
  );
  return {
    tasks: tasks
      .filter((task) => !isInternalTask(task))
      .map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        ...(task.owner ? { owner: task.owner } : {}),
        blockedBy: task.blockedBy.filter((id) => !completedIds.has(id)),
      })),
  };
}

function formatTaskList(tasks: TaskListItem[]): string {
  const output = buildTaskListOutput(tasks);
  if (output.tasks.length === 0) return 'No tasks found';
  return output.tasks
    .map((task) => {
      const owner = task.owner ? ` (${task.owner})` : '';
      const blocked =
        task.blockedBy.length > 0
          ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(', ')}]`
          : '';
      return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
    })
    .join('\n');
}

async function notifyTaskAssignment(params: {
  config: Config;
  context?: AgentLoopContext;
  task: TaskListItem;
  assignedBy: string;
}): Promise<void> {
  const owner = params.task.owner;
  if (!owner || owner === TEAM_LEAD_MEMBER_NAME) return;
  const teamName = deriveSessionTeamName(params.config.getSessionId());
  const team = await readAgentTeamConfig(teamName);
  const member = team?.members.find(
    (candidate) => candidate.name === owner && candidate.status !== 'stopped',
  );
  if (!member) return;

  const message = JSON.stringify({
    type: 'task_assignment',
    taskId: params.task.id,
    subject: params.task.subject,
    description: params.task.description,
    assignedBy: params.assignedBy,
    timestamp: new Date().toISOString(),
  });
  await sendTeamMessage({
    businessInfo: params.task.businessInfo,
    customContext: getCustomContextFromContext(),
    teamName,
    from: params.assignedBy,
    to: member.name,
    text: message,
  });
  if (signalTeammateController(member.agentId)) return;
  await wakeTeamMemberIfIdle({
    context: params.context,
    teamName,
    memberName: member.name,
    senderName: params.assignedBy,
    message,
    customContext: getCustomContextFromContext(),
    allowStaleRunning: true,
  });
}

async function getHookBlockReason(
  hookResult: Awaited<
    ReturnType<
      NonNullable<ReturnType<Config['getHookSystem']>>['fireTaskCreatedEvent']
    >
  >,
): Promise<{ reason: string; stopped: boolean } | null> {
  if (hookResult.finalOutput?.shouldStopExecution()) {
    return {
      reason: hookResult.finalOutput.getEffectiveReason(),
      stopped: true,
    };
  }
  const blockingError = hookResult.finalOutput?.getBlockingError();
  return blockingError?.blocked
    ? { reason: blockingError.reason, stopped: false }
    : null;
}

class TaskCreateInvocation extends BaseToolInvocation<
  TaskCreateToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskCreateToolParams,
    toolName: string,
  ) {
    super(params, toolName);
  }

  getDescription(): string {
    return `Creating task: ${this.params.subject}`;
  }

  override async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const task = await this.config
        .getTaskStore()
        .createTask({
          ...this.params,
          businessInfo: getBusinessInfoFromContext(),
        });
      const hookResult = await this.config
        .getHookSystem()
        ?.fireTaskCreatedEvent(
          task.id,
          task.subject,
          { taskDescription: task.description },
          signal,
        );
      if (hookResult) {
        const blocked = await getHookBlockReason(hookResult);
        if (blocked) {
          await this.config.getTaskStore().deleteTask(task.id);
          return {
            llmContent: `Task creation ${blocked.stopped ? 'stopped' : 'blocked'} by hook: ${blocked.reason}`,
            returnDisplay: blocked.reason,
            error: {
              message: blocked.reason,
              type: blocked.stopped
                ? ToolErrorType.STOP_EXECUTION
                : ToolErrorType.EXECUTION_FAILED,
            },
          };
        }
      }
      return {
        llmContent: `Task #${task.id} created successfully: ${task.subject}`,
        returnDisplay: `Created task #${task.id}`,
        toolUseResult: {
          task: {
            id: task.id,
            subject: task.subject,
          },
        } satisfies TaskCreateToolOutput,
      };
    } catch (error) {
      return executionFailure('creating task', error);
    }
  }
}

export class TaskCreateTool extends BaseDeclarativeTool<
  TaskCreateToolParams,
  ToolResult
> {
  static readonly Name = TASK_CREATE_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      TaskCreateTool.Name,
      'Create Task',
      TASK_CREATE_DECLARATION.description!,
      Kind.Edit,
      TASK_CREATE_DECLARATION.parametersJsonSchema,
    );
  }

  override validateToolParams(params: TaskCreateToolParams): string | null {
    const rawInput = isRecord(params) ? { ...params } : params;
    coerceTaskCreateInput(params);
    const validationError = super.validateToolParams(params);
    return validationError
      ? (getTaskCreateValidationSteer(rawInput) ?? validationError)
      : null;
  }

  protected createInvocation(
    params: TaskCreateToolParams,
  ): TaskCreateInvocation {
    return new TaskCreateInvocation(this.config, params, this.name);
  }
}

class TaskGetInvocation extends BaseToolInvocation<
  TaskGetToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskGetToolParams,
    toolName: string,
  ) {
    super(params, toolName);
  }

  getDescription(): string {
    return `Retrieving task ${this.params.taskId}`;
  }

  override async execute(): Promise<ToolResult> {
    try {
      const task = await this.config.getTaskStore().getTask(this.params.taskId);
      if (!task || isInternalTask(task)) {
        return {
          llmContent: 'Task not found',
          returnDisplay: 'Task not found',
          toolUseResult: buildTaskGetOutput(null),
        };
      }
      const details = formatTaskDetails(task);
      return {
        llmContent: details,
        returnDisplay: details,
        toolUseResult: buildTaskGetOutput(task),
      };
    } catch (error) {
      return executionFailure('retrieving task', error);
    }
  }
}

export class TaskGetTool extends BaseDeclarativeTool<
  TaskGetToolParams,
  ToolResult
> {
  static readonly Name = TASK_GET_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      TaskGetTool.Name,
      'Get Task',
      TASK_GET_DECLARATION.description!,
      Kind.Read,
      TASK_GET_DECLARATION.parametersJsonSchema,
    );
  }

  protected createInvocation(params: TaskGetToolParams): TaskGetInvocation {
    return new TaskGetInvocation(this.config, params, this.name);
  }
}

class TaskUpdateInvocation extends BaseToolInvocation<
  TaskUpdateToolParams,
  ToolResult
> {
  private agentLoopContext?: AgentLoopContext;

  constructor(
    private readonly config: Config,
    params: TaskUpdateToolParams,
    toolName: string,
  ) {
    super(params, toolName);
  }

  getDescription(): string {
    return `Updating task ${this.params.taskId}`;
  }

  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    this.agentLoopContext = ctx.agentLoopContext;
    return this.execute(ctx.signal);
  }

  override async execute(signal: AbortSignal): Promise<ToolResult> {
    const { taskId, ...updates } = this.params;
    try {
      return await this.config
        .getTaskStore()
        .withTaskMutation(
          taskId,
          async (mutation) => {
            const current = await mutation.getTask();
            if (!current || isInternalTask(current)) {
              return {
                llmContent: 'Task not found',
                returnDisplay: 'Task not found',
                toolUseResult: {
                  success: false,
                  taskId,
                  updatedFields: [],
                  error: 'Task not found',
                } satisfies TaskUpdateToolOutput,
              };
            }
            const currentAgent = getAgentContext();
            if (
              isInProcessTeammateFeatureEnabled() &&
              updates.status === 'in_progress' &&
              updates.owner === undefined &&
              !current.owner &&
              currentAgent?.teamName &&
              currentAgent.agentName
            ) {
              updates.owner = currentAgent.agentName;
            }
            if (
              updates.status === 'completed' &&
              current.status !== 'completed'
            ) {
              const hookResult = await this.config
                .getHookSystem()
                ?.fireTaskCompletedEvent(
                  current.id,
                  current.subject,
                  { taskDescription: current.description },
                  signal,
                );
              if (hookResult) {
                const blocked = await getHookBlockReason(hookResult);
                if (blocked) {
                  return {
                    llmContent: `Task completion ${blocked.stopped ? 'stopped' : 'blocked'} by hook: ${blocked.reason}`,
                    returnDisplay: blocked.reason,
                    toolUseResult: {
                      success: false,
                      taskId,
                      updatedFields: [],
                      error: blocked.reason,
                    } satisfies TaskUpdateToolOutput,
                    error: {
                      message: blocked.reason,
                      type: blocked.stopped
                        ? ToolErrorType.STOP_EXECUTION
                        : ToolErrorType.EXECUTION_FAILED,
                    },
                  };
                }
              }
            }
            const updatedFields: string[] = [];
            if (
              updates.subject !== undefined &&
              updates.subject !== current.subject
            ) {
              updatedFields.push('subject');
            }
            if (
              updates.description !== undefined &&
              updates.description !== current.description
            ) {
              updatedFields.push('description');
            }
            if (
              updates.activeForm !== undefined &&
              updates.activeForm !== current.activeForm
            ) {
              updatedFields.push('activeForm');
            }
            if (updates.owner !== undefined && updates.owner !== current.owner) {
              updatedFields.push('owner');
            }
            if (updates.metadata !== undefined) updatedFields.push('metadata');
            if (
              updates.status !== undefined &&
              updates.status !== 'deleted' &&
              updates.status !== current.status
            ) {
              updatedFields.push('status');
            }
            if (
              updates.addBlocks?.some((id) => !current.blocks.includes(id))
            ) {
              updatedFields.push('blocks');
            }
            if (
              updates.addBlockedBy?.some(
                (id) => !current.blockedBy.includes(id),
              )
            ) {
              updatedFields.push('blockedBy');
            }

          const task = await mutation.updateTask({
            ...updates,
            ...(updates.owner !== undefined && updates.owner !== current.owner
              ? { businessInfo: getBusinessInfoFromContext() }
              : {}),
          });
            if (!task) {
              updatedFields.length = 0;
              updatedFields.push('deleted');
            }
            const fieldSummary =
              updatedFields.length > 0 ? ` ${updatedFields.join(', ')}` : '';
            const output = `Updated task #${taskId}${fieldSummary}`;
            if (
              task &&
              updates.owner &&
              updates.owner !== current.owner &&
              isInProcessTeammateFeatureEnabled()
            ) {
              await notifyTaskAssignment({
                config: this.config,
                context: this.agentLoopContext,
                task,
                assignedBy: currentAgent?.agentName ?? 'team-lead',
              });
            }
            return {
              llmContent: output,
              returnDisplay: output,
              toolUseResult: {
                success: true,
                taskId,
                updatedFields,
                ...(task && current.status !== task.status
                  ? {
                      statusChange: {
                        from: current.status,
                        to: task.status,
                      },
                    }
                  : {}),
              } satisfies TaskUpdateToolOutput,
            };
          },
          signal,
        );
    } catch (error) {
      const result = executionFailure('updating task', error);
      const message = error instanceof Error ? error.message : String(error);
      result.toolUseResult = {
        success: false,
        taskId,
        updatedFields: [],
        error: message,
      } satisfies TaskUpdateToolOutput;
      return result;
    }
  }
}

export class TaskUpdateTool extends BaseDeclarativeTool<
  TaskUpdateToolParams,
  ToolResult
> {
  static readonly Name = TASK_UPDATE_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      TaskUpdateTool.Name,
      'Update Task',
      TASK_UPDATE_DECLARATION.description!,
      Kind.Edit,
      TASK_UPDATE_DECLARATION.parametersJsonSchema,
    );
  }

  override isConcurrencySafe(): boolean {
    return true;
  }

  override validateToolParams(params: TaskUpdateToolParams): string | null {
    coerceTaskUpdateInput(params);
    return super.validateToolParams(params);
  }

  protected createInvocation(
    params: TaskUpdateToolParams,
  ): TaskUpdateInvocation {
    return new TaskUpdateInvocation(this.config, params, this.name);
  }
}

class TaskListInvocation extends BaseToolInvocation<
  TaskListToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TaskListToolParams,
    toolName: string,
  ) {
    super(params, toolName);
  }

  getDescription(): string {
    return 'Listing tasks';
  }

  override async execute(): Promise<ToolResult> {
    try {
      const tasks = await this.config.getTaskStore().listTasks();
      const output = formatTaskList(tasks);
      return {
        llmContent: output,
        returnDisplay: output,
        toolUseResult: buildTaskListOutput(tasks),
      };
    } catch (error) {
      return executionFailure('listing tasks', error);
    }
  }
}

export class TaskListTool extends BaseDeclarativeTool<
  TaskListToolParams,
  ToolResult
> {
  static readonly Name = TASK_LIST_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      TaskListTool.Name,
      'List Tasks',
      TASK_LIST_DECLARATION.description!,
      Kind.Read,
      TASK_LIST_DECLARATION.parametersJsonSchema,
    );
  }

  protected createInvocation(params: TaskListToolParams): TaskListInvocation {
    return new TaskListInvocation(this.config, params, this.name);
  }
}
