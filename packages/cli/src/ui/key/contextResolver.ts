/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ContextResolver — keyboard context routing with declaration-order resolution.
 *
 * Pure function that resolves a key event to an action by checking active
 * contexts in declaration order (last-one-wins). Implements:
 *
 * 1. **Global penetration**: Global penetrating bindings always checked first.
 * 2. **Declaration order**: Contexts declared later in KEYBOARD_CONTEXTS win.
 *    No hardcoded numeric priority — only the array position matters.
 * 3. **Structural mutual exclusion**: Co-active conflicts are resolved by
 *    isActive gating on the registration side, not by numeric sorting.
 */

import type { Key } from '../contexts/KeypressContext.js';
import type { KeyboardContextName } from '../contexts/KeyboardContextRegistry.js';
import { CONTEXT_DECLARATION_ORDER } from '../contexts/KeyboardContextRegistry.js';
import type { ParsedContextBinding } from './contextBindings.js';
import {
  defaultParsedBindings,
  indexBindingsByContext,
  findMatchingBinding,
} from './contextBindings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveResult {
  /** The matched action (e.g. 'app:interrupt', 'input:submit'). */
  action: string;
  /** The context that owned the matched binding. */
  context: KeyboardContextName;
  /** Whether this was a Global penetration match. */
  penetrated: boolean;
}

// ---------------------------------------------------------------------------
// Pre-compute default binding index
// ---------------------------------------------------------------------------

const defaultBindingIndex = indexBindingsByContext(defaultParsedBindings);

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a key event to an action given the currently active contexts.
 *
 * Algorithm:
 * 1. Check Global penetrating bindings first (if Global is active).
 *    If a match is found, return it immediately — Global cannot be shadowed.
 * 2. Sort active contexts by declaration order (descending — later = wins).
 * 3. For each context (highest declaration order first), check its bindings.
 * 4. Return the first match, or null if no binding matches.
 *
 * @param key - The parsed key event from KeypressContext
 * @param activeContexts - Set of currently active context names
 * @param bindingIndex - Pre-indexed bindings by context. Defaults to the
 *   default bindings if not provided (useful for testing with custom bindings).
 * @returns The resolved action and context, or null if no match.
 */
export function resolve(
  key: Key,
  activeContexts: ReadonlySet<KeyboardContextName>,
  bindingIndex: Map<
    KeyboardContextName,
    ParsedContextBinding[]
  > = defaultBindingIndex,
): ResolveResult | null {
  // Step 1: Global penetration — always checked first
  if (activeContexts.has('Global')) {
    const globalBindings = bindingIndex.get('Global');
    if (globalBindings) {
      // Only check penetrating bindings from Global
      const penetratingBindings = globalBindings.filter((b) => b.penetrate);
      const match = findMatchingBinding(penetratingBindings, key);
      if (match) {
        return {
          action: match.action,
          context: 'Global',
          penetrated: true,
        };
      }
    }
  }

  // Step 2: Sort active contexts by declaration order (descending), excluding Global
  // (Global non-penetrating bindings are checked at its natural position)
  const sortedContexts = Array.from(activeContexts)
    .filter((ctx) => ctx !== 'Global')
    .sort(
      (a, b) =>
        (CONTEXT_DECLARATION_ORDER[b] ?? 0) -
        (CONTEXT_DECLARATION_ORDER[a] ?? 0),
    );

  // Step 3: Check each context in declaration order
  for (const ctx of sortedContexts) {
    const ctxBindings = bindingIndex.get(ctx);
    if (!ctxBindings) continue;

    const match = findMatchingBinding(ctxBindings, key);
    if (match) {
      return {
        action: match.action,
        context: ctx,
        penetrated: false,
      };
    }
  }

  // Step 4: Check Global non-penetrating bindings (at lowest priority)
  if (activeContexts.has('Global')) {
    const globalBindings = bindingIndex.get('Global');
    if (globalBindings) {
      const nonPenetratingBindings = globalBindings.filter((b) => !b.penetrate);
      const match = findMatchingBinding(nonPenetratingBindings, key);
      if (match) {
        return {
          action: match.action,
          context: 'Global',
          penetrated: false,
        };
      }
    }
  }

  return null;
}

/**
 * Resolve ALL matching contexts for a key event, in priority order.
 *
 * Unlike `resolve()` which returns only the highest-declaration-order match,
 * this returns every context that has a binding for the given key. This enables
 * cascading dispatch: if a higher-order context's handler doesn't consume
 * the event, the next context gets a chance.
 *
 * Results are ordered: penetrating Global first, then by declaration order
 * (descending — later in KEYBOARD_CONTEXTS wins), then non-penetrating
 * Global last.
 */
export function resolveAll(
  key: Key,
  activeContexts: ReadonlySet<KeyboardContextName>,
  bindingIndex: Map<
    KeyboardContextName,
    ParsedContextBinding[]
  > = defaultBindingIndex,
): ResolveResult[] {
  const results: ResolveResult[] = [];

  // Step 1: Global penetration — always checked first
  if (activeContexts.has('Global')) {
    const globalBindings = bindingIndex.get('Global');
    if (globalBindings) {
      const penetratingBindings = globalBindings.filter((b) => b.penetrate);
      const match = findMatchingBinding(penetratingBindings, key);
      if (match) {
        results.push({
          action: match.action,
          context: 'Global',
          penetrated: true,
        });
      }
    }
  }

  // Step 2: Sort active contexts by declaration order (descending), excluding Global
  const sortedContexts = Array.from(activeContexts)
    .filter((ctx) => ctx !== 'Global')
    .sort(
      (a, b) =>
        (CONTEXT_DECLARATION_ORDER[b] ?? 0) -
        (CONTEXT_DECLARATION_ORDER[a] ?? 0),
    );

  // Step 3: Check each context in priority order
  for (const ctx of sortedContexts) {
    const ctxBindings = bindingIndex.get(ctx);
    if (!ctxBindings) continue;

    const match = findMatchingBinding(ctxBindings, key);
    if (match) {
      results.push({
        action: match.action,
        context: ctx,
        penetrated: false,
      });
    }
  }

  // Step 4: Check Global non-penetrating bindings (at lowest priority)
  if (activeContexts.has('Global')) {
    const globalBindings = bindingIndex.get('Global');
    if (globalBindings) {
      const nonPenetratingBindings = globalBindings.filter((b) => !b.penetrate);
      const match = findMatchingBinding(nonPenetratingBindings, key);
      if (match) {
        results.push({
          action: match.action,
          context: 'Global',
          penetrated: false,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Create a custom binding index by merging user overrides on top of defaults.
 *
 * User bindings can:
 * - Add new bindings (new context+key+action)
 * - Override existing bindings (same context+key, different action)
 * - Remove bindings (action is filtered out before reaching here — null values
 *   are handled in parseContextBindings)
 *
 * @param userBindings - Additional parsed bindings from user config
 * @returns Merged binding index
 */
export function mergeBindingIndex(
  userBindings: ParsedContextBinding[],
): Map<KeyboardContextName, ParsedContextBinding[]> {
  // Start with a deep copy of defaults
  const merged = new Map<KeyboardContextName, ParsedContextBinding[]>();
  for (const [ctx, bindings] of defaultBindingIndex) {
    merged.set(ctx, [...bindings]);
  }

  // Apply user overrides
  for (const userBinding of userBindings) {
    let list = merged.get(userBinding.context);
    if (!list) {
      list = [];
      merged.set(userBinding.context, list);
    }

    // Check if this overrides an existing binding (same context + same key)
    const existingIdx = list.findIndex((b) =>
      b.keyBinding.equals(userBinding.keyBinding),
    );

    if (existingIdx >= 0) {
      // Replace existing binding
      list[existingIdx] = userBinding;
    } else {
      // Prepend (user bindings take precedence)
      list.unshift(userBinding);
    }
  }

  return merged;
}
