import { createContext, useContext, type ReactNode } from 'react';
import type { ACPToolCall } from './adapters/types';

export type OpenMonitorDetails = (tool: ACPToolCall) => Promise<boolean>;

interface MonitorDetailsContextValue {
  onOpen: OpenMonitorDetails;
}

const MonitorDetailsContext = createContext<
  MonitorDetailsContextValue | undefined
>(undefined);

export function MonitorDetailsProvider({
  onOpen,
  children,
}: {
  onOpen: OpenMonitorDetails;
  children: ReactNode;
}) {
  return (
    <MonitorDetailsContext.Provider value={{ onOpen }}>
      {children}
    </MonitorDetailsContext.Provider>
  );
}

export function useMonitorDetails(): MonitorDetailsContextValue | undefined {
  return useContext(MonitorDetailsContext);
}
