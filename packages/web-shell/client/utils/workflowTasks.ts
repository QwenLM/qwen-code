import type {
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';

function workflowRunIdFromTool(tool: ACPToolCall): string | undefined {
  const rawOutput = (() => {
    if (typeof tool.rawOutput === 'string') return tool.rawOutput;
    if (!tool.rawOutput) return '';
    try {
      return JSON.stringify(tool.rawOutput);
    } catch {
      return '';
    }
  })();
  const text = [
    rawOutput,
    tool.subContent ?? '',
    ...(tool.content ?? []).map((item) => item.content?.text ?? ''),
  ].join('\n');
  const runId =
    text.match(/"runId"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/\bRun ID:\s*([^\s]+)/i)?.[1] ??
    text.match(/\bWorkflow\s+([^\s]+)\s+(?:started|—|-)/i)?.[1];
  if (runId) return runId;
  // Only while the call is still live. The argued use is pairing an ACTIVE
  // resume with its run before live output arrives, where the resumed run
  // registers under the same id. A TERMINAL call carrying no run identity
  // in its text is the never-registered case — a compile error or a
  // cancel-before-start — and returning the SOURCE run there would render
  // that run's graph as this failed call's detail instead of its error.
  const active = tool.status === 'pending' || tool.status === 'in_progress';
  return active && typeof tool.args?.resumeFromRunId === 'string'
    ? tool.args.resumeFromRunId
    : undefined;
}

export function findWorkflowTaskForTool(
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[],
  tool: ACPToolCall,
): DaemonSessionWorkflowTaskStatus | undefined {
  const linked = tasks.find(
    (task): task is DaemonSessionWorkflowTaskStatus =>
      task.kind === 'workflow' && task.toolUseId === tool.callId,
  );
  if (linked) return linked;
  const runId = workflowRunIdFromTool(tool);
  if (!runId) return undefined;
  return tasks.find(
    (task): task is DaemonSessionWorkflowTaskStatus =>
      task.kind === 'workflow' &&
      task.id === runId &&
      task.toolUseId === undefined,
  );
}
