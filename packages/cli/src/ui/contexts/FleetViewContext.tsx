/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { SessionListItem } from '@qwen-code/qwen-code-core';

export type FleetSessionStatus = 'active' | 'idle' | 'backgrounded';

export interface FleetSessionEntry extends SessionListItem {
  status: FleetSessionStatus;
  displayName: string;
}

export interface FleetViewState {
  isOpen: boolean;
  sessions: FleetSessionEntry[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  groupMode: 'state' | 'directory';
  backgroundedSessionId: string | null;
}

export interface FleetViewActions {
  open: () => void;
  close: () => void;
  setSelectedIndex: (index: number) => void;
  attachSession: (sessionId: string) => void;
  stopSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  createNewSession: () => void;
  cycleGroupMode: () => void;
  refreshSessions: () => void;
}

const FleetViewStateContext = createContext<FleetViewState>({
  isOpen: false,
  sessions: [],
  selectedIndex: 0,
  loading: false,
  error: null,
  groupMode: 'state',
  backgroundedSessionId: null,
});

const FleetViewActionsContext = createContext<FleetViewActions>({
  open: () => {},
  close: () => {},
  setSelectedIndex: () => {},
  attachSession: () => {},
  stopSession: () => {},
  deleteSession: () => {},
  renameSession: () => {},
  createNewSession: () => {},
  cycleGroupMode: () => {},
  refreshSessions: () => {},
});

export function useFleetViewState(): FleetViewState {
  return useContext(FleetViewStateContext);
}

export function useFleetViewActions(): FleetViewActions {
  return useContext(FleetViewActionsContext);
}

export interface FleetViewProviderProps {
  state: FleetViewState;
  actions: FleetViewActions;
  children: ReactNode;
}

export function FleetViewProvider({
  state,
  actions,
  children,
}: FleetViewProviderProps): React.JSX.Element {
  return (
    <FleetViewStateContext.Provider value={state}>
      <FleetViewActionsContext.Provider value={actions}>
        {children}
      </FleetViewActionsContext.Provider>
    </FleetViewStateContext.Provider>
  );
}
