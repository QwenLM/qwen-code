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

export type TerminalBackgroundAgentStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'canceled';

export function isTerminalBackgroundAgentStatus(
  status: unknown,
): status is TerminalBackgroundAgentStatus {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
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
  if (name === 'workflow') return false;
  if (name === 'agent' || name === 'task') return true;
  if (tool.subTools || tool.subContent) return true;
  if (isTaskExecutionRaw(tool.rawOutput)) return true;
  return Boolean(tool.args?.subagent_type);
}

// NOTE: This background-classification heuristic (top-level `agent` call, no
// explicit `run_in_background`, no `working_dir`, no named teammate) is the
// frozen compatibility path for frames lacking `executionMode` (older daemon
// frames, recordings made before the projection, and current-core
// blocked-spawn result frames). It must NOT be updated when the routing rule
// changes in core — the live rule lives in packages/core/src/tools/agent/
// agent.ts (`backgroundRequested`/`shouldRunInBackground`), and the desktop
// adapter that used to mirror it has been forked out of this repo. A
// divergence already exists: `subagentConfig.background` is invisible here.
export function isBackgroundSubAgentToolCall(tool: ACPToolCall): boolean {
  if (!isSubAgentToolCall(tool)) return false;
  if (tool.executionMode) return tool.executionMode === 'background';

  // Older daemon frames and recorded sessions do not include executionMode.
  // Preserve their existing argument/status inference as a compatibility path.
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

export function projectTerminalBackgroundAgentTool(
  tool: ACPToolCall,
  status: unknown,
  endTime?: number,
  safeToolProjection = false,
): ACPToolCall {
  if (!isTerminalBackgroundAgentStatus(status)) return tool;
  const cancelled = status === 'cancelled' || status === 'canceled';
  return {
    ...tool,
    status:
      status === 'failed' || (cancelled && safeToolProjection)
        ? 'failed'
        : 'completed',
    ...(endTime !== undefined ? { endTime } : {}),
    ...(cancelled && safeToolProjection ? { wasCancelled: true } : {}),
    ...(cancelled
      ? {
          rawOutput: {
            ...(safeToolProjection && typeof tool.rawOutput === 'string'
              ? { text: tool.rawOutput }
              : (getRecord(tool.rawOutput) ?? {})),
            status: 'cancelled',
          },
        }
      : {}),
  };
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
