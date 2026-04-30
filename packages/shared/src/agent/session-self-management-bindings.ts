/**
 * Session Self-Management Bindings
 *
 * Attaches 6 session management properties to a SessionToolContext using
 * Object.defineProperty with non-memoized lazy getters. Each access resolves
 * the callback from the session-scoped tool callback registry at call time,
 * so late merges and callback replacements are immediately visible without
 * recreating the context.
 *
 * Used by backend paths to ensure a single binding implementation.
 *
 * Design rules:
 * - Each getter calls getSessionScopedToolCallbacks() fresh — NO memoization
 * - Returns undefined when the callback is missing — NO no-ops, NO fake data
 * - getSessionInfo is the only field that wraps (for sid ?? sessionId defaulting)
 * - All other fields return the raw registry callback directly (signatures match)
 */

import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';

/**
 * Attach session self-management bindings to a SessionToolContext.
 *
 * Defines lazy getters for: setSessionLabels, setSessionStatus,
 * getSessionInfo, listSessions, resolveLabels, resolveStatus.
 *
 * @param context - The SessionToolContext to augment (mutated in place)
 * @param sessionId - The session ID for registry lookup and getSessionInfo defaulting
 */
export function attachSessionSelfManagementBindings(
  context: SessionToolContext,
  sessionId: string,
): void {
  // Direct pass-through bindings — signatures match, no wrapping needed.
  // Each getter resolves fresh from the registry on every access.

  Object.defineProperty(context, 'setSessionLabels', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.setSessionLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'setSessionStatus', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.setSessionStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listSessions', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.listSessionsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveLabels', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.resolveLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveStatus', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.resolveStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'sendAgentMessage', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.sendAgentMessageFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'activateSourceInSession', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.activateSourceInSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  // Messaging gateway bindings
  Object.defineProperty(context, 'getMessagingBindings', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getMessagingBindingsFn;
      if (!fn) return undefined;
      return (sid: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'unbindMessagingChannel', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.unbindMessagingChannelFn;
      if (!fn) return undefined;
      return (sid: string, platform?: string) => fn(sid ?? sessionId, platform);
    },
    configurable: true,
    enumerable: true,
  });

  // getSessionInfo needs wrapping to default sid → sessionId
  Object.defineProperty(context, 'getSessionInfo', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getSessionInfoFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });
}
