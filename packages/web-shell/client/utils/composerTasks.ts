import type {
  DaemonSessionSubSessionTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
} from '@qwen-code/sdk/daemon';
import { formatRuntime } from './formatRuntime';

/** A task the chip row can show: the child's own, or a send it made. */
export type ComposerChipTask =
  | DaemonSessionTaskWithWorkflowStatus
  | DaemonSessionSubSessionTaskStatus;

/**
 * Tasks that belong to THIS session's live background state — what the
 * composer chip row draws from and the environment panel lists.
 *
 * Agent tasks have their own surfaces, and retained workflow runs are
 * history: `getWorkflowTasks()` merges the project's saved snapshots into
 * the same list, so without the `isHistorical` exclusion a project with
 * saved runs would list every one of them as this session's work. Consumers that
 * genuinely want the history (the workflow details provider, the tasks
 * dialog) read the unfiltered list instead.
 */
export function isComposerTask(
  task: DaemonSessionTaskWithWorkflowStatus,
): task is Exclude<DaemonSessionTaskWithWorkflowStatus, { kind: 'agent' }> {
  if (task.kind === 'agent') return false;
  return !(task.kind === 'workflow' && task.isHistorical === true);
}

/** The kinds the composer chip row groups live tasks under, in display order. */
export type ComposerTaskChipKind =
  | 'workflow'
  | 'agent'
  | 'session'
  | 'shell'
  | 'monitor';

export interface ComposerTaskChipGroup {
  kind: ComposerTaskChipKind;
  tasks: ComposerChipTask[];
}

const CHIP_KIND_ORDER: readonly ComposerTaskChipKind[] = [
  'workflow',
  'agent',
  'session',
  'shell',
  'monitor',
];

function chipKindFor(
  task: ComposerChipTask,
  includeAgents: boolean,
): ComposerTaskChipKind | undefined {
  // A message sent to another session: shown until its turn there ends.
  if (task.kind === 'session') {
    return task.status === 'running' ? 'session' : undefined;
  }
  if (task.kind === 'agent') {
    // Foreground agents block the turn and live in the transcript; only
    // background ones are "running beside the chat". A paused agent is parked
    // (it is retained for the whole session), so it gets no chip: it would pin
    // a stale count. It stays in the environment panel's subagents section.
    return includeAgents &&
      task.isBackgrounded === true &&
      task.status === 'running'
      ? 'agent'
      : undefined;
  }
  if (!isComposerTask(task)) return undefined;
  // Only unfinished work gets a chip: a run that ended drops out, so the row
  // never turns into a pile of "done" leftovers. A paused workflow is still
  // unfinished — it waits for the user to resume it.
  const live =
    task.status === 'running' ||
    task.status === 'pausing' ||
    (task.kind === 'workflow' && task.status === 'paused');
  return live ? task.kind : undefined;
}

/**
 * Group this session's unfinished background tasks for the chip row above
 * the composer. Finished tasks are left out on purpose: once a run settles
 * its chip disappears, and the run stays reachable from the transcript, the
 * environment panel and the tasks dialog.
 */
export function getComposerTaskChipGroups(
  tasks: readonly ComposerChipTask[],
  options: { includeAgents: boolean },
): ComposerTaskChipGroup[] {
  const byKind = new Map<ComposerTaskChipKind, ComposerChipTask[]>();
  for (const task of tasks) {
    const kind = chipKindFor(task, options.includeAgents);
    if (!kind) continue;
    const group = byKind.get(kind);
    if (group) group.push(task);
    else byKind.set(kind, [task]);
  }
  return CHIP_KIND_ORDER.flatMap((kind) => {
    const group = byKind.get(kind);
    return group ? [{ kind, tasks: group }] : [];
  });
}

// The daemon rejects side questions longer than core's BTW_MAX_INPUT_LENGTH
// (the SDK does not export it); the composed question must fit the same cap.
const EXPLAIN_QUESTION_MAX_LENGTH = 4096;
const EXPLAIN_LABEL_MAX = 400;
const EXPLAIN_DESCRIPTION_MAX = 400;
const EXPLAIN_COMMAND_MAX = 500;
const EXPLAIN_PROMPT_MAX = 1200;
const EXPLAIN_ACTIVITY_COUNT = 5;
const EXPLAIN_ACTIVITY_MAX = 160;
const EXPLAIN_LOG_COUNT = 5;
const EXPLAIN_LOG_MAX = 200;

function explainExcerpt(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  // A cut through a surrogate pair would strand a lone surrogate in the
  // JSON payload; drop it like the session-title tail does.
  return `${trimmed.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

// The panel echo and the aria label are UI text: a shell's label is its full
// command, so they must stay short even when the facts carry a multi-KB one.
const EXPLAIN_DISPLAY_LABEL_MAX = 120;

export function explainDisplayLabel(label: string): string {
  return explainExcerpt(label, EXPLAIN_DISPLAY_LABEL_MAX);
}

function taskExplainFacts(task: DaemonSessionTaskWithWorkflowStatus): string {
  const lines = [`Kind: ${task.kind}`];
  // The daemon sets a shell's label to its command; the Command line below
  // already carries that text, so an oversized label must not eat the budget
  // twice nor crowd out the kind-specific facts.
  if (!(task.kind === 'shell' && task.label === task.command)) {
    lines.push(`Label: ${explainExcerpt(task.label, EXPLAIN_LABEL_MAX)}`);
  }
  lines.push(
    `Status: ${task.status}`,
    `Elapsed: ${formatRuntime(task.runtimeMs)}`,
  );
  // Shells synthesize the description from the command and monitors from
  // their display label; emit it only when it adds a distinct fact.
  const displayLabel =
    task.kind === 'shell'
      ? task.command
      : task.kind === 'monitor'
        ? task.description
        : task.label;
  if (task.description && task.description !== displayLabel) {
    lines.push(
      `Description: ${explainExcerpt(task.description, EXPLAIN_DESCRIPTION_MAX)}`,
    );
  }
  switch (task.kind) {
    case 'shell':
      lines.push(
        `Command: ${explainExcerpt(task.command, EXPLAIN_COMMAND_MAX)}`,
      );
      lines.push(`Working directory: ${task.cwd}`);
      break;
    case 'monitor':
      lines.push(
        `Command: ${explainExcerpt(task.command, EXPLAIN_COMMAND_MAX)}`,
      );
      lines.push(`Events observed: ${task.eventCount}`);
      break;
    case 'agent':
      if (task.subagentType) lines.push(`Agent type: ${task.subagentType}`);
      if (task.prompt) {
        lines.push(
          `Task prompt: ${explainExcerpt(task.prompt, EXPLAIN_PROMPT_MAX)}`,
        );
      }
      for (const activity of (task.recentActivities ?? []).slice(
        -EXPLAIN_ACTIVITY_COUNT,
      )) {
        lines.push(
          `Recent activity: ${explainExcerpt(
            `${activity.name}: ${activity.description}`,
            EXPLAIN_ACTIVITY_MAX,
          )}`,
        );
      }
      break;
    case 'workflow':
      if (task.currentPhase) lines.push(`Current phase: ${task.currentPhase}`);
      lines.push(
        `Agents completed: ${task.agentsCompleted}/${task.agentsDispatched}`,
      );
      if (task.pendingApprovalCount > 0) {
        lines.push(`Pending approvals: ${task.pendingApprovalCount}`);
      }
      for (const log of task.recentLogs.slice(-EXPLAIN_LOG_COUNT)) {
        lines.push(`Recent log: ${explainExcerpt(log, EXPLAIN_LOG_MAX)}`);
      }
      break;
  }
  return lines.join('\n');
}

/**
 * Compose the side question the composer's "?" affordance asks about a
 * background task. The facts come from the client's task snapshot; the
 * forked side-question agent adds the conversation context the snapshot
 * cannot carry (why the task was started). Fact labels stay English — they
 * are model input, not UI text — while the instruction follows the UI
 * language so the answer does too.
 */
export function buildTaskExplainQuestion(
  task: DaemonSessionTaskWithWorkflowStatus,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  let facts = taskExplainFacts(task);
  const overhead = t('tasks.explain.question', { facts: '' }).length;
  const budget = EXPLAIN_QUESTION_MAX_LENGTH - overhead;
  if (facts.length > budget) {
    facts = `${facts
      .slice(0, Math.max(budget - 1, 0))
      .replace(/[\uD800-\uDBFF]$/, '')}…`;
  }
  return t('tasks.explain.question', { facts });
}
