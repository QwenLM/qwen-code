import type { DaemonSessionTasksStatus } from '@qwen-code/sdk/daemon';
import { serializeTasksStatusMessage } from '../components/messages/TasksStatusMessage';

type LocalStatusDispatcher = (
  events: Array<{ type: 'status'; text: string }>,
) => void;

type ErrorReporter = (error: unknown, fallback: string) => void;

export function handleTasksSlashCommand(input: {
  cmd: string;
  getTasks: () => Promise<DaemonSessionTasksStatus>;
  dispatch: LocalStatusDispatcher;
  reportError: ErrorReporter;
}): boolean {
  if (input.cmd !== 'tasks') return false;
  void input
    .getTasks()
    .then((snapshot) => {
      input.dispatch([
        {
          type: 'status',
          text: serializeTasksStatusMessage({ snapshot }),
        },
      ]);
    })
    .catch((error: unknown) => {
      input.reportError(error, 'Failed to load tasks');
    });
  return true;
}
