import type { ACPToolCall } from './types';

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function isTaskExecutionRaw(raw: unknown): boolean {
  return getRecord(raw)?.['type'] === 'task_execution';
}

export function isSubAgentToolCall(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'agent' || name === 'task') return true;
  if (tool.subTools || tool.subContent) return true;
  if (isTaskExecutionRaw(tool.rawOutput)) return true;
  return Boolean(tool.args?.subagent_type);
}

export function isBackgroundSubAgentToolCall(tool: ACPToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  const rawOutput = getRecord(tool.rawOutput);
  return (
    rawOutput?.['status'] === 'background' ||
    tool.args?.run_in_background === true
  );
}
