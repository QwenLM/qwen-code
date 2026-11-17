import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';

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
export type ComposerTaskChipKind = 'workflow' | 'agent' | 'shell' | 'monitor';

export interface ComposerTaskChipGroup {
  kind: ComposerTaskChipKind;
  tasks: DaemonSessionTaskWithWorkflowStatus[];
}

const CHIP_KIND_ORDER: readonly ComposerTaskChipKind[] = [
  'workflow',
  'agent',
  'shell',
  'monitor',
];

function chipKindFor(
  task: DaemonSessionTaskWithWorkflowStatus,
  includeAgents: boolean,
): ComposerTaskChipKind | undefined {
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
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[],
  options: { includeAgents: boolean },
): ComposerTaskChipGroup[] {
  const byKind = new Map<
    ComposerTaskChipKind,
    DaemonSessionTaskWithWorkflowStatus[]
  >();
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
