/**
 * cron_create tool — creates a new cron job (in-session or durable).
 */

import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolExecuteConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { buildPermissionCheckContext } from '../core/permission-helpers.js';
import type { PermissionDecision } from '../permissions/types.js';
import { parseCron, nextFireTime } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import { CRON_TASKS_DISPLAY_PATH } from '../services/cronTasksFile.js';
import {
  CRON_GATE_TIMEOUT_MS,
  gateCommandError,
} from '../services/cron-gate.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  buildShellExecWarnings,
  getCommandRoot,
  normalizeMonitorCommand,
} from '../utils/shell-utils.js';
import { extractCommandRules } from '../utils/shellAstParser.js';

/** "1 day" / "7 days" / "0.5 days". Callers handle the Infinity case. */
function formatDays(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Expiry paragraph for the tool description. The max age comes from config
 * (settings / QWEN_CODE_CRON_MAX_AGE_DAYS) at construction time —
 * changing it requires a restart, so baking it into the static
 * description is safe. Infinity (setting 0) disables expiry.
 */
function recurringExpiryBlurb(maxAgeDays: number): string {
  if (!Number.isFinite(maxAgeDays)) {
    return (
      'Recurring tasks never auto-expire in this configuration — they keep ' +
      'firing until deleted with CronDelete. Tell the user the job runs ' +
      'until cancelled when scheduling recurring jobs.'
    );
  }
  const span = formatDays(maxAgeDays);
  return (
    `Recurring tasks auto-expire after ${span} — they fire one final time, ` +
    'then are deleted. This bounds how long a forgotten schedule keeps ' +
    `firing. Tell the user about the ${span} limit when scheduling ` +
    'recurring jobs.'
  );
}

export interface CronCreateParams {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  sessionMode?: 'unbound' | 'current';
  /** Shell command run at each fire, outside the model; see cron-gate.ts. */
  gate?: string;
}

class CronCreateInvocation extends BaseToolInvocation<
  CronCreateParams,
  ToolResult
> {
  /** The exec dialog for the gate was answered with a proceed outcome. */
  private gateConfirmed = false;

  constructor(
    private config: Config,
    params: CronCreateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const gate = this.params.gate ? ` [gate: ${this.params.gate}]` : '';
    return `${this.params.cron}: ${this.params.prompt}${gate}`;
  }

  /**
   * A gate is a shell command that will run unattended, so its dialog is
   * the exec dialog `Monitor` shows for the same command — the command, its
   * root and `Monitor(...)` rules — so that "always allow" saves a rule that
   * also lets the scheduler run it after a restart. The command shown is the
   * string the scheduler persists and runs, not Monitor's re-spelled spawn
   * command. Without a gate the generic info dialog stands.
   */
  override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const gate = this.params.gate?.trim();
    if (!gate) return super.getConfirmationDetails(abortSignal);
    const normalized = normalizeMonitorCommand(gate);
    let permissionRules: string[] = [];
    try {
      permissionRules = [
        ...new Set(await extractCommandRules(normalized.safetyCommand)),
      ].map((rule) => `Monitor(${rule})`);
    } catch {
      // Conservative fallback below: a rule for the whole command.
    }
    if (permissionRules.length === 0) {
      permissionRules = [`Monitor(${normalized.safetyCommand})`];
    }
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Schedule a gated task',
      command: gate,
      rootCommand: getCommandRoot(normalized.safetyCommand) ?? gate,
      permissionRules,
      warnings: [
        `Runs unattended on this schedule (${humanReadableCron(this.params.cron)}) without further approval; the task prompt runs only when the command prints output.`,
        ...(buildShellExecWarnings(normalized.safetyCommand, gate) ?? []),
      ],
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // Every approving outcome is a `proceed_*` value; cancel is not.
        if (String(outcome).startsWith('proceed_')) this.gateConfirmed = true;
      },
    };
    return details;
  }

  /**
   * An explicit deny of the gate as a `monitor` command refuses the task in
   * every mode and over the dialog: the runner checks deny before anything
   * else at each fire, so such a task could only ever be blocked.
   *
   * Otherwise a bare `cron_create` allow rule, saved when this tool could
   * not run shell commands, must not approve a gate on its own. When no
   * dialog ran and the mode would have asked, the gate has to pass as a
   * `monitor` command: a saved `Monitor(...)`/`Bash(...)` rule or the
   * read-only check.
   *
   * Yolo mode confirms nothing, and the gate runs unattended in yolo mode
   * anyway. Auto mode's safety net is the classifier, which sees the gate in
   * its input — unless that bare allow rule took the allow fast path around
   * it, in which case nobody has looked at the command and it is held to the
   * default-mode check.
   */
  private async assertGateApproved(gate: string): Promise<void> {
    const pm = this.config.getPermissionManager?.();
    const cwd = this.config.getTargetDir();
    const decision = await pm?.evaluate({
      toolName: ToolNames.MONITOR,
      command: gate,
      cwd,
    });
    if (decision === 'deny') {
      throw new Error(
        'The gate command is denied by a permission rule, so the task would be blocked at every fire. Remove that deny rule or choose another command.',
      );
    }
    if (this.gateConfirmed) return;
    const mode = this.config.getApprovalMode();
    if (mode === ApprovalMode.YOLO) return;
    if (mode === ApprovalMode.AUTO) {
      // The same context the permission flow evaluated for this call, so a
      // rule that took the allow fast path there — bare, or scoped to these
      // parameters (`cron_create(prompt:…)`) — is seen here too.
      const toolDecision = await pm?.evaluate(
        buildPermissionCheckContext(
          ToolNames.CRON_CREATE,
          this.params as unknown as Record<string, unknown>,
          cwd,
        ),
      );
      if (toolDecision !== 'allow') return;
    }
    if (decision === 'allow') return;
    throw new Error(
      `The gate command was not confirmed: a saved ${ToolNames.CRON_CREATE} rule does not cover a shell command that runs unattended. Add a Monitor(...) rule for it, or remove that rule so the command can be confirmed.`,
    );
  }

  /**
   * The scheduled prompt fires against the agent at cron-trigger time
   * and executes with full tool access. The CronCreateTool's L3 default
   * must NOT be 'allow', because AUTO mode short-circuits at L4 when
   * `finalPermission === 'allow'` — the classifier never runs and an
   * arbitrary scheduled prompt is silently approved. `'ask'` routes
   * the call through the classifier (or manual approval in DEFAULT).
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  async execute(): Promise<ToolResult> {
    const recurring = this.params.recurring !== false;
    const durable = this.params.durable === true;
    const useCurrentSession = this.params.sessionMode === 'current';
    const prompt = this.params.prompt.trim();
    const gate = this.params.gate?.trim() || undefined;

    if (durable && this.config.getSessionSourceType?.() === 'standalone') {
      const message =
        'Durable cron jobs are not supported in standalone sessions.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message },
      };
    }

    const scheduler = this.config.getCronScheduler();

    try {
      // Validate cron expression before creating the job
      parseCron(this.params.cron);
      // Reject expressions that parse but never match a real date
      // (e.g. "0 0 30 2 *") — otherwise the job would be accepted and
      // silently never fire. Throws with a clear message.
      nextFireTime(this.params.cron, new Date());

      if (useCurrentSession && !durable) {
        throw new Error(
          'Current-session scheduling requires durable: true because session-only jobs cannot survive a daemon session switch.',
        );
      }
      // A one-shot has no next slot: a quiet gate would consume it with
      // nothing delivered and no trace.
      if (gate && !recurring) {
        throw new Error(
          'A gate needs a recurring task: a one-shot whose gate prints nothing would be consumed with nothing delivered. Schedule it recurring (it still auto-expires) and delete it when done.',
        );
      }
      if (gate) await this.assertGateApproved(gate);

      let job: { id: string; cronExpr: string };
      if (useCurrentSession) {
        const creator = this.config.getCurrentSessionScheduledTaskCreator();
        const promptId = promptIdContext.getStore();
        if (!creator || !promptId) {
          throw new Error(
            'current_session_scheduling_unavailable: Current-session scheduling requires an active daemon prompt.',
          );
        }
        const created = await creator({
          cron: this.params.cron,
          prompt,
          recurring,
          promptId,
          ...(gate ? { gate } : {}),
        });
        // A daemon that predates gated tasks stored the task without its
        // gate: left alone it would run the prompt at every slot.
        if (gate && created.gate !== gate) {
          try {
            await scheduler.removeDurable(created.id);
          } catch (error) {
            throw new Error(
              `current_session_gate_unsupported: The daemon stored task ${created.id} without its gate, and removing it failed (${getErrorMessage(error)}): it runs the prompt at every slot until deleted with cron_delete.`,
            );
          }
          throw new Error(
            'current_session_gate_unsupported: The daemon stored the task without its gate, so it was removed. Restart `qwen serve` on the current version, or schedule the gated task without sessionMode "current".',
          );
        }
        // The daemon writes the task and this session's scheduler installs
        // it on its next reload; carry the confirmation over to that job.
        if (gate) scheduler.approveGate(created.id, gate);
        job = { id: created.id, cronExpr: created.cron };
      } else {
        const created = durable
          ? await scheduler.createDurable(
              this.params.cron,
              prompt,
              recurring,
              gate,
            )
          : scheduler.create(this.params.cron, prompt, recurring, gate);
        // The command was confirmed just now (dialog, classifier or a
        // permissive mode); the runner trusts that until a restart, where a
        // saved rule or the approval mode decides instead.
        if (gate) created.gateApproved = true;
        job = created;
      }

      const display = humanReadableCron(job.cronExpr);
      const returnDisplay = `Scheduled ${job.id} (${display})${durable ? ' [durable]' : ''}${useCurrentSession ? ' [current conversation]' : ''}${gate ? ' [gated]' : ''}`;

      const where = durable
        ? `Persisted to ${CRON_TASKS_DISPLAY_PATH}${useCurrentSession ? ' and bound to the current conversation' : ''}`
        : 'Session-only (not written to disk, dies when Qwen Code exits)';
      const maxAgeDays = this.config.getCronRecurringMaxAgeDays();
      const expiry = Number.isFinite(maxAgeDays)
        ? `Auto-expires after ${formatDays(maxAgeDays)}. Use CronDelete to cancel sooner.`
        : 'Never auto-expires. Use CronDelete to cancel.';
      const gateNote = gate
        ? ` Gate: \`${gate}\` runs at each fire; the prompt is delivered only when it prints output, a silent run costs no turn, and a failing run is reported once, not at every fire.`
        : '';
      const llmContent =
        (recurring
          ? `Scheduled recurring job ${job.id} (${job.cronExpr}). ${where}. ` +
            expiry
          : `Scheduled one-shot task ${job.id} (${job.cronExpr}). ${where}. ` +
            'It will fire once then auto-delete.') + gateNote;

      return { llmContent, returnDisplay };
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        llmContent: `Error creating cron job: ${message}`,
        returnDisplay: message,
        error: { message },
      };
    }
  }
}

export class CronCreateTool extends BaseDeclarativeTool<
  CronCreateParams,
  ToolResult
> {
  static readonly Name = ToolNames.CRON_CREATE;

  constructor(private config: Config) {
    // Resolved once: each call re-reads/re-parses the env var and an
    // invalid value would warn on every call site below.
    const maxAgeDays = config.getCronRecurringMaxAgeDays();
    super(
      CronCreateTool.Name,
      ToolDisplayNames.CRON_CREATE,
      'Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.\n\n' +
        'Uses standard 5-field cron in the user\'s local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.\n\n' +
        '## One-shot tasks (recurring: false)\n\n' +
        'For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.\n' +
        'Pin minute/hour/day-of-month/month to specific values:\n' +
        '  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false\n' +
        '  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false\n\n' +
        '## Recurring jobs (recurring: true, the default)\n\n' +
        'For "every N minutes" / "every hour" / "weekdays at 9am" requests:\n' +
        '  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)\n\n' +
        '## Avoid the :00 and :30 minute marks when the task allows it\n\n' +
        'Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user\'s request is approximate, pick a minute that is NOT 0 or 30:\n' +
        '  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")\n' +
        '  "hourly" → "7 * * * *" (not "0 * * * *")\n' +
        '  "in an hour or so, remind me to..." → pick whatever minute you land on, don\'t round\n\n' +
        'Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.\n\n' +
        '## Durability\n\n' +
        'By default (durable: false) the job lives only in this Qwen Code session — nothing is written to disk, and the job is gone when Qwen Code exits. ' +
        `Pass durable: true to write to ${CRON_TASKS_DISPLAY_PATH} so the job survives restarts. ` +
        'Only use durable: true when the user explicitly asks for persistence ("keep doing this every day", "set this up permanently"). ' +
        'Most "remind me in 5 minutes" requests should stay session-only.\n\n' +
        '## Session binding\n\n' +
        'By default (sessionMode: "unbound") a durable task stays unbound and uses the existing per-project scheduler owner; it does not reuse this conversation. ' +
        'Use sessionMode: "current" only when the user explicitly wants future runs to continue in this conversation. ' +
        'Current-session mode requires durable: true and an active daemon-backed prompt.\n\n' +
        '## Gate (optional)\n\n' +
        'Pass gate: a shell command run at each fire, outside the model, from the project directory. It decides whether the fire reaches you: nothing on stdout and exit 0 = the fire is skipped (no turn, nothing recorded); output = the fire is delivered with the output appended after the prompt, marked as data; a non-zero exit or a timeout = reported once, then counted until the command succeeds again or is blocked. ' +
        'Use it for watches that are usually quiet ("every 2 minutes, check this PR"): the command keeps its own cursor and prints only what changed, and the prompt says what to do with the output. The command is confirmed like a Monitor command when the task is created and then runs unattended. Write the prompt as instructions, not as a slash command. A gate needs a recurring task (a one-shot whose gate is quiet would be consumed with nothing delivered).\n\n' +
        '## Runtime behavior\n\n' +
        'Jobs only fire while the REPL is idle (not mid-query). The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.\n\n' +
        `${recurringExpiryBlurb(maxAgeDays)}\n\n` +
        'Returns a job ID you can pass to CronDelete.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
          },
          prompt: {
            type: 'string',
            description: 'The prompt to enqueue at each fire time.',
          },
          recurring: {
            type: 'boolean',
            description:
              `true (default) = fire on every cron match until deleted${
                Number.isFinite(maxAgeDays)
                  ? ` or auto-expired after ${formatDays(maxAgeDays)}`
                  : ''
              }. ` +
              'false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
          },
          durable: {
            type: 'boolean',
            description: `true = persist to ${CRON_TASKS_DISPLAY_PATH} and survive restarts. false (default) = in-memory only, dies when Qwen Code exits. Use true only when the user asks the task to survive across sessions.`,
          },
          sessionMode: {
            type: 'string',
            enum: ['unbound', 'current'],
            description:
              'unbound (default) = preserve the existing unbound durable scheduler behavior. current = bind a durable task to this daemon conversation; requires durable: true.',
          },
          gate: {
            type: 'string',
            description: `Shell command run at each fire, outside the model. Prints nothing and exits 0 = the fire is skipped and no turn runs. Prints output = the fire is delivered with the output. Exits non-zero or runs longer than ${CRON_GATE_TIMEOUT_MS / 1000} s = reported once, not at every fire.`,
          },
        },
        required: ['cron', 'prompt'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — scheduling is infrequent
      false, // alwaysLoad
      'cron schedule reminder recurring timer',
    );
  }

  protected createInvocation(
    params: CronCreateParams,
  ): ToolInvocation<CronCreateParams, ToolResult> {
    return new CronCreateInvocation(this.config, params);
  }

  protected override validateToolParamValues(
    params: CronCreateParams,
  ): string | null {
    if (!params.prompt || params.prompt.trim() === '') {
      return 'Parameter "prompt" must be a non-empty string.';
    }
    if (params.gate !== undefined) {
      const gateError = gateCommandError(params.gate);
      if (gateError) return `Parameter "gate" ${gateError}.`;
    }
    return null;
  }

  /**
   * Forward the prompt and cadence to the classifier. The scheduled
   * prompt will be enqueued and executed against the agent at fire-time,
   * so it must go through the same scrutiny as a direct command. Without
   * this override the default projection returns `''` and the classifier
   * sees `cron_create({})` — blind to what the agent will be asked to
   * do in 8 hours.
   */
  override toAutoClassifierInput(
    params: CronCreateParams,
  ): Record<string, unknown> {
    return {
      cron: params.cron,
      prompt: params.prompt,
      recurring: params.recurring ?? true,
      durable: params.durable ?? false,
      sessionMode: params.sessionMode ?? 'unbound',
      // The gate is a shell command that will run unattended on the schedule.
      ...(params.gate ? { gate: params.gate } : {}),
    };
  }
}
