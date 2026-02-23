/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentViewContext — React context for in-process agent view switching.
 *
 * Tracks which view is active (main or an agent tab) and the set of registered
 * AgentInteractive instances. Consumed by AgentTabBar, AgentChatView, and
 * DefaultAppLayout to implement tab-based agent navigation.
 *
 * Kept separate from UIStateContext to avoid bloating the main state with
 * in-process-only concerns and to make the feature self-contained.
 */

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
} from 'react';
import type { AgentInteractive } from '@qwen-code/qwen-code-core';

// ─── Types ──────────────────────────────────────────────────

export interface RegisteredAgent {
  interactiveAgent: AgentInteractive;
  displayName: string;
  color: string;
}

export interface AgentViewState {
  /** 'main' or an agentId */
  activeView: string;
  /** Registered in-process agents keyed by agentId */
  agents: ReadonlyMap<string, RegisteredAgent>;
  /** Whether any agent tab's embedded shell currently has input focus. */
  agentShellFocused: boolean;
}

export interface AgentViewActions {
  switchToMain(): void;
  switchToAgent(agentId: string): void;
  switchToNext(): void;
  switchToPrevious(): void;
  registerAgent(
    agentId: string,
    interactiveAgent: AgentInteractive,
    displayName: string,
    color: string,
  ): void;
  unregisterAgent(agentId: string): void;
  unregisterAll(): void;
  setAgentShellFocused(focused: boolean): void;
}

// ─── Context ────────────────────────────────────────────────

const AgentViewStateContext = createContext<AgentViewState | null>(null);
const AgentViewActionsContext = createContext<AgentViewActions | null>(null);

// ─── Hook: useAgentViewState ────────────────────────────────

export function useAgentViewState(): AgentViewState {
  const ctx = useContext(AgentViewStateContext);
  if (!ctx) {
    throw new Error(
      'useAgentViewState must be used within an AgentViewProvider',
    );
  }
  return ctx;
}

// ─── Hook: useAgentViewActions ──────────────────────────────

export function useAgentViewActions(): AgentViewActions {
  const ctx = useContext(AgentViewActionsContext);
  if (!ctx) {
    throw new Error(
      'useAgentViewActions must be used within an AgentViewProvider',
    );
  }
  return ctx;
}

// ─── Provider ───────────────────────────────────────────────

interface AgentViewProviderProps {
  children: React.ReactNode;
}

export function AgentViewProvider({ children }: AgentViewProviderProps) {
  const [activeView, setActiveView] = useState<string>('main');
  const [agents, setAgents] = useState<Map<string, RegisteredAgent>>(
    () => new Map(),
  );
  const [agentShellFocused, setAgentShellFocused] = useState(false);

  // ── Navigation ──

  const switchToMain = useCallback(() => {
    setActiveView('main');
  }, []);

  const switchToAgent = useCallback(
    (agentId: string) => {
      if (agents.has(agentId)) {
        setActiveView(agentId);
      }
    },
    [agents],
  );

  const switchToNext = useCallback(() => {
    const ids = ['main', ...agents.keys()];
    const currentIndex = ids.indexOf(activeView);
    const nextIndex = (currentIndex + 1) % ids.length;
    setActiveView(ids[nextIndex]!);
  }, [agents, activeView]);

  const switchToPrevious = useCallback(() => {
    const ids = ['main', ...agents.keys()];
    const currentIndex = ids.indexOf(activeView);
    const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
    setActiveView(ids[prevIndex]!);
  }, [agents, activeView]);

  // ── Registration ──

  const registerAgent = useCallback(
    (
      agentId: string,
      interactiveAgent: AgentInteractive,
      displayName: string,
      color: string,
    ) => {
      setAgents((prev) => {
        const next = new Map(prev);
        next.set(agentId, { interactiveAgent, displayName, color });
        return next;
      });
    },
    [],
  );

  const unregisterAgent = useCallback((agentId: string) => {
    setAgents((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
    setActiveView((current) => (current === agentId ? 'main' : current));
  }, []);

  const unregisterAll = useCallback(() => {
    setAgents(new Map());
    setActiveView('main');
  }, []);

  // ── Memoized values ──

  const state: AgentViewState = useMemo(
    () => ({ activeView, agents, agentShellFocused }),
    [activeView, agents, agentShellFocused],
  );

  const actions: AgentViewActions = useMemo(
    () => ({
      switchToMain,
      switchToAgent,
      switchToNext,
      switchToPrevious,
      registerAgent,
      unregisterAgent,
      unregisterAll,
      setAgentShellFocused,
    }),
    [
      switchToMain,
      switchToAgent,
      switchToNext,
      switchToPrevious,
      registerAgent,
      unregisterAgent,
      unregisterAll,
      setAgentShellFocused,
    ],
  );

  return (
    <AgentViewStateContext.Provider value={state}>
      <AgentViewActionsContext.Provider value={actions}>
        {children}
      </AgentViewActionsContext.Provider>
    </AgentViewStateContext.Provider>
  );
}
