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
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isTerminalStatus,
  type AgentInteractive,
  type ApprovalMode,
  type Config,
} from '@qwen-code/qwen-code-core';
import { useArenaInProcess } from '../hooks/useArenaInProcess.js';
import { useAgentStreamingState } from '../hooks/useAgentStreamingState.js';
import { useTeamInProcess } from '../hooks/useTeamInProcess.js';
import { StreamingState } from '../types.js';

// ─── Types ──────────────────────────────────────────────────

export interface RegisteredAgent {
  interactiveAgent: AgentInteractive;
  /** Model identifier shown in tabs and paths (e.g. "glm-5"). */
  modelId: string;
  /** Human-friendly model name (e.g. "GLM 5"). */
  modelName?: string;
  color: string;
}

export interface AgentViewState {
  /** 'main' or an agentId */
  activeView: string;
  /** Registered in-process agents keyed by agentId */
  agents: ReadonlyMap<string, RegisteredAgent>;
  /** Whether any agent tab's embedded shell currently has input focus. */
  agentShellFocused: boolean;
  /** Last synced text from the active agent tab's input buffer. */
  agentInputBufferText: string;
  /** Whether the tab bar has keyboard focus (vs the agent input). */
  agentTabBarFocused: boolean;
  /** Per-agent approval modes (keyed by agentId). */
  agentApprovalModes: ReadonlyMap<string, ApprovalMode>;
  /**
   * Queued follow-up messages per agent (keyed by agentId). Held here —
   * not in the composer — because the layout keys AgentComposer by the
   * active view, so switching teammate tabs unmounts the composer and any
   * component-local queue would be silently discarded (#10069). Delivery
   * also lives here (AgentQueueFlusher) so queues flush even while the
   * agent's tab is unfocused (#10148).
   */
  agentMessageQueues: ReadonlyMap<string, readonly string[]>;
}

export interface AgentViewActions {
  switchToAgent(agentId: string): void;
  switchToNext(): void;
  switchToPrevious(): void;
  registerAgent(
    agentId: string,
    interactiveAgent: AgentInteractive,
    modelId: string,
    color: string,
    modelName?: string,
  ): void;
  unregisterAgent(agentId: string): void;
  unregisterAll(): void;
  setAgentShellFocused(focused: boolean): void;
  setAgentInputBufferText(text: string): void;
  setAgentTabBarFocused(focused: boolean): void;
  setAgentApprovalMode(agentId: string, mode: ApprovalMode): void;
  /** Replace the queued follow-up messages for an agent (see state docs). */
  setAgentMessageQueue(agentId: string, queue: readonly string[]): void;
  /** Append one follow-up message without relying on a render-time snapshot. */
  appendToAgentMessageQueue(agentId: string, message: string): void;
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
  agentMessageQueues: new Map(),
};

const noop = () => {};

const DEFAULT_ACTIONS: AgentViewActions = {
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
  setAgentMessageQueue: noop,
  appendToAgentMessageQueue: noop,
};

// ─── Hook: useAgentViewState ────────────────────────────────

export function useAgentViewState(): AgentViewState {
  return useContext(AgentViewStateContext) ?? DEFAULT_STATE;
}

// ─── Hook: useAgentViewActions ──────────────────────────────

export function useAgentViewActions(): AgentViewActions {
  return useContext(AgentViewActionsContext) ?? DEFAULT_ACTIONS;
}

// ─── Queue delivery ─────────────────────────────────────────

// Shared empty queue identity so agents without queued messages don't
// allocate on every render.
const EMPTY_MESSAGE_QUEUE: readonly string[] = [];

/**
 * Always-mounted delivery for one registered agent's queued follow-ups.
 *
 * AgentViewProvider mounts one flusher per registered agentId. Delivery
 * cannot live in AgentComposer: the layout renders it keyed by the active
 * view, so switching teammate tabs unmounts the composer while the queues
 * persist — an agent that settles to idle (or a terminal status) while
 * unfocused would otherwise keep accepted-but-undelivered messages forever
 * (#10148).
 */
function AgentQueueFlusher({ agentId }: { agentId: string }) {
  const { agents, agentMessageQueues } = useAgentViewState();
  const { setAgentMessageQueue } = useAgentViewActions();
  const interactiveAgent = agents.get(agentId)?.interactiveAgent;
  const { status, streamingState } = useAgentStreamingState(interactiveAgent);
  const messageQueue = agentMessageQueues.get(agentId) ?? EMPTY_MESSAGE_QUEUE;

  // Dedupe by queue identity: effects run twice per commit under
  // StrictMode, and the clear below only lands on the next render — without
  // this the same queue would be delivered twice.
  const flushedQueueRef = useRef<readonly string[] | null>(null);

  useEffect(() => {
    if (status !== undefined && isTerminalStatus(status)) {
      // The agent can never accept these messages now; drop them so the
      // display doesn't show undeliverable "queued" follow-ups forever.
      if (messageQueue.length > 0) {
        setAgentMessageQueue(agentId, []);
      }
      return;
    }
    if (
      streamingState === StreamingState.Idle &&
      messageQueue.length > 0 &&
      status !== undefined
    ) {
      if (flushedQueueRef.current === messageQueue) return;
      flushedQueueRef.current = messageQueue;
      const combined = messageQueue.join('\n');
      setAgentMessageQueue(agentId, []);
      interactiveAgent?.enqueueMessage(combined);
    }
  }, [
    streamingState,
    messageQueue,
    interactiveAgent,
    status,
    agentId,
    setAgentMessageQueue,
  ]);

  return null;
}

// ─── Provider ───────────────────────────────────────────────

interface AgentViewProviderProps {
  config?: Config;
  children: React.ReactNode;
}

export function AgentViewProvider({
  config,
  children,
}: AgentViewProviderProps) {
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
  const [agentMessageQueues, setAgentMessageQueues] = useState<
    Map<string, readonly string[]>
  >(() => new Map());
  // Synchronous mirror of the registered agent ids. The `agents` state only
  // reflects register/unregister after commit, so a same-batch append cannot
  // consult it to learn that an agent is being unregistered right now; this
  // ref is updated at action-call time so appendToAgentMessageQueue drops
  // follow-ups for a departing agent instead of resurrecting its queue.
  const registeredIdsRef = useRef<Set<string>>(new Set());

  // ── Navigation ──

  const switchToAgent = useCallback(
    (agentId: string) => {
      if (agents.has(agentId)) {
        setAgentShellFocused(false);
        setActiveView(agentId);
      }
    },
    [agents],
  );

  const switchToNext = useCallback(() => {
    const ids = ['main', ...agents.keys()];
    const currentIndex = ids.indexOf(activeView);
    const nextIndex = (currentIndex + 1) % ids.length;
    setAgentShellFocused(false);
    setActiveView(ids[nextIndex]!);
  }, [agents, activeView]);

  const switchToPrevious = useCallback(() => {
    const ids = ['main', ...agents.keys()];
    const currentIndex = ids.indexOf(activeView);
    const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
    setAgentShellFocused(false);
    setActiveView(ids[prevIndex]!);
  }, [agents, activeView]);

  // Belt and braces for the switch resets above: the embedded-shell focus
  // belongs to the active tab's content, so ANY view change — including
  // unregisterAgent/unregisterAll bouncing activeView back to 'main'
  // without going through a switch — must drop a flag the unmounted
  // content can no longer clear (#9290 review). Skip the mount run: the
  // flag starts false there, and resetting it in the mount commit would
  // clobber a same-commit seed from the active tab's content.
  const initialViewRef = useRef(true);
  useEffect(() => {
    if (initialViewRef.current) {
      initialViewRef.current = false;
      return;
    }
    setAgentShellFocused(false);
  }, [activeView]);

  // ── Registration ──

  const registerAgent = useCallback(
    (
      agentId: string,
      interactiveAgent: AgentInteractive,
      modelId: string,
      color: string,
      modelName?: string,
    ) => {
      registeredIdsRef.current.add(agentId);
      setAgents((prev) => {
        const next = new Map(prev);
        next.set(agentId, {
          interactiveAgent,
          modelId,
          color,
          modelName,
        });
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
    registeredIdsRef.current.delete(agentId);
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
    setAgentMessageQueues((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
    setActiveView((current) => (current === agentId ? 'main' : current));
  }, []);

  const unregisterAll = useCallback(() => {
    registeredIdsRef.current.clear();
    setAgents(new Map());
    setAgentApprovalModes(new Map());
    setAgentMessageQueues(new Map());
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

  const setAgentMessageQueue = useCallback(
    (agentId: string, queue: readonly string[]) => {
      setAgentMessageQueues((prev) => {
        const next = new Map(prev);
        if (queue.length === 0) {
          next.delete(agentId);
        } else {
          next.set(agentId, queue);
        }
        return next;
      });
    },
    [],
  );

  const appendToAgentMessageQueue = useCallback(
    (agentId: string, message: string) => {
      // Membership is checked against the registered-agents mirror, not the
      // queues map: empty queues hold no map entry (a `prev.has` guard would
      // drop the first message), and the mirror already reflects an
      // unregisterAgent that ran earlier in the same React batch.
      if (!registeredIdsRef.current.has(agentId)) return;
      setAgentMessageQueues((prev) => {
        const next = new Map(prev);
        next.set(agentId, [...(next.get(agentId) ?? []), message]);
        return next;
      });
    },
    [],
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
      agentMessageQueues,
    }),
    [
      activeView,
      agents,
      agentShellFocused,
      agentInputBufferText,
      agentTabBarFocused,
      agentApprovalModes,
      agentMessageQueues,
    ],
  );

  const actions: AgentViewActions = useMemo(
    () => ({
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
      setAgentMessageQueue,
      appendToAgentMessageQueue,
    }),
    [
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
      setAgentMessageQueue,
      appendToAgentMessageQueue,
    ],
  );

  // ── In-process bridges ──
  // Bridge arena and team manager events to agent registration. The hooks
  // are kept in their own files for separation of concerns; they're called
  // here so the provider is the single owner of agent tab lifecycle.
  useArenaInProcess(config ?? null, actions);
  useTeamInProcess(config ?? null, actions);

  return (
    <AgentViewStateContext.Provider value={state}>
      <AgentViewActionsContext.Provider value={actions}>
        {/* Always-mounted queue delivery, one flusher per registered agent
            — delivery must not depend on the keyed composer being mounted
            (#10148). */}
        {[...agents.keys()].map((agentId) => (
          <AgentQueueFlusher key={agentId} agentId={agentId} />
        ))}
        {children}
      </AgentViewActionsContext.Provider>
    </AgentViewStateContext.Provider>
  );
}
