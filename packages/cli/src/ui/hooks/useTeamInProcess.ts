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
 * The manager's sessions are registered in AgentViewContext as tabs.
 *
 * Follows the useArenaInProcess pattern exactly.
 */

import { useEffect, useRef } from 'react';
import {
  TeamEventType,
  type Config,
  type AgentSessionView,
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
    // Track only the agent ids this hook has registered so
    // detaching the team session doesn't wipe agents owned by
    // other hooks (e.g. useArenaInProcess writes into the same
    // AgentViewContext map).
    const ownedAgentIds = new Set<string>();

    /** Remove agent tabs, cancel pending retries, and detach team events. */
    const detachSession = () => {
      for (const id of ownedAgentIds) {
        actionsRef.current.unregisterAgent(id);
      }
      ownedAgentIds.clear();
      for (const t of retryTimeouts) clearTimeout(t);
      retryTimeouts.clear();
      detachTeamListeners?.();
      detachTeamListeners = null;
    };

    /** Attach to a team manager's event emitter. */
    const attachSession = (manager: TeamManager) => {
      const emitter = manager.getEventEmitter();
      let colorIndex = 0;

      const nextColor = () =>
        TEAMMATE_COLORS[colorIndex++ % TEAMMATE_COLORS.length]!;

      // Register teammates that already joined (events may have fired
      // before the callback was attached).
      const teamFile = manager.getTeamFile();
      for (const member of teamFile.members) {
        const session = manager.getSession(member.agentId);
        if (session) {
          // Tab label is the teammate's name, not its model: teammates
          // usually inherit the leader's model, so a model label would be
          // empty (→ 'teammate') or identical across the whole team, making
          // tabs indistinguishable. The name is the teammate's identity.
          actionsRef.current.registerAgent(
            member.agentId,
            session,
            session as typeof session & AgentSessionView,
            (decision) => manager.getRuntime().answer(member.agentId, decision),
            member.name,
            member.color ?? nextColor(),
            member.name,
          );
          ownedAgentIds.add(member.agentId);
        }
      }

      // TEAMMATE_JOINED fires after spawnAgent, but the backend
      // resolves lazily — retry briefly like useArenaInProcess.
      const MAX_RETRIES = 20;
      const RETRY_MS = 50;

      const onTeammateJoined = (event: TeammateJoinedEvent) => {
        const tryRegister = (retriesLeft: number) => {
          const session = manager.getSession(event.agentId);
          if (session) {
            // Label the tab by teammate name (see discovery path above).
            actionsRef.current.registerAgent(
              event.agentId,
              session,
              session as typeof session & AgentSessionView,
              (decision) =>
                manager.getRuntime().answer(event.agentId, decision),
              event.name,
              event.color ?? nextColor(),
              event.name,
            );
            ownedAgentIds.add(event.agentId);
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
