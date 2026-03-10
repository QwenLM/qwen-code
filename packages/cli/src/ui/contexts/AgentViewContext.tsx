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
import {
  type AgentInteractive,
  type ApprovalMode,
} from '@qwen-code/qwen-code-core';

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
  /** Current text in the active agent tab's input buffer (empty when on main). */
  agentInputBufferText: string;
  /** Whether the tab bar has keyboard focus (vs the agent input). */
  agentTabBarFocused: boolean;
  /** Per-agent approval modes (keyed by agentId). */
  agentApprovalModes: ReadonlyMap<string, ApprovalMode>;
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
  setAgentInputBufferText(text: string): void;
  setAgentTabBarFocused(focused: boolean): void;
  setAgentApprovalMode(agentId: string, mode: ApprovalMode): void;
}

// ─── Context ────────────────────────────────────────────────

const AgentViewStateContext = createContext<AgentViewState | null>(null);
const AgentViewActionsContext = createContext<AgentViewActions | null>(null);

// ─── Defaults (used when no provider is mounted) ────────────

const DEFAULT_STATE: AgentViewState = {
  activeView: 'main',
  agents: new Map(),
  agentShellFocused: false,
  agentInputBufferText: '',
  agentTabBarFocused: false,
  agentApprovalModes: new Map(),
};

const noop = () => {};

const DEFAULT_ACTIONS: AgentViewActions = {
  switchToMain: noop,
  switchToAgent: noop,
  switchToNext: noop,
  switchToPrevious: noop,
  registerAgent: noop,
  unregisterAgent: noop,
  unregisterAll: noop,
  setAgentShellFocused: noop,
  setAgentInputBufferText: noop,
  setAgentTabBarFocused: noop,
  setAgentApprovalMode: noop,
};

// ─── Hook: useAgentViewState ────────────────────────────────

export function useAgentViewState(): AgentViewState {
  return useContext(AgentViewStateContext) ?? DEFAULT_STATE;
}

// ─── Hook: useAgentViewActions ──────────────────────────────

export function useAgentViewActions(): AgentViewActions {
  return useContext(AgentViewActionsContext) ?? DEFAULT_ACTIONS;
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
  const [agentInputBufferText, setAgentInputBufferText] = useState('');
  const [agentTabBarFocused, setAgentTabBarFocused] = useState(false);
  const [agentApprovalModes, setAgentApprovalModes] = useState<
    Map<string, ApprovalMode>
  >(() => new Map());

  // ── Navigation ──

  const switchToMain = useCallback(() => {
    setActiveView('main');
    setAgentTabBarFocused(false);
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
      // Seed approval mode from the agent's own config
      const mode = interactiveAgent.getCore().runtimeContext.getApprovalMode();
      setAgentApprovalModes((prev) => {
        const next = new Map(prev);
        next.set(agentId, mode);
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
    setAgentApprovalModes((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
    setActiveView((current) => (current === agentId ? 'main' : current));
  }, []);

  const unregisterAll = useCallback(() => {
    setAgents(new Map());
    setAgentApprovalModes(new Map());
    setActiveView('main');
    setAgentTabBarFocused(false);
  }, []);

  const setAgentApprovalMode = useCallback(
    (agentId: string, mode: ApprovalMode) => {
      // Update the agent's runtime config so tool scheduling picks it up
      const agent = agents.get(agentId);
      if (agent) {
        agent.interactiveAgent.getCore().runtimeContext.setApprovalMode(mode);
      }
      // Update UI state
      setAgentApprovalModes((prev) => {
        const next = new Map(prev);
        next.set(agentId, mode);
        return next;
      });
    },
    [agents],
  );

  // ── Memoized values ──

  const state: AgentViewState = useMemo(
    () => ({
      activeView,
      agents,
      agentShellFocused,
      agentInputBufferText,
      agentTabBarFocused,
      agentApprovalModes,
    }),
    [
      activeView,
      agents,
      agentShellFocused,
      agentInputBufferText,
      agentTabBarFocused,
      agentApprovalModes,
    ],
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
      setAgentInputBufferText,
      setAgentTabBarFocused,
      setAgentApprovalMode,
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
      setAgentInputBufferText,
      setAgentTabBarFocused,
      setAgentApprovalMode,
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
