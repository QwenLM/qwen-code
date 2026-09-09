/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { DaemonEvent, DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type {
  DaemonConnectionState,
  DaemonProductSessionContext,
} from './types.js';

export interface TurnNotificationTarget {
  sessionId: string;
  sessionContext: DaemonProductSessionContext;
}

export const TurnNotificationNavigationContext = createContext<
  EventTarget | undefined
>(undefined);

export interface TurnNotificationContent {
  target?: TurnNotificationTarget;
  sessionTitle?: string;
  promptText?: string;
  responseText?: string;
}

export interface TurnNotification extends TurnNotificationContent {
  key: string;
  outcome: 'completed' | 'failed' | 'ended' | 'cancelled';
}

export interface TurnNotificationObserver {
  retain(scope: string): () => void;
  admit(scope: string, promptId: string, label?: string): void;
  remove(scope: string, promptId: string): void;
  observe(
    scope: string,
    sessionId: string,
    event: DaemonEvent,
    replay?: boolean,
    content?: TurnNotificationContent,
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
      {
        scope: string;
        sessionId: string;
        kind: string;
        cwd: string;
        target: TurnNotificationTarget;
      }
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
          target: {
            sessionId: owner.sessionId,
            sessionContext:
              context.kind === 'workspace'
                ? { kind: 'workspace', cwd }
                : { kind: context.kind },
          },
        });
        return owner;
      },
      activate,
      admit(owner: NotificationOwner, promptId: string, label?: string) {
        const scope = activate(owner);
        if (scope) observer?.admit(scope, promptId, label);
      },
      remove(owner: NotificationOwner, promptId: string) {
        const scope = owners.get(owner)?.scope;
        if (scope) observer?.remove(scope, promptId);
      },
      observe(
        owner: NotificationOwner,
        event: DaemonEvent,
        replay = false,
        content?: TurnNotificationContent,
      ) {
        const source = owners.get(owner);
        if (source && binding.current?.scope === source.scope)
          observer?.observe(source.scope, owner.sessionId, event, replay, {
            ...content,
            target: source.target,
          });
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

export function getTurnNotificationContent(
  event: DaemonEvent,
  blocks: readonly DaemonTranscriptBlock[],
  sessionTitle: string | undefined,
): TurnNotificationContent | undefined {
  if (event.type !== 'turn_complete' && event.type !== 'turn_error') return;
  const content: TurnNotificationContent = { sessionTitle };
  const promptId = (event.data as { promptId?: unknown } | undefined)?.promptId;
  if (typeof promptId !== 'string' || !promptId.trim()) return content;
  const request = blocks.find(
    (block) =>
      block.kind === 'user' &&
      block.promptId === promptId &&
      block.parentToolCallId === undefined &&
      block.text.trim(),
  );
  if (request?.kind === 'user') {
    content.promptText = request.text;
    if (!sessionTitle?.trim())
      content.sessionTitle = request.text.trim().split('\n')[0];
  }
  if (event.type === 'turn_error') return content;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (
      block?.kind === 'assistant' &&
      block.promptId === promptId &&
      block.parentToolCallId === undefined &&
      block.meta?.source !== 'background_notification' &&
      block.meta?.source !== 'vision_bridge_notice' &&
      block.text.trim()
    ) {
      if (!/"insight_(?:progress|ready|error)"\s*:/.test(block.text))
        content.responseText = block.text;
      break;
    }
  }
  return content;
}

const MAX_RECENT_TURNS = 1024;

export function createTurnNotificationObserver(
  notify: (notification: TurnNotification) => void,
): TurnNotificationObserver {
  const scopes = new Map<
    string,
    { references: number; pending: Map<string, string | undefined> }
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
        state = { references: 0, pending: new Map() };
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
    admit(scope, promptId, label) {
      if (promptId && !handled.has(keyFor(scope, promptId)))
        scopes.get(scope)?.pending.set(promptId, label?.trim());
    },
    remove(scope, promptId) {
      if (scopes.has(scope) && promptId) consume(scope, promptId);
    },
    observe(scope, sessionId, event, replay = false, content) {
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
        if (
          !handled.has(keyFor(scope, promptId)) &&
          !state.pending.has(promptId)
        )
          state.pending.set(
            promptId,
            typeof value['text'] === 'string'
              ? value['text'].trim()
              : undefined,
          );
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
      const promptText = content?.promptText || state.pending.get(promptId);
      const sessionTitle =
        content?.sessionTitle || promptText?.trim().split('\n')[0];
      if (!consume(scope, promptId)) return;
      try {
        notify({
          ...content,
          ...(sessionTitle ? { sessionTitle } : {}),
          ...(promptText ? { promptText } : {}),
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
