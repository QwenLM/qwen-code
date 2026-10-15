import type { DaemonBackgroundTurn } from '@qwen-code/sdk/daemon';
import { createContext, useContext, type ReactNode } from 'react';
import type { ACPToolCall } from './adapters/types';

export type OpenSubagentDetails = (tool: ACPToolCall) => void;

interface SubagentDetailsContextValue {
  onOpen: OpenSubagentDetails;
  onOpenBackground?: (turn: DaemonBackgroundTurn) => void;
}

const SubagentDetailsContext = createContext<
  SubagentDetailsContextValue | undefined
>(undefined);

export function SubagentDetailsProvider({
  onOpen,
  onOpenBackground,
  children,
}: {
  onOpen: OpenSubagentDetails;
  onOpenBackground?: (turn: DaemonBackgroundTurn) => void;
  children: ReactNode;
}) {
  return (
    <SubagentDetailsContext.Provider value={{ onOpen, onOpenBackground }}>
      {children}
    </SubagentDetailsContext.Provider>
  );
}

export function useSubagentDetails(): SubagentDetailsContextValue | undefined {
  return useContext(SubagentDetailsContext);
}
