import type { DaemonBackgroundTurn } from '@qwen-code/sdk/daemon';
import { createContext, useContext, type ReactNode } from 'react';
import type { ACPToolCall } from './adapters/types';

export type OpenSubagentDetails = (
  tool: ACPToolCall,
  parentSessionId?: string,
) => void;

/** Another session to open, from a turn its reply started. */
export interface OpenSessionRequest {
  sessionId: string;
  workspaceCwd?: string;
  title: string;
}

interface SubagentDetailsContextValue {
  onOpen: OpenSubagentDetails;
  onOpenBackground?: (turn: DaemonBackgroundTurn) => void;
  onOpenSession?: (request: OpenSessionRequest) => void;
}

const SubagentDetailsContext = createContext<
  SubagentDetailsContextValue | undefined
>(undefined);

export function SubagentDetailsProvider({
  onOpen,
  onOpenBackground,
  onOpenSession,
  children,
}: {
  onOpen: OpenSubagentDetails;
  onOpenBackground?: (turn: DaemonBackgroundTurn) => void;
  onOpenSession?: (request: OpenSessionRequest) => void;
  children: ReactNode;
}) {
  return (
    <SubagentDetailsContext.Provider
      value={{ onOpen, onOpenBackground, onOpenSession }}
    >
      {children}
    </SubagentDetailsContext.Provider>
  );
}

export function useSubagentDetails(): SubagentDetailsContextValue | undefined {
  return useContext(SubagentDetailsContext);
}
