/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  createContext,
  useContext,
  useCallback,
  useState,
  useMemo,
} from 'react';
import type { ReactNode } from 'react';

/**
 * A registered full-screen panel definition.
 * Panels can be opened/closed/toggled by their unique ID.
 */
export interface FullScreenPanelDef {
  /** Unique identifier for this panel (e.g. 'debug-console', 'diff-file') */
  id: string;
  /** The component to render when this panel is active */
  component: ReactNode;
}

export interface FullScreenPanelState {
  /** Currently active panel ID, or null if no panel is open */
  activePanelId: string | null;
  /** Currently rendered component */
  activeComponent: ReactNode | null;
}

export interface FullScreenPanelActions {
  /**
   * Open a panel by ID. If the panel was registered, renders its component.
   * If a component is passed directly, it's used as an ad-hoc panel.
   */
  open: (id: string, component?: ReactNode) => void;
  /** Close the currently active panel (or a specific panel by ID) */
  close: (id?: string) => void;
  /** Toggle a panel: open if closed, close if open */
  toggle: (id: string, component?: ReactNode) => void;
  /** Register a panel definition for later use */
  register: (def: FullScreenPanelDef) => void;
  /** Unregister a panel */
  unregister: (id: string) => void;
  /** Check if a specific panel is currently active */
  isOpen: (id: string) => boolean;
}

export interface FullScreenPanelContextValue {
  state: FullScreenPanelState;
  actions: FullScreenPanelActions;
}

const FullScreenPanelContext =
  createContext<FullScreenPanelContextValue | null>(null);

const noopActions: FullScreenPanelActions = {
  open: () => {},
  close: () => {},
  toggle: () => {},
  register: () => {},
  unregister: () => {},
  isOpen: () => false,
};

const noopValue: FullScreenPanelContextValue = {
  state: { activePanelId: null, activeComponent: null },
  actions: noopActions,
};

export const useFullScreenPanel = (): FullScreenPanelContextValue => {
  const ctx = useContext(FullScreenPanelContext);
  // Return no-op when outside provider (tests, non-interactive mode)
  return ctx ?? noopValue;
};

interface FullScreenPanelProviderProps {
  children: ReactNode;
  /**
   * Callback when the fullscreen dialog state changes.
   * Used to sync with the existing UIState.fullScreenDialog for backward
   * compatibility during migration.
   */
  onDialogChange?: (component: ReactNode | null) => void;
}

export const FullScreenPanelProvider: React.FC<
  FullScreenPanelProviderProps
> = ({ children, onDialogChange }) => {
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [activeComponent, setActiveComponent] = useState<ReactNode | null>(
    null,
  );
  const [registry] = useState<Map<string, FullScreenPanelDef>>(() => new Map());

  const setPanel = useCallback(
    (id: string | null, component: ReactNode | null) => {
      setActivePanelId(id);
      setActiveComponent(component);
      onDialogChange?.(component);
    },
    [onDialogChange],
  );

  const open = useCallback(
    (id: string, component?: ReactNode) => {
      const resolved = component ?? registry.get(id)?.component ?? null;
      if (resolved) {
        setPanel(id, resolved);
      }
    },
    [registry, setPanel],
  );

  const close = useCallback(
    (id?: string) => {
      if (!id || id === activePanelId) {
        setPanel(null, null);
      }
    },
    [activePanelId, setPanel],
  );

  const toggle = useCallback(
    (id: string, component?: ReactNode) => {
      if (activePanelId === id) {
        close(id);
      } else {
        open(id, component);
      }
    },
    [activePanelId, open, close],
  );

  const register = useCallback(
    (def: FullScreenPanelDef) => {
      registry.set(def.id, def);
    },
    [registry],
  );

  const unregister = useCallback(
    (id: string) => {
      registry.delete(id);
      // If the unregistered panel was active, close it
      if (activePanelId === id) {
        setPanel(null, null);
      }
    },
    [registry, activePanelId, setPanel],
  );

  const isOpen = useCallback(
    (id: string) => activePanelId === id,
    [activePanelId],
  );

  const state: FullScreenPanelState = useMemo(
    () => ({ activePanelId, activeComponent }),
    [activePanelId, activeComponent],
  );

  const actions: FullScreenPanelActions = useMemo(
    () => ({ open, close, toggle, register, unregister, isOpen }),
    [open, close, toggle, register, unregister, isOpen],
  );

  const value: FullScreenPanelContextValue = useMemo(
    () => ({ state, actions }),
    [state, actions],
  );

  return (
    <FullScreenPanelContext.Provider value={value}>
      {children}
    </FullScreenPanelContext.Provider>
  );
};
