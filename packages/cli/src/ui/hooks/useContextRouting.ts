/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useContextRouting — the sole keyboard dispatch entry point.
 *
 * This hook is the ONLY subscriber to KeypressContext. It replaces
 * the old priority-based MultiMap dispatch with pure context-based routing:
 *
 * 1. Resolves ALL matching contexts for the key via `resolveAll`
 * 2. For each match in priority order:
 *    a. Try the owning context's action handler
 *    b. If not consumed, try the owning context's FALLBACK (always — not
 *       gated by hasHandler). This is critical: when Dialog binds Enter →
 *       dialog:confirm, BTD's action handler may return false (e.g. SUBMIT
 *       not found), but BTD's Dialog fallback has RETURN/DELETE/etc. handlers
 *       that must still fire.
 *    c. If not consumed, cross-context cascade the ACTION (not fallback) to
 *       other active contexts.
 * 3. If no binding matched at all, try fallback handlers for all active
 *    contexts (highest priority first) — for catch-all contexts like Chat
 *    that handle unbound keys.
 *
 * Cascading example for Ctrl+C:
 *   Chat:edit:clear (clears text, returns false)
 *   → Chat fallback (skipped — no fallback or returns false)
 *   → cross-context: Global:edit:clear (no handler)
 *   → next result: Global:app:interrupt (returns true)
 */

import { useCallback, useRef, useEffect } from 'react';
import { runLogger } from '@qwen-code/core';

import {
  useKeypressContext,
  type Key,
  type KeypressHandler,
} from '../contexts/KeypressContext.js';
import {
  useKeyboardContextRegistry,
  CONTEXT_DECLARATION_ORDER,
  type KeyboardContextName,
} from '../contexts/KeyboardContextRegistry.js';
import { useActionHandlerRegistry } from '../contexts/ActionHandlerRegistry.js';
import { resolveAll } from '../key/contextResolver.js';

/**
 * Options for the context routing hook.
 */
interface ContextRoutingOptions {
  /** Enable context-based routing. Default: false. */
  enabled: boolean;
  /** Enable debug logging of resolve results. Default: false. */
  debug?: boolean;
}

/**
 * Hook that enables context-based keyboard routing.
 *
 * Must be called inside a component that is within:
 * - KeypressProvider (for keypress subscription)
 * - KeyboardContextProvider (for active context tracking)
 * - ActionHandlerRegistryProvider (for action dispatch)
 *
 * Typically called once in AppContainer.
 */
export function useContextRouting(options: ContextRoutingOptions): void {
  const { enabled, debug = false } = options;

  const contextRegistry = useKeyboardContextRegistry();
  const actionRegistry = useActionHandlerRegistry();
  const { subscribe, unsubscribe } = useKeypressContext();
  const debugRef = useRef(debug);
  debugRef.current = debug;

  const handleKeypress: KeypressHandler = useCallback(
    (key: Key): boolean | void => {
      if (!contextRegistry || !actionRegistry) return;

      const activeContexts = contextRegistry.getActiveContexts();

      // Resolve ALL matching contexts for this key, in priority order
      const results = resolveAll(key, activeContexts);

      if (debugRef.current) {
        const activeCtxList = Array.from(activeContexts).join(',');
        const matchDesc =
          results.length > 0
            ? results
                .map(
                  (r) => `${r.context}:${r.action}${r.penetrated ? '(P)' : ''}`,
                )
                .join(' → ')
            : 'no match';
        runLogger.log(
          `[ContextRouting] key=${key.name} ctrl=${key.ctrl} shift=${key.shift} alt=${key.alt} seq=${JSON.stringify(key.sequence)} insertable=${key.insertable} active=[${activeCtxList}] → ${matchDesc}`,
        );
      }

      // Track which contexts have already been tried via fallback to avoid
      // double-invoking in the no-match fallback pass at the end.
      const triedFallback = new Set<KeyboardContextName>();

      // Cascade through all matching contexts in priority order.
      for (const result of results) {
        // (a) Try action handler in the context that owns the binding
        const consumed = actionRegistry.invokeAction(
          result.context,
          result.action,
          key,
        );
        if (debugRef.current) {
          runLogger.log(
            `[ContextRouting] invokeAction(${result.context}, ${result.action}) → consumed=${consumed}`,
          );
        }
        if (consumed) {
          return true;
        }

        // (b) Action handler returned false or didn't exist — try the owning
        // context's FALLBACK. This is critical for Dialog: when dialog:confirm's
        // handler returns false (SUBMIT not in child behaviors), the Dialog
        // fallback can still dispatch RETURN, DELETE_CHAR_LEFT, etc. to the
        // child action handlers.
        const fallbackConsumed = actionRegistry.invokeFallback(
          result.context,
          key,
        );
        triedFallback.add(result.context);
        if (debugRef.current) {
          runLogger.log(
            `[ContextRouting] invokeFallback(${result.context}) → consumed=${fallbackConsumed}`,
          );
        }
        if (fallbackConsumed) {
          return true;
        }

        // (c) Cross-context action cascade: try the same action name in other
        // active contexts. Handles patterns like Chat binding ctrl+l →
        // app:toggleBackgroundShellList but handler living in Global.
        const otherContexts = [
          ...(activeContexts.has('Global') && result.context !== 'Global'
            ? (['Global'] as KeyboardContextName[])
            : []),
          ...Array.from(activeContexts)
            .filter(
              (ctx): ctx is KeyboardContextName =>
                ctx !== 'Global' && ctx !== result.context,
            )
            .sort(
              (a, b) =>
                (CONTEXT_DECLARATION_ORDER[b] ?? 0) -
                (CONTEXT_DECLARATION_ORDER[a] ?? 0),
            ),
        ];

        for (const ctx of otherContexts) {
          const crossConsumed = actionRegistry.invokeAction(
            ctx,
            result.action,
            key,
          );
          if (debugRef.current) {
            runLogger.log(
              `[ContextRouting] cross-context invokeAction(${ctx}, ${result.action}) → consumed=${crossConsumed}`,
            );
          }
          if (crossConsumed) {
            return true;
          }
        }
      }

      // No binding consumed the event (or no bindings matched at all).
      // Try fallback handlers for all active contexts that we haven't
      // already tried (highest priority first).
      const sortedContexts = Array.from(activeContexts)
        .filter(
          (ctx): ctx is KeyboardContextName =>
            ctx !== 'Global' && !triedFallback.has(ctx),
        )
        .sort(
          (a, b) =>
            (CONTEXT_DECLARATION_ORDER[b] ?? 0) -
            (CONTEXT_DECLARATION_ORDER[a] ?? 0),
        );

      for (const ctx of sortedContexts) {
        if (actionRegistry.hasFallback(ctx)) {
          const fallbackConsumed = actionRegistry.invokeFallback(ctx, key);
          if (fallbackConsumed) {
            if (debugRef.current) {
              runLogger.log(
                `[ContextRouting] no-match fallback consumed by ${ctx}`,
              );
            }
            return true;
          }
        }
      }

      // NOTE: The sweep at lines above (sortedContexts loop) already handles
      // the results.length === 0 case — when triedFallback is empty (no
      // bindings matched), ALL non-Global contexts are swept. No duplicate
      // sweep needed here.

      // Nothing consumed the event. Let it fall through to lower-priority
      // useKeypress subscribers (e.g., unmigrated components like TextInput
      // that still use direct useKeypress). HookDetailView and RewindDialog
      // have been migrated to action handlers.
      if (debugRef.current) {
        runLogger.log(`[ContextRouting] key not consumed`);
      }
      // Not consumed — silent drop. Context routing is the sole dispatcher.
      return;
    },
    [contextRegistry, actionRegistry],
  );

  // Register directly with KeypressContext — NO priority system.
  // Context routing is the sole subscriber; it dispatches everything
  // through the context/action handler system.
  useEffect(() => {
    if (!enabled) return;
    subscribe(handleKeypress);
    return () => {
      unsubscribe(handleKeypress);
    };
  }, [enabled, handleKeypress, subscribe, unsubscribe]);
}
