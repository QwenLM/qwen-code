/**
 * schedule_create tool — creates a durable, daemon-run scheduled task in the
 * global store (`~/.qwen/scheduled-tasks/<id>/SKILL.md`). Unlike cron_create
 * (session/durable cron enqueued into the running agent), a schedule task is a
 * self-contained routine fired by `qwen schedule daemon` as a fresh headless
 * run — it keeps working with no session open.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { ApprovalMode, APPROVAL_MODES } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { parseCron, nextFireTime } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import {
  readTask,
  sanitizeTaskId,
  writeTask,
  type ScheduledTask,
} from '../services/schedule/task-store.js';
import {
  ensureScheduleDaemonRunning,
  type EnsureDaemonResult,
} from '../services/schedule/ensure-daemon.js';

export interface ScheduleCreateParams {
  name: string;
  description: string;
  prompt: string;
  cron?: string;
  fireAt?: string;
  cwd?: string;
  model?: string;
  approvalMode?: string;
  sandbox?: boolean;
}

class ScheduleCreateInvocation extends BaseToolInvocation<
  ScheduleCreateParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: ScheduleCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const when = this.params.cron
      ? this.params.cron
      : (this.params.fireAt ?? 'manual');
    return `${this.params.name} (${when}): ${this.params.prompt}`;
  }

  /**
   * Creating a routine schedules an autonomous, unattended run with the task's
   * approval mode — it must go through the same classifier scrutiny as a direct
   * command, so the L3 default is 'ask', never 'allow' (see cron_create).
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    try {
      const id = sanitizeTaskId(this.params.name);
      const existed = (await readTask(id)) !== null;

      const approvalMode = resolveApprovalMode(this.params.approvalMode);
      const task: ScheduledTask = {
        id,
        name: id,
        description: this.params.description.trim(),
        schedule: buildSchedule(this.params),
        // Default to the session's working directory so the routine runs where
        // the user is; they can override with an explicit absolute cwd.
        cwd: this.params.cwd?.trim() || this.config.getWorkingDir(),
        model: this.params.model?.trim() || undefined,
        approvalMode,
        notify: 'next-session',
        sandbox: this.params.sandbox === true,
        prompt: this.params.prompt.trim(),
      };

      await writeTask(task);

      // Auto-start the daemon so a freshly created task actually fires without
      // the user having to run `qwen schedule daemon` by hand.
      const daemonState = await ensureScheduleDaemonRunning();

      const when = task.schedule.cron
        ? humanReadableCron(task.schedule.cron)
        : `once at ${task.schedule.fireAt}`;
      const verb = existed ? 'Updated' : 'Created';
      const returnDisplay = `${verb} scheduled task "${id}" (${when})`;
      const llmContent =
        `${verb} scheduled task "${id}" — ${when}, cwd ${task.cwd}, ` +
        `approvalMode ${task.approvalMode}. ${daemonNote(daemonState)} ` +
        `Manage with /schedule list|run|delete.`;
      return { llmContent, returnDisplay };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error creating scheduled task: ${message}`,
        returnDisplay: message,
        error: { message },
      };
    }
  }
}

function daemonNote(state: EnsureDaemonResult): string {
  switch (state) {
    case 'started':
      return 'Started the schedule daemon in the background — it will fire the task on schedule.';
    case 'already-running':
      return 'The schedule daemon is already running.';
    case 'disabled':
      return 'Auto-start is off (QWEN_SCHEDULE_NO_AUTOSTART); run `qwen schedule daemon` to fire it.';
    case 'dev-manual':
      return 'In dev, start the daemon in a separate terminal to fire it: `npm run dev -- schedule daemon`.';
    case 'failed':
    default:
      return 'Could not auto-start the daemon; run `qwen schedule daemon` to fire it.';
  }
}

function resolveApprovalMode(raw: string | undefined): ApprovalMode {
  if (raw === undefined) return ApprovalMode.AUTO;
  if (!(APPROVAL_MODES as string[]).includes(raw)) {
    throw new Error(
      `Invalid approvalMode "${raw}". Use one of: ${APPROVAL_MODES.join(', ')}.`,
    );
  }
  return raw as ApprovalMode;
}

function buildSchedule(
  params: ScheduleCreateParams,
): ScheduledTask['schedule'] {
  const hasCron = !!params.cron?.trim();
  const hasFireAt = !!params.fireAt?.trim();
  if (hasCron === hasFireAt) {
    throw new Error('Provide exactly one of "cron" or "fireAt".');
  }
  if (hasCron) {
    const cron = params.cron!.trim();
    parseCron(cron);
    // Reject expressions that parse but never fire (e.g. "0 0 30 2 *").
    nextFireTime(cron, new Date());
    return { cron, enabled: true };
  }
  const fireAt = params.fireAt!.trim();
  const ms = Date.parse(fireAt);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid fireAt "${fireAt}" — use an ISO 8601 timestamp.`);
  }
  if (ms <= Date.now()) {
    throw new Error(`fireAt "${fireAt}" must be in the future.`);
  }
  return { fireAt, enabled: true };
}

export class ScheduleCreateTool extends BaseDeclarativeTool<
  ScheduleCreateParams,
  ToolResult
> {
  static readonly Name = ToolNames.SCHEDULE_CREATE;

  constructor(private config: Config) {
    super(
      ScheduleCreateTool.Name,
      ToolDisplayNames.SCHEDULE_CREATE,
      'Create a durable scheduled task (routine) that runs on the local machine ' +
        'via the schedule daemon, even with no session open. Use for "every day at 9am", ' +
        '"each Monday", or a one-off "next Friday at 3pm" when the user wants it to keep ' +
        'running unattended (distinct from cron_create, which only fires while a session is open).\n\n' +
        'The task runs as a fresh headless `qwen -p` process each time with NO memory of this ' +
        'conversation, so `prompt` MUST be fully self-contained: state the repo/cwd, the goal, ' +
        'and what success looks like.\n\n' +
        'Schedule: pass exactly one of `cron` (5-field, local time, e.g. "0 9 * * 1-5" = weekdays 9am) ' +
        'or `fireAt` (ISO 8601 for a one-shot, e.g. "2026-07-02T15:00:00+08:00"). Prefer off-:00/:30 ' +
        'minutes for approximate times to spread load.\n\n' +
        'approvalMode controls the unattended run: "auto" (default; classifier auto-approves safe ' +
        'actions, blocks risky ones), "yolo" (approve everything), "auto-edit", "default", or "plan". ' +
        'A blocked action is recorded in the run summary, not prompted.\n\n' +
        'After creating, tell the user to run `qwen schedule daemon` if it is not already running, ' +
        'and that they can manage tasks with /schedule list|run|delete.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Short kebab-case task name, also used as its id/directory (e.g. "daily-pr-review"). Auto-sanitized.',
          },
          description: {
            type: 'string',
            description: 'One-line summary shown in /schedule list.',
          },
          prompt: {
            type: 'string',
            description:
              'The self-contained instructions run on each fire. Must not rely on any prior conversation.',
          },
          cron: {
            type: 'string',
            description:
              '5-field cron in local time for a recurring task. Mutually exclusive with fireAt.',
          },
          fireAt: {
            type: 'string',
            description:
              'ISO 8601 timestamp with offset for a one-shot run. Mutually exclusive with cron.',
          },
          cwd: {
            type: 'string',
            description:
              'Absolute working directory the task runs in. Defaults to the current directory.',
          },
          model: {
            type: 'string',
            description: 'Optional per-task model id (e.g. "claude-opus-4-8").',
          },
          approvalMode: {
            type: 'string',
            enum: [...APPROVAL_MODES],
            description:
              'Unattended approval posture. Default "auto". "yolo" approves everything.',
          },
          sandbox: {
            type: 'boolean',
            description: 'Run the task inside the sandbox. Default false.',
          },
        },
        required: ['name', 'description', 'prompt'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — scheduling is infrequent
      false, // alwaysLoad
      'schedule routine recurring daemon cron reminder unattended',
    );
  }

  protected createInvocation(
    params: ScheduleCreateParams,
  ): ToolInvocation<ScheduleCreateParams, ToolResult> {
    return new ScheduleCreateInvocation(this.config, params);
  }

  protected override validateToolParamValues(
    params: ScheduleCreateParams,
  ): string | null {
    if (!params.name || params.name.trim() === '') {
      return 'Parameter "name" must be a non-empty string.';
    }
    if (sanitizeTaskId(params.name) === '') {
      return 'Parameter "name" must contain at least one letter or digit.';
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return 'Parameter "prompt" must be a non-empty string.';
    }
    if (!params.description || params.description.trim() === '') {
      return 'Parameter "description" must be a non-empty string.';
    }
    return null;
  }

  /**
   * Forward the schedule + prompt to the classifier: an autonomous routine
   * that will run unattended must face the same scrutiny as a direct command.
   */
  override toAutoClassifierInput(
    params: ScheduleCreateParams,
  ): Record<string, unknown> {
    return {
      name: params.name,
      cron: params.cron,
      fireAt: params.fireAt,
      approvalMode: params.approvalMode ?? 'auto',
      prompt: params.prompt,
    };
  }
}
