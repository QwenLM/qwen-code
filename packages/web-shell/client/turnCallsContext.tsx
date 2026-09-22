import { createContext, useContext, type ReactNode } from 'react';

/**
 * Opens the right-panel list of tool calls belonging to one turn. `turnId` is
 * the id of the turn's leading user message.
 */
export type OpenTurnCalls = (
  turnId: string,
  recordId?: string,
  promptId?: string,
  promptLabel?: string,
) => void;

const TurnCallsContext = createContext<OpenTurnCalls | undefined>(undefined);

export function TurnCallsProvider({
  onOpen,
  children,
}: {
  onOpen: OpenTurnCalls | undefined;
  children: ReactNode;
}) {
  return (
    <TurnCallsContext.Provider value={onOpen}>
      {children}
    </TurnCallsContext.Provider>
  );
}

export function useOpenTurnCalls(): OpenTurnCalls | undefined {
  return useContext(TurnCallsContext);
}
