/**
 * Shared contexts the chat panel reads instead of calling daemon-react-sdk hooks
 * or reaching back into a host's App module. Hosts inject the values.
 *
 * Three were lifted out of web-shell `App.tsx` (they broke a host→panel import
 * cycle); three replace in-panel `daemon-react-sdk` runtime calls. Exact value
 * shapes are finalized in WS0 as each coupling is migrated — `TODO(WS0)` marks
 * placeholders pending the real types.
 */
import { createContext } from 'react';
import type { TodoSnapshotDiff, TodoDetail } from './todos-types.js';

// ── Streaming — replaces StreamingStatus + useStreamingLoadingMetrics daemon hooks.
// Hosts inject only the raw inputs; the panel keeps the interpolation animation.
export type StreamingState = 'idle' | 'waiting' | 'responding' | 'thinking';
export interface StreamingRawInput {
  state: StreamingState;
  /** chars streamed since the last user turn (assistant text + tool args) */
  chars: number;
  /** summed subagent task_execution token counts */
  agentTokens: number;
  /** true once the main agent has emitted streaming content this turn */
  isReceiving: boolean;
}
export const StreamingStateContext = createContext<StreamingRawInput>({
  state: 'idle',
  chars: 0,
  agentTokens: 0,
  isReceiving: false,
});

// ── Compact mode — was App.tsx CompactModeContext.
// Consumed by MessageList / AssistantMessage / ToolGroup / UserShellMessage.
export const CompactModeContext = createContext<boolean>(false);

// ── Todo timeline / detail — were App.tsx contexts; consumed by PlanMessage / TodoView / ToolGroup.
export const TodoTimelineContext = createContext<Map<string, TodoSnapshotDiff>>(
  new Map(),
);
export const TodoDetailContext = createContext<Map<string, TodoDetail>>(
  new Map(),
);

// ── Agent-tool classification — replaces messages/ToolApproval `isAgentTool` import.
export type IsAgentTool = (toolName: string | undefined) => boolean;
export const AgentToolContext = createContext<IsAgentTool>(() => false);

// ── Approval modes — replaces ChatEditor `DAEMON_APPROVAL_MODES` import.
// The host injects the daemon's mode-id list; the panel maps it to dropdown items.
export const ApprovalModeContext = createContext<readonly string[]>([]);
