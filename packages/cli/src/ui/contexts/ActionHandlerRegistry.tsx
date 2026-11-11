/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ActionHandlerRegistry — named action handler dispatch for keyboard contexts.
 *
 * Provides a registry for mapping (context, action) pairs to handler functions.
 * Components register their action handlers here; the ContextResolver resolves
 * a key to an action, then this registry invokes the corresponding handler.
 *
 * This replaces the implicit priority-based dispatch: instead of every component
 * subscribing to broadcastKeypress with a numeric priority, each component
 * registers named action handlers scoped to a specific keyboard context.
 *
 * Design:
 * - `registerHandler(context, action, handler)` — component registers a handler
 * - `registerFallback(context, handler)` — component registers a catch-all
 * - `invokeAction(context, action, key)` — dispatch calls this after resolve
 * - Handlers return boolean: true = consumed, false/void = pass through
 * - Fallback handlers are invoked when no specific action handler matches
 */

import type React from 'react';
import { createContext, useContext, useLayoutEffect, useRef } from 'react';

import type { Key } from './KeypressContext.js';
import type { KeyboardContextName } from './KeyboardContextRegistry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionHandler = (key: Key) => boolean | void;

// ---------------------------------------------------------------------------
// Registry class (imperative, framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * Maps (context, action) → handler.
 * Also supports per-context fallback handlers for catch-all behavior
 * (e.g., Chat context inserting printable characters).
 */
export class ActionHandlerRegistryImpl {
  /**
   * context → (action → handler stack)
   * Multiple handlers per (context, action) are supported — they are tried
   * in registration order (child-first due to React effect ordering).
   */
  private readonly _handlers = new Map<
    KeyboardContextName,
    Map<string, ActionHandler[]>
  >();

  /**
   * context → fallback handler stack (tried in order; first to consume wins).
   * Multiple components can register fallbacks on the same context — child
   * effects run before parent effects, so child handlers appear earlier in
   * the array and are tried first.
   */
  private readonly _fallbacks = new Map<KeyboardContextName, ActionHandler[]>();

  /** Register a handler for a specific (context, action) pair. */
  registerHandler(
    context: KeyboardContextName,
    action: string,
    handler: ActionHandler,
    options?: { prepend?: boolean },
  ): void {
    let contextHandlers = this._handlers.get(context);
    if (!contextHandlers) {
      contextHandlers = new Map();
      this._handlers.set(context, contextHandlers);
    }
    let stack = contextHandlers.get(action);
    if (!stack) {
      stack = [];
      contextHandlers.set(action, stack);
    }
    if (options?.prepend) {
      stack.unshift(handler);
    } else {
      stack.push(handler);
    }
  }

  /** Unregister a specific handler for a (context, action) pair. */
  unregisterHandler(
    context: KeyboardContextName,
    action: string,
    handler?: ActionHandler,
  ): void {
    const contextHandlers = this._handlers.get(context);
    if (!contextHandlers) return;

    if (!handler) {
      // Legacy: remove all handlers for the action
      contextHandlers.delete(action);
    } else {
      const stack = contextHandlers.get(action);
      if (stack) {
        const idx = stack.indexOf(handler);
        if (idx !== -1) {
          stack.splice(idx, 1);
        }
        if (stack.length === 0) {
          contextHandlers.delete(action);
        }
      }
    }

    if (contextHandlers.size === 0) {
      this._handlers.delete(context);
    }
  }

  /**
   * Register a fallback handler for a context.
   * Multiple fallbacks per context are supported — they are tried in
   * registration order (child-first due to React effect ordering).
   */
  registerFallback(
    context: KeyboardContextName,
    handler: ActionHandler,
    options?: { prepend?: boolean },
  ): void {
    let stack = this._fallbacks.get(context);
    if (!stack) {
      stack = [];
      this._fallbacks.set(context, stack);
    }
    if (options?.prepend) stack.unshift(handler);
    else stack.push(handler);
  }

  /** Unregister a specific fallback handler for a context. */
  unregisterFallback(
    context: KeyboardContextName,
    handler?: ActionHandler,
  ): void {
    if (!handler) {
      // Legacy: remove all fallbacks for the context
      this._fallbacks.delete(context);
      return;
    }
    const stack = this._fallbacks.get(context);
    if (stack) {
      const idx = stack.indexOf(handler);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
      if (stack.length === 0) {
        this._fallbacks.delete(context);
      }
    }
  }

  /**
   * Invoke handlers for a specific (context, action) pair.
   * Tries all registered handlers in order; stops at the first that consumes.
   *
   * @returns true if the action was consumed, false otherwise
   */
  invokeAction(
    context: KeyboardContextName,
    action: string,
    key: Key,
  ): boolean {
    const contextHandlers = this._handlers.get(context);
    if (contextHandlers) {
      const stack = contextHandlers.get(action);
      if (stack) {
        for (const handler of stack) {
          if (handler(key) === true) return true;
        }
      }
    }
    return false;
  }

  /**
   * Invoke fallback handlers for a context.
   * Tries all registered handlers in order; stops at the first that consumes.
   *
   * @returns true if the key was consumed, false otherwise
   */
  invokeFallback(context: KeyboardContextName, key: Key): boolean {
    const stack = this._fallbacks.get(context);
    if (stack) {
      for (const handler of stack) {
        if (handler(key) === true) return true;
      }
    }
    return false;
  }

  /** Check if any handler exists for a (context, action) pair. */
  hasHandler(context: KeyboardContextName, action: string): boolean {
    const stack = this._handlers.get(context)?.get(action);
    return stack != null && stack.length > 0;
  }

  /** Check if any fallback handler exists for a context. */
  hasFallback(context: KeyboardContextName): boolean {
    const stack = this._fallbacks.get(context);
    return stack != null && stack.length > 0;
  }

  /** Get all registered actions for a context (for debugging). */
  getActionsForContext(context: KeyboardContextName): string[] {
    const contextHandlers = this._handlers.get(context);
    return contextHandlers ? Array.from(contextHandlers.keys()) : [];
  }

  /** Clear all handlers (useful for tests). */
  clear(): void {
    this._handlers.clear();
    this._fallbacks.clear();
  }
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

const ActionHandlerRegistryContext =
  createContext<ActionHandlerRegistryImpl | null>(null);

interface ActionHandlerRegistryProviderProps {
  children: React.ReactNode;
  /** Optional registry instance (useful for tests). */
  registry?: ActionHandlerRegistryImpl;
}

/**
 * Provides an ActionHandlerRegistry to the component tree.
 */
export const ActionHandlerRegistryProvider: React.FC<
  ActionHandlerRegistryProviderProps
> = ({ children, registry: registryProp }) => {
  const registryRef = useRef<ActionHandlerRegistryImpl>(
    registryProp ?? new ActionHandlerRegistryImpl(),
  );
  const registry = registryProp ?? registryRef.current;

  return (
    <ActionHandlerRegistryContext.Provider value={registry}>
      {children}
    </ActionHandlerRegistryContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Access the raw ActionHandlerRegistry instance.
 * Returns null if no Provider is mounted (graceful degradation).
 */
export function useActionHandlerRegistry(): ActionHandlerRegistryImpl | null {
  return useContext(ActionHandlerRegistryContext);
}


/**
 * Register a fallback handler for a keyboard context.
 *
 * The fallback is invoked when a key event resolves to this context but
 * no specific action handler matches. Useful for:
 * - Chat: inserting printable characters
 *
 * Usage:
 * ```ts
 * useRegisterFallbackHandler('Chat', (key) => {
 *   if (key.insertable) { buffer.handleInput(key); return true; }
 * }, isChatActive);
 * ```
 */
export function useRegisterFallbackHandler(
  context: KeyboardContextName,
  handler: ActionHandler,
  isActive: boolean = true,
  options?: { prepend?: boolean },
): void {
  const registry = useActionHandlerRegistry();
  const prepend = options?.prepend ?? false;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // Stable wrapper so we can identify this registration for removal
  const stableHandlerRef = useRef<ActionHandler | null>(null);

  useLayoutEffect(() => {
    if (!registry || !isActive) return undefined;

    const stableHandler: ActionHandler = (key) => handlerRef.current(key);
    stableHandlerRef.current = stableHandler;
    registry.registerFallback(context, stableHandler, { prepend });
    return () => {
      registry.unregisterFallback(context, stableHandler);
      stableHandlerRef.current = null;
    };
  }, [registry, context, isActive, prepend]);
}

/**
 * Register multiple action handlers for a keyboard context at once.
 *
 * Convenience wrapper for registering many handlers in a single call.
 * Handlers are specified as a record of action → handler function.
 *
 * Usage:
 * ```ts
 * useRegisterActionHandlers('Chat', {
 *   'input:submit': handleSubmit,
 *   'edit:deleteLeft': handleBackspace,
 *   'cursor:left': handleMoveLeft,
 * }, isChatActive);
 * ```
 */
export function useRegisterActionHandlers(
  context: KeyboardContextName,
  handlers: Record<string, ActionHandler>,
  isActive: boolean = true,
  options?: { prepend?: boolean },
): void {
  const registry = useActionHandlerRegistry();
  // Ref to always have latest handlers without re-registering
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Compute a stable key string for the action names to detect when
  // the set of actions changes
  const actionKeys = Object.keys(handlers).sort().join(',');
  const prepend = options?.prepend ?? false;

  useLayoutEffect(() => {
    if (!registry || !isActive) return undefined;

    const currentHandlers = handlersRef.current;
    const actions = Object.keys(currentHandlers);

    // Register stable wrappers
    const wrappers: Array<[string, ActionHandler]> = actions.map((action) => [
      action,
      ((key: Key) => handlersRef.current[action]?.(key)) as ActionHandler,
    ]);

    for (const [action, wrapper] of wrappers) {
      registry.registerHandler(context, action, wrapper, { prepend });
    }

    return () => {
      for (const [action, wrapper] of wrappers) {
        registry.unregisterHandler(context, action, wrapper);
      }
    };
  }, [registry, context, isActive, actionKeys, prepend]);
}
