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
  return typeof tool.args?.resumeFromRunId === 'string'
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
      task.kind === 'workflow' && task.id === runId,
  );
}
