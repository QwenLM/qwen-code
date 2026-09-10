/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import type {
  DaemonConnectionState,
  DaemonProductSessionContext,
} from './types.js';

export interface TurnNotification {
  key: string;
  outcome: 'completed' | 'failed' | 'ended' | 'cancelled';
}

export interface TurnNotificationObserver {
  retain(scope: string): () => void;
  admit(scope: string, promptId: string): void;
  remove(scope: string, promptId: string): void;
  observe(
    scope: string,
    sessionId: string,
    event: DaemonEvent,
    replay?: boolean,
  ): void;
}

export const TurnNotificationContext = createContext<
  TurnNotificationObserver | undefined
>(undefined);

interface NotificationOwner {
  sessionId: string;
  workspaceCwd: string;
}

export function useTurnNotificationBinding(
  baseUrl: string | undefined,
  connection: DaemonConnectionState,
) {
  const observer = useContext(TurnNotificationContext);
  const binding = useRef<
    | {
        scope: string;
        sessionId: string;
        kind: string;
        cwd: string;
        release(): void;
      }
    | undefined
  >(undefined);
  const generation = useRef(0);
  const handlers = useMemo(() => {
    const owners = new WeakMap<
      NotificationOwner,
      { scope: string; sessionId: string; kind: string; cwd: string }
    >();
    const activate = (owner: NotificationOwner) => {
      const next = owners.get(owner);
      if (!observer || !next) return undefined;
      if (binding.current?.scope !== next.scope) {
        binding.current?.release();
        binding.current = { ...next, release: observer.retain(next.scope) };
      }
      return next.scope;
    };
    return {
      remember<T extends NotificationOwner>(
        owner: T,
        context: DaemonProductSessionContext,
      ): T {
        if (!observer || !baseUrl) return owner;
        const url = new URL(baseUrl, 'http://localhost');
        const cwd = context.kind === 'workspace' ? owner.workspaceCwd : '';
        owners.set(owner, {
          scope: JSON.stringify([
            url.origin,
            url.pathname.replace(/\/$/, ''),
            context.kind,
            cwd,
            owner.sessionId,
          ]),
          sessionId: owner.sessionId,
          kind: context.kind,
          cwd,
        });
        return owner;
      },
      activate,
      admit(owner: NotificationOwner, promptId: string) {
        const scope = activate(owner);
        if (scope) observer?.admit(scope, promptId);
      },
      remove(owner: NotificationOwner, promptId: string) {
        const scope = owners.get(owner)?.scope;
        if (scope) observer?.remove(scope, promptId);
      },
      observe(owner: NotificationOwner, event: DaemonEvent, replay = false) {
        const scope = owners.get(owner)?.scope;
        if (scope && binding.current?.scope === scope)
          observer?.observe(scope, owner.sessionId, event, replay);
      },
    };
  }, [baseUrl, observer]);
  useEffect(() => {
    const current = binding.current;
    if (
      current &&
      (connection.sessionId !== current.sessionId ||
        (connection.sessionContext &&
          connection.sessionContext.kind !== current.kind) ||
        (current.kind === 'workspace' &&
          connection.workspaceCwd !== undefined &&
          connection.workspaceCwd !== current.cwd))
    ) {
      current.release();
      binding.current = undefined;
    }
  }, [
    connection.sessionId,
    connection.sessionContext,
    connection.workspaceCwd,
  ]);
  useEffect(() => {
    const lifecycle = generation;
    const current = ++lifecycle.current;
    return () => {
      queueMicrotask(() => {
        if (current !== lifecycle.current) return;
        binding.current?.release();
        binding.current = undefined;
      });
    };
  }, [handlers]);
  return handlers;
}

const MAX_RECENT_TURNS = 1024;

export function createTurnNotificationObserver(
  notify: (notification: TurnNotification) => void,
): TurnNotificationObserver {
  const scopes = new Map<
    string,
    { references: number; pending: Set<string> }
  >();
  const handled = new Set<string>();
  const keyFor = (scope: string, promptId: string) =>
    JSON.stringify([scope, promptId]);
  const consume = (scope: string, promptId: string) => {
    const key = keyFor(scope, promptId);
    scopes.get(scope)?.pending.delete(promptId);
    if (handled.has(key)) return false;
    handled.add(key);
    if (handled.size > MAX_RECENT_TURNS)
      handled.delete(handled.values().next().value!);
    return true;
  };
  return {
    retain(scope) {
      let state = scopes.get(scope);
      if (!state) {
        state = { references: 0, pending: new Set() };
        scopes.set(scope, state);
      }
      state.references++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.references--;
        queueMicrotask(() => {
          if (state.references === 0 && scopes.get(scope) === state)
            scopes.delete(scope);
        });
      };
    },
    admit(scope, promptId) {
      if (promptId && !handled.has(keyFor(scope, promptId)))
        scopes.get(scope)?.pending.add(promptId);
    },
    remove(scope, promptId) {
      if (scopes.has(scope) && promptId) consume(scope, promptId);
    },
    observe(scope, sessionId, event, replay = false) {
      const state = scopes.get(scope);
      if (!state || state.references === 0) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const value = data as Record<string, unknown>;
      const promptId = value['promptId'];
      const envelopeSessionId = (event as DaemonEvent & { sessionId?: unknown })
        .sessionId;
      if (
        value['sessionId'] !== sessionId ||
        (envelopeSessionId !== undefined && envelopeSessionId !== sessionId) ||
        typeof promptId !== 'string' ||
        !promptId.trim() ||
        (event.promptId !== undefined && event.promptId !== promptId)
      )
        return;
      if (
        !replay &&
        (event.type === 'pending_prompt_added' ||
          event.type === 'pending_prompt_started')
      ) {
        if (!handled.has(keyFor(scope, promptId))) state.pending.add(promptId);
        return;
      }
      if (
        event.type === 'pending_prompt_completed' &&
        value['state'] === 'removed'
      ) {
        if (!replay || state.pending.has(promptId)) consume(scope, promptId);
        return;
      }
      if (event.type !== 'turn_complete' && event.type !== 'turn_error') return;
      if (replay && !state.pending.has(promptId)) return;
      if (
        event.type === 'turn_complete' &&
        typeof value['stopReason'] !== 'string'
      )
        return;
      if (!consume(scope, promptId)) return;
      try {
        notify({
          key: keyFor(scope, promptId),
          outcome:
            event.type === 'turn_error'
              ? 'failed'
              : value['stopReason'] === 'cancelled'
                ? 'cancelled'
                : value['stopReason'] === 'end_turn'
                  ? 'completed'
                  : 'ended',
        });
      } catch {
        // Notification observers must never interrupt session event handling.
      }
    },
  };
}
