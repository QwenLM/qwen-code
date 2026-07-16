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

// NOTE: This background-classification heuristic (top-level `agent` call, no
// explicit `run_in_background`, no `working_dir`, no named teammate) mirrors two
// other implementations that must stay in sync:
//   - core dispatch (source of truth): packages/core/src/tools/agent/agent.ts
//     (`backgroundRequested`/`shouldRunInBackground` in AgentTool.execute)
//   - desktop UI: packages/desktop/packages/shared/src/agent/tool-matching.ts
//     (`detectBackgroundEvents`)
// If the routing rule changes in core, update all three. Divergences already
// exist (e.g. `subagentConfig.background` is invisible here; the desktop copy
// lacks the `rawOutput.status === 'background'` fallback below).
export function isBackgroundSubAgentToolCall(tool: ACPToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  const rawOutput = getRecord(tool.rawOutput);
  const name = tool.toolName.toLowerCase();
  const args = tool.args;
  const isTopLevelQwenAgent =
    name === 'agent' && tool.parentToolCallId === undefined;
  const defaultsToBackground =
    isTopLevelQwenAgent &&
    args?.run_in_background === undefined &&
    args?.working_dir === undefined &&
    args?.name === undefined;
  const explicitlyBackground =
    args?.run_in_background === true &&
    (name !== 'agent' || isTopLevelQwenAgent);
  return (
    rawOutput?.['status'] === 'background' ||
    explicitlyBackground ||
    defaultsToBackground
  );
}
