import type { ReactNode } from 'react';
import {
  CompactModeContext,
  TodoTimelineContext,
  TodoDetailContext,
  AgentToolContext,
  ApprovalModeContext,
  StreamingStateContext,
  type IsAgentTool,
  type StreamingRawInput,
} from './context';
import type { TodoSnapshotDiff, TodoDetail } from './todos-types';

/**
 * Single injection point for everything the chat panel reads from context.
 * The host computes each value from its own data layer (web-shell's daemon
 * hooks, etc.) and wraps the whole panel — message stream AND composer — once,
 * so the panel never calls `daemon-react-sdk` itself.
 */
export interface ChatPanelProvidersProps {
  compactMode?: boolean;
  todoTimeline?: Map<string, TodoSnapshotDiff>;
  todoDetails?: Map<string, TodoDetail>;
  isAgentTool?: IsAgentTool;
  approvalModes?: readonly string[];
  streaming?: StreamingRawInput;
  children: ReactNode;
}

const EMPTY_TIMELINE: Map<string, TodoSnapshotDiff> = new Map();
const EMPTY_DETAILS: Map<string, TodoDetail> = new Map();
const NO_AGENT_TOOL: IsAgentTool = () => false;
const NO_APPROVAL_MODES: readonly string[] = [];
const IDLE_STREAMING: StreamingRawInput = {
  state: 'idle',
  chars: 0,
  agentTokens: 0,
  isReceiving: false,
};

export function ChatPanelProviders({
  compactMode = false,
  todoTimeline = EMPTY_TIMELINE,
  todoDetails = EMPTY_DETAILS,
  isAgentTool = NO_AGENT_TOOL,
  approvalModes = NO_APPROVAL_MODES,
  streaming = IDLE_STREAMING,
  children,
}: ChatPanelProvidersProps) {
  return (
    <CompactModeContext.Provider value={compactMode}>
      <TodoTimelineContext.Provider value={todoTimeline}>
        <TodoDetailContext.Provider value={todoDetails}>
          <AgentToolContext.Provider value={isAgentTool}>
            <ApprovalModeContext.Provider value={approvalModes}>
              <StreamingStateContext.Provider value={streaming}>
                {children}
              </StreamingStateContext.Provider>
            </ApprovalModeContext.Provider>
          </AgentToolContext.Provider>
        </TodoDetailContext.Provider>
      </TodoTimelineContext.Provider>
    </CompactModeContext.Provider>
  );
}
