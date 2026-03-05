/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview useArenaInProcess — bridges ArenaManager in-process events
 * to the AgentViewContext for React-based agent tab navigation.
 *
 * When an arena session starts with an InProcessBackend, this hook:
 * 1. Listens to AGENT_START events from ArenaManager
 * 2. Retrieves the AgentInteractive from InProcessBackend
 * 3. Registers it with AgentViewContext
 * 4. Cleans up on SESSION_COMPLETE / SESSION_ERROR / unmount
 */

import { useEffect, useRef } from 'react';
import {
  ArenaEventType,
  DISPLAY_MODE,
  type ArenaManager,
  type ArenaAgentStartEvent,
  type Config,
  type InProcessBackend,
} from '@qwen-code/qwen-code-core';
import { useAgentViewActions } from '../contexts/AgentViewContext.js';
import { theme } from '../semantic-colors.js';

// Palette of colors for agent tabs (cycles for >N agents)
const getAgentColors = () => [
  theme.text.accent,
  theme.text.link,
  theme.status.success,
  theme.status.warning,
  theme.text.code,
  theme.status.error,
];

export function useArenaInProcess(config: Config): void {
  const actions = useAgentViewActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    // Poll for arena manager (it's set asynchronously by the /arena start command)
    let checkInterval: ReturnType<typeof setInterval> | null = null;
    // Track the manager instance (not just a boolean) so we never
    // reattach to the same completed manager after SESSION_COMPLETE.
    let attachedManager: ArenaManager | null = null;
    let detachListeners: (() => void) | null = null;
    // Pending agent-registration retry timeouts (cancelled on session end & unmount).
    const retryTimeouts = new Set<ReturnType<typeof setTimeout>>();

    const tryAttach = () => {
      const manager: ArenaManager | null = config.getArenaManager();
      // Skip if no manager or if it's the same instance we already handled
      if (!manager || manager === attachedManager) return;

      const backend = manager.getBackend();
      if (!backend || backend.type !== DISPLAY_MODE.IN_PROCESS) return;

      attachedManager = manager;
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }

      const inProcessBackend = backend as InProcessBackend;
      const emitter = manager.getEventEmitter();
      const agentColors = getAgentColors();
      let colorIndex = 0;

      // Register agents that already started (race condition if events
      // fired before we attached)
      const existingAgents = manager.getAgentStates();
      for (const agentState of existingAgents) {
        const interactive = inProcessBackend.getAgent(agentState.agentId);
        if (interactive) {
          const displayName =
            agentState.model.displayName || agentState.model.modelId;
          const color = agentColors[colorIndex % agentColors.length]!;
          colorIndex++;
          actionsRef.current.registerAgent(
            agentState.agentId,
            interactive,
            displayName,
            color,
          );
        }
      }

      // Listen for new agent starts.
      // AGENT_START is emitted by ArenaManager *before* backend.spawnAgent()
      // creates the AgentInteractive, so getAgent() may still return
      // undefined.  We retry with a short poll to bridge the gap.
      const MAX_AGENT_RETRIES = 20;
      const AGENT_RETRY_INTERVAL_MS = 50;

      const onAgentStart = (event: ArenaAgentStartEvent) => {
        const tryRegister = (retriesLeft: number) => {
          const interactive = inProcessBackend.getAgent(event.agentId);
          if (interactive) {
            const displayName = event.model.displayName || event.model.modelId;
            const color = agentColors[colorIndex % agentColors.length]!;
            colorIndex++;
            actionsRef.current.registerAgent(
              event.agentId,
              interactive,
              displayName,
              color,
            );
            return;
          }
          if (retriesLeft > 0) {
            const timeout = setTimeout(() => {
              retryTimeouts.delete(timeout);
              tryRegister(retriesLeft - 1);
            }, AGENT_RETRY_INTERVAL_MS);
            retryTimeouts.add(timeout);
          }
        };
        tryRegister(MAX_AGENT_RETRIES);
      };

      // On session end, unregister agents, remove listeners from this
      // manager, and resume polling for a genuinely new manager instance.
      const onSessionEnd = () => {
        actionsRef.current.unregisterAll();
        for (const timeout of retryTimeouts) {
          clearTimeout(timeout);
        }
        retryTimeouts.clear();
        // Remove listeners eagerly so they don't fire again
        emitter.off(ArenaEventType.AGENT_START, onAgentStart);
        emitter.off(ArenaEventType.SESSION_COMPLETE, onSessionEnd);
        emitter.off(ArenaEventType.SESSION_ERROR, onSessionEnd);
        detachListeners = null;
        // Keep attachedManager reference — prevents reattach to this
        // same (completed) manager on the next poll tick.
        // Polling will pick up a new manager once /arena start creates one.
        if (!checkInterval) {
          checkInterval = setInterval(tryAttach, 500);
        }
      };

      emitter.on(ArenaEventType.AGENT_START, onAgentStart);
      emitter.on(ArenaEventType.SESSION_COMPLETE, onSessionEnd);
      emitter.on(ArenaEventType.SESSION_ERROR, onSessionEnd);

      detachListeners = () => {
        emitter.off(ArenaEventType.AGENT_START, onAgentStart);
        emitter.off(ArenaEventType.SESSION_COMPLETE, onSessionEnd);
        emitter.off(ArenaEventType.SESSION_ERROR, onSessionEnd);
      };
    };

    // Check immediately, then poll every 500ms
    tryAttach();
    if (!attachedManager) {
      checkInterval = setInterval(tryAttach, 500);
    }

    return () => {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      for (const timeout of retryTimeouts) {
        clearTimeout(timeout);
      }
      retryTimeouts.clear();
      detachListeners?.();
    };
  }, [config]);
}
