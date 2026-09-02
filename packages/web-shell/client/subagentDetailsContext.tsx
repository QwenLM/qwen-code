import { createContext, useContext, type ReactNode } from 'react';
import type { ACPToolCall } from './adapters/types';

export type OpenSubagentDetails = (tool: ACPToolCall) => void;

interface SubagentDetailsContextValue {
  onOpen: OpenSubagentDetails;
}

const SubagentDetailsContext = createContext<
  SubagentDetailsContextValue | undefined
>(undefined);

export function SubagentDetailsProvider({
  onOpen,
  children,
}: {
  onOpen: OpenSubagentDetails;
  children: ReactNode;
}) {
  return (
    <SubagentDetailsContext.Provider value={{ onOpen }}>
      {children}
    </SubagentDetailsContext.Provider>
  );
}

export function useSubagentDetails(): SubagentDetailsContextValue | undefined {
  return useContext(SubagentDetailsContext);
}
