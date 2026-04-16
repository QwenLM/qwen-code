/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview useTeamInProcess — bridges TeamManager in-process events
 * to AgentViewContext agent registration.
 *
 * Subscribes to `config.onTeamManagerChange()` to react immediately when
 * the team manager is set or cleared. When a teammate joins, the
 * InProcessBackend is queried for the AgentInteractive handle which is
 * then registered in AgentViewContext so it appears as a tab.
 *
 * Follows the useArenaInProcess pattern exactly.
 */

import { useEffect, useRef } from 'react';
import {
  DISPLAY_MODE,
  TeamEventType,
  type Config,
  type InProcessBackend,
  type TeamManager,
  type TeammateJoinedEvent,
  type TeammateExitedEvent,
} from '@qwen-code/qwen-code-core';
import type { AgentViewActions } from '../contexts/AgentViewContext.js';
import { theme } from '../semantic-colors.js';

const TEAMMATE_COLORS = [
  theme.text.accent,
  theme.text.link,
  theme.status.success,
  theme.status.warning,
  theme.text.code,
  theme.status.error,
];

/**
 * Bridge team in-process events to agent tab registration/unregistration.
 *
 * Called by AgentViewProvider — accepts config and actions directly so the
 * hook has no dependency on AgentViewContext (avoiding a circular import).
 */
export function useTeamInProcess(
  config: Config | null,
  actions: AgentViewActions,
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!config) return;

    let detachTeamListeners: (() => void) | null = null;
    const retryTimeouts = new Set<ReturnType<typeof setTimeout>>();

    /** Remove agent tabs, cancel pending retries, and detach team events. */
    const detachSession = () => {
      actionsRef.current.unregisterAll();
      for (const t of retryTimeouts) clearTimeout(t);
      retryTimeouts.clear();
      detachTeamListeners?.();
      detachTeamListeners = null;
    };

    /** Attach to a team manager's event emitter. The backend is resolved
     *  lazily — we only need it when registering agents, not at subscribe
     *  time. */
    const attachSession = (manager: TeamManager) => {
      const emitter = manager.getEventEmitter();
      let colorIndex = 0;

      const nextColor = () =>
        TEAMMATE_COLORS[colorIndex++ % TEAMMATE_COLORS.length]!;

      /** Resolve the InProcessBackend, or null if not applicable. */
      const getInProcessBackend = (): InProcessBackend | null => {
        const backend = manager.getBackend();
        if (!backend || backend.type !== DISPLAY_MODE.IN_PROCESS) {
          return null;
        }
        return backend as InProcessBackend;
      };

      // Register teammates that already joined (events may have fired
      // before the callback was attached).
      const teamFile = manager.getTeamFile();
      const inProcessBackend = getInProcessBackend();
      if (inProcessBackend) {
        for (const member of teamFile.members) {
          const interactive = inProcessBackend.getAgent(member.agentId);
          if (interactive) {
            actionsRef.current.registerAgent(
              member.agentId,
              interactive,
              member.model ?? 'teammate',
              member.color ?? nextColor(),
            );
          }
        }
      }

      // TEAMMATE_JOINED fires after spawnAgent, but the backend
      // resolves lazily — retry briefly like useArenaInProcess.
      const MAX_RETRIES = 20;
      const RETRY_MS = 50;

      const onTeammateJoined = (event: TeammateJoinedEvent) => {
        const tryRegister = (retriesLeft: number) => {
          const backend = getInProcessBackend();
          if (!backend) return;

          const interactive = backend.getAgent(event.agentId);
          if (interactive) {
            actionsRef.current.registerAgent(
              event.agentId,
              interactive,
              'teammate',
              event.color ?? nextColor(),
              event.name,
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

      const onTeammateExited = (event: TeammateExitedEvent) => {
        // Keep tabs visible after exit so the user can review output.
        // The tab status indicator will show completed/failed.
        void event;
      };

      emitter.on(TeamEventType.TEAMMATE_JOINED, onTeammateJoined);
      emitter.on(TeamEventType.TEAMMATE_EXITED, onTeammateExited);

      detachTeamListeners = () => {
        emitter.off(TeamEventType.TEAMMATE_JOINED, onTeammateJoined);
        emitter.off(TeamEventType.TEAMMATE_EXITED, onTeammateExited);
      };
    };

    const handleManagerChange = (manager: TeamManager | null) => {
      detachSession();
      if (manager) {
        attachSession(manager);
      }
    };

    // Subscribe to future changes.
    config.onTeamManagerChange(handleManagerChange);

    // Handle the case where a manager already exists when we mount.
    const current = config.getTeamManager();
    if (current) {
      attachSession(current);
    }

    return () => {
      config.onTeamManagerChange(null, handleManagerChange);
      detachSession();
    };
  }, [config]);
}
