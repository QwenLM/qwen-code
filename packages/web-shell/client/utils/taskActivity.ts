import type { ACPToolCall, Message } from '../adapters/types';
import {
  backgroundShellTaskId,
  isBackgroundSubAgentToolCall,
} from '../adapters/toolClassification';
import { isWorkflowToolName } from '../components/messages/toolFormatting';

function isBackgroundTaskToolCall(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'monitor' || name === 'workflow') return true;
  if (backgroundShellTaskId(tool) !== undefined) return true;
  if (tool.args?.is_background !== true) return false;
  return (
    name === 'shell' ||
    name === 'bash' ||
    name === 'run_shell_command' ||
    name === 'exec'
  );
}

/** Walk every background task tool call in the transcript, in order. */
function forEachBackgroundTaskToolCall(
  messages: readonly Message[],
  visitTool: (tool: ACPToolCall) => void,
): void {
  const visit = (tools: readonly ACPToolCall[]) => {
    for (const tool of tools) {
      if (
        isBackgroundTaskToolCall(tool) ||
        isBackgroundSubAgentToolCall(tool)
      ) {
        visitTool(tool);
      }
      if (tool.subTools) visit(tool.subTools);
    }
  };
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    visit(message.tools);
  }
}

/**
 * Change-detection key only. `callId` is unconstrained text, so the
 * rendering is not injective and the key must never be parsed back —
 * ask {@link hasActiveTaskActivity} for the activity fact instead.
 */
export function getTaskActivityKey(messages: readonly Message[]): string {
  const parts: string[] = [];
  forEachBackgroundTaskToolCall(messages, (tool) => {
    parts.push(`${tool.callId}:${tool.status}`);
  });
  return parts.join('|');
}

/**
 * Whether any background task tool call is still running.
 *
 * Derived from the same walk as the key rather than by re-parsing it: a
 * callId containing `:in_progress|` renders a key that any such regex
 * reads as active, which pins both polling stop conditions open for the
 * life of the view.
 */
export function hasActiveTaskActivity(
  messages: readonly Message[],
  options: { workflowsEnabled?: boolean } = {},
): boolean {
  // With the workflows endpoint off, the hook polls `getTasks()`, whose
  // response structurally excludes workflow tasks — so a live workflow call
  // could never appear in a snapshot, and holding activity open on it makes
  // BOTH stop conditions unsatisfiable: the poll then runs every 3s for the
  // rest of the run (foreground runs cap at 30 minutes). Workflow calls are
  // simply unobservable in that mode, so they do not count.
  const countsWorkflows = options.workflowsEnabled === true;
  let active = false;
  forEachBackgroundTaskToolCall(messages, (tool) => {
    if (tool.status !== 'pending' && tool.status !== 'in_progress') return;
    if (!countsWorkflows && isWorkflowToolName(tool.toolName)) return;
    active = true;
  });
  return active;
}
