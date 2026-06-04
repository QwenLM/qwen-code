import type {
  DaemonSessionTaskStatus,
  DaemonSessionTasksStatus,
} from '@qwen-code/sdk/daemon';

type LocalStatusDispatcher = (
  events: Array<{ type: 'status'; text: string }>,
) => void;

type ErrorReporter = (error: unknown, fallback: string) => void;

interface FormatTasksLabels {
  empty?: string;
  title?: string;
  count?: (count: number) => string;
  defaultHint?: string;
}

function sanitizeTaskText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += value[i];
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += value[i];
  }
  return out;
}

function formatTaskRuntime(runtimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(runtimeMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes}m`;
}

function formatTaskStatus(task: DaemonSessionTaskStatus): string {
  switch (task.kind) {
    case 'agent':
      if (task.status === 'failed') {
        return `failed: ${task.error ?? 'unknown error'}`;
      }
      if (task.status === 'paused' && task.resumeBlockedReason) {
        return `paused (resume blocked): ${task.resumeBlockedReason}`;
      }
      return task.status;
    case 'shell':
      if (task.status === 'completed') {
        return `completed (exit ${task.exitCode ?? '?'})`;
      }
      if (task.status === 'failed') {
        return `failed: ${task.error ?? 'unknown error'}`;
      }
      return task.status;
    case 'monitor': {
      const events = `${task.eventCount} event${
        task.eventCount === 1 ? '' : 's'
      }`;
      if (task.status === 'completed') {
        return task.error
          ? `completed (${task.error}, ${events})`
          : `completed (exit ${task.exitCode ?? '?'}, ${events})`;
      }
      if (task.status === 'failed') {
        return `failed: ${task.error ?? 'unknown error'} (${events})`;
      }
      return `${task.status} (${events})`;
    }
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}

export function formatTasksSnapshot(
  snapshot: DaemonSessionTasksStatus,
  options: {
    interactiveHint?: string | boolean;
    labels?: FormatTasksLabels;
  } = {},
): string {
  if (snapshot.tasks.length === 0) {
    return options.labels?.empty ?? 'No background tasks.';
  }

  const lines: string[] = [];
  const defaultHint =
    options.labels?.defaultHint ??
    'Tip: focus the Background tasks pill in the footer (use ↓ from an empty composer) and press Enter for the interactive dialog with detail view + live updates.';
  if (options.interactiveHint) {
    lines.push(
      typeof options.interactiveHint === 'string'
        ? options.interactiveHint
        : defaultHint,
      '',
    );
  }
  const title = options.labels?.title ?? 'Background tasks';
  const count =
    options.labels?.count?.(snapshot.tasks.length) ??
    `${snapshot.tasks.length} total`;
  lines.push(`${title} (${count})`, '');
  for (const task of snapshot.tasks) {
    const pidPart =
      task.kind !== 'agent' && task.pid !== undefined ? ` pid=${task.pid}` : '';
    lines.push(
      `[${task.id}] ${formatTaskStatus(task)}  ${formatTaskRuntime(
        task.runtimeMs,
      )}${pidPart}  ${task.label}`,
    );
    if (task.kind !== 'monitor' && task.outputFile) {
      lines.push(`            output: ${task.outputFile}`);
    }
  }

  return sanitizeTaskText(lines.join('\n'));
}

export function handleTasksSlashCommand(input: {
  cmd: string;
  promptBlocked: boolean;
  getTasks: () => Promise<DaemonSessionTasksStatus>;
  dispatch: LocalStatusDispatcher;
  reportError: ErrorReporter;
  interactiveHint?: string;
  labels?: FormatTasksLabels;
}): boolean {
  if (input.cmd !== 'tasks') return false;
  void input
    .getTasks()
    .then((snapshot) => {
      input.dispatch([
        {
          type: 'status',
          text: formatTasksSnapshot(snapshot, {
            interactiveHint:
              input.interactiveHint ?? input.labels?.defaultHint ?? true,
            labels: input.labels,
          }),
        },
      ]);
    })
    .catch((error: unknown) => {
      input.reportError(error, 'Failed to load tasks');
    });
  return true;
}
