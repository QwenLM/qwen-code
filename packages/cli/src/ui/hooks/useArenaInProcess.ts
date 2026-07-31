/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview useArenaInProcess — bridges ArenaManager in-process events
 * to AgentViewContext agent registration.
 *
 * Subscribes to `config.onArenaManagerChange()` to react immediately when
 * the arena manager is set or cleared. Event listeners are attached to the
 * manager's emitter as soon as it appears — the backend is resolved lazily
 * inside the AGENT_START handler, which only fires after the backend is
 * initialized.
 */

import { useEffect, useRef } from 'react';
import {
  ArenaEventType,
  ArenaSessionStatus,
  DISPLAY_MODE,
  type ArenaAgentStartEvent,
  type ArenaManager,
  type ArenaSessionCompleteEvent,
  type Config,
  type InProcessBackend,
} from '@qwen-code/qwen-code-core';
import type { AgentViewActions } from '../contexts/AgentViewContext.js';
import { theme } from '../semantic-colors.js';

const AGENT_COLORS = [
  theme.text.accent,
  theme.text.link,
  theme.status.success,
  theme.status.warning,
  theme.text.code,
  theme.status.error,
];

/**
 * Bridge arena in-process events to agent tab registration/unregistration.
 *
 * Called by AgentViewProvider — accepts config and actions directly so the
 * hook has no dependency on AgentViewContext (avoiding a circular import).
 */
export function useArenaInProcess(
  config: Config | null,
  actions: AgentViewActions,
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!config) return;

    let detachArenaListeners: (() => void) | null = null;
    const retryTimeouts = new Set<ReturnType<typeof setTimeout>>();

    /** Remove agent tabs, cancel pending retries, and detach arena events. */
    const detachSession = () => {
      actionsRef.current.unregisterAll();
      for (const t of retryTimeouts) clearTimeout(t);
      retryTimeouts.clear();
      detachArenaListeners?.();
      detachArenaListeners = null;
    };

    /** Attach to an arena manager's event emitter. The backend is resolved
     *  lazily — we only need it when registering agents, not at subscribe
     *  time. This avoids the race where setArenaManager fires before
     *  manager.start() initializes the backend. */
    const attachSession = (manager: ArenaManager) => {
      const emitter = manager.getEventEmitter();
      let colorIndex = 0;

      const nextColor = () => AGENT_COLORS[colorIndex++ % AGENT_COLORS.length]!;

      /** Resolve the InProcessBackend, or null if not applicable. */
      const getInProcessBackend = (): InProcessBackend | null => {
        const backend = manager.getBackend();
        if (!backend || backend.type !== DISPLAY_MODE.IN_PROCESS) return null;
        return backend as InProcessBackend;
      };

      // Register agents that already started (events may have fired before
      // the callback was attached).
      const inProcessBackend = getInProcessBackend();
      if (inProcessBackend) {
        for (const agentState of manager.getAgentStates()) {
          const interactive = inProcessBackend.getAgent(agentState.agentId);
          if (interactive) {
            actionsRef.current.registerAgent(
              agentState.agentId,
              interactive,
              agentState.model.modelId,
              nextColor(),
              agentState.model.displayName,
            );
          }
        }
      }

      // AGENT_START fires *before* backend.spawnAgent() creates the
      // AgentInteractive, so getAgent() may return undefined. Retry briefly.
      const MAX_RETRIES = 20;
      const RETRY_MS = 50;

      const onAgentStart = (event: ArenaAgentStartEvent) => {
        const tryRegister = (retriesLeft: number) => {
          const backend = getInProcessBackend();
          if (!backend) return; // not an in-process session

          const interactive = backend.getAgent(event.agentId);
          if (interactive) {
            actionsRef.current.registerAgent(
              event.agentId,
              interactive,
              event.model.modelId,
              nextColor(),
              event.model.displayName,
            );
            return;
          }
          if (retriesLeft > 0) {
            const timeout = setTimeout(() => {
              retryTimeouts.delete(timeout);
              tryRegister(retriesLeft - 1);
            }, RETRY_MS);
            retryTimeouts.add(timeout);
          }
        };
        tryRegister(MAX_RETRIES);
      };

      const onSessionComplete = (event: ArenaSessionCompleteEvent) => {
        // IDLE means agents finished but the session is still alive for
        // follow-up interaction — keep the tab bar.
        if (event.result.status === ArenaSessionStatus.IDLE) return;
        detachSession();
      };

      const onSessionError = () => detachSession();

      emitter.on(ArenaEventType.AGENT_START, onAgentStart);
      emitter.on(ArenaEventType.SESSION_COMPLETE, onSessionComplete);
      emitter.on(ArenaEventType.SESSION_ERROR, onSessionError);

      detachArenaListeners = () => {
        emitter.off(ArenaEventType.AGENT_START, onAgentStart);
        emitter.off(ArenaEventType.SESSION_COMPLETE, onSessionComplete);
        emitter.off(ArenaEventType.SESSION_ERROR, onSessionError);
      };
    };

    const handleManagerChange = (manager: ArenaManager | null) => {
      detachSession();
      if (manager) {
        attachSession(manager);
      }
    };

    // Subscribe to future changes.
    config.onArenaManagerChange(handleManagerChange);

    // Handle the case where a manager already exists when we mount.
    const current = config.getArenaManager();
    if (current) {
      attachSession(current);
    }

    return () => {
      config.onArenaManagerChange(null);
      detachSession();
    };
  }, [config]);
}
