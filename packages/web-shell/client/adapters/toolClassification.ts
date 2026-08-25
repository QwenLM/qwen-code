import type { ACPToolCall } from './types.js';

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function isActiveToolStatus(
  status: ACPToolCall['status'] | string,
): boolean {
  return (
    status === 'pending' || status === 'running' || status === 'in_progress'
  );
}

export function hasActiveAgents(agents: readonly ACPToolCall[]): boolean {
  return agents.some((agent) => isActiveToolStatus(agent.status));
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
// explicit `run_in_background`, no `working_dir`, no named teammate) mirrors the
// core dispatch source of truth and must stay in sync with it:
//   - packages/core/src/tools/agent/agent.ts
//     (`backgroundRequested`/`shouldRunInBackground` in AgentTool.execute)
// If the routing rule changes in core, update this copy too. A divergence already
// exists: `subagentConfig.background` is invisible here.
export function isBackgroundSubAgentToolCall(tool: ACPToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  const rawOutput = getRecord(tool.rawOutput);
  const name = tool.toolName.toLowerCase();
  const args = tool.args;
  const isTopLevelQwenAgent =
    name === 'agent' && tool.parentToolCallId === undefined;
  const defaultsToBackground =
    isTopLevelQwenAgent &&
    args !== undefined &&
    args?.run_in_background === undefined &&
    args?.working_dir === undefined &&
    args?.name === undefined &&
    // Args alone cannot distinguish an interactive detached fork from a
    // headless registry-backed fork. Keep the omitted-flag shape out of this
    // heuristic and trust rawOutput.status for the effective runtime mode.
    (typeof args?.subagent_type !== 'string' ||
      args.subagent_type.toLowerCase() !== 'fork');
  const explicitlyBackground =
    args?.run_in_background === true &&
    (name !== 'agent' || isTopLevelQwenAgent);
  return (
    rawOutput?.['status'] === 'background' ||
    explicitlyBackground ||
    defaultsToBackground
  );
}

const BACKGROUND_SHELL_NAMES = new Set([
  'shell',
  'bash',
  'run_shell_command',
  'exec',
]);
const BACKGROUND_SHELL_ID_PATTERN =
  /^(?:Background shell|Promoted to background:)\s+(bg_[\w-]+)/i;

export function backgroundShellTaskId(tool: ACPToolCall): string | undefined {
  if (
    tool.status === 'failed' ||
    !BACKGROUND_SHELL_NAMES.has(tool.toolName.toLowerCase())
  ) {
    return undefined;
  }
  return typeof tool.rawOutput === 'string'
    ? BACKGROUND_SHELL_ID_PATTERN.exec(tool.rawOutput)?.[1]
    : undefined;
}
