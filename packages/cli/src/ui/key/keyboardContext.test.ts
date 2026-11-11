/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KeyboardContextRegistry,
  KEYBOARD_CONTEXTS,
  CONTEXT_DECLARATION_ORDER,
} from '../contexts/KeyboardContextRegistry.js';

describe('KeyboardContextRegistry', () => {
  let registry: KeyboardContextRegistry;

  beforeEach(() => {
    registry = new KeyboardContextRegistry();
  });

  it('starts with no active contexts', () => {
    expect(registry.getActiveContexts().size).toBe(0);
  });

  it('registers a context as active', () => {
    registry.registerContext('Global');
    expect(registry.isActive('Global')).toBe(true);
    expect(registry.getActiveContexts().has('Global')).toBe(true);
  });

  it('unregisters a context', () => {
    registry.registerContext('Chat');
    registry.unregisterContext('Chat');
    expect(registry.isActive('Chat')).toBe(false);
  });

  it('does not notify on duplicate register', () => {
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.registerContext('Chat');
    expect(listener).toHaveBeenCalledTimes(1);

    registry.registerContext('Chat');
    expect(listener).toHaveBeenCalledTimes(1); // No extra call
  });

  it('does not notify on unregister of non-active context', () => {
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.unregisterContext('Dialog');
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('notifies subscribers on register and unregister', () => {
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.registerContext('Autocomplete');
    expect(listener).toHaveBeenCalledTimes(1);

    registry.unregisterContext('Autocomplete');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes correctly', () => {
    const listener = vi.fn();
    const unsub = registry.subscribe(listener);

    registry.registerContext('Chat');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    registry.registerContext('Autocomplete');
    expect(listener).toHaveBeenCalledTimes(1); // No more calls
  });

  it('supports multiple active contexts', () => {
    registry.registerContext('Global');
    registry.registerContext('Chat');
    registry.registerContext('Autocomplete');

    const active = registry.getActiveContexts();
    expect(active.size).toBe(3);
    expect(active.has('Global')).toBe(true);
    expect(active.has('Chat')).toBe(true);
    expect(active.has('Autocomplete')).toBe(true);
  });
});

describe('KEYBOARD_CONTEXTS', () => {
  it('contains exactly 12 contexts', () => {
    expect(KEYBOARD_CONTEXTS.length).toBe(12);
  });

  it('has Global as the first context', () => {
    expect(KEYBOARD_CONTEXTS[0]).toBe('Global');
  });

  it('every context has a declaration order defined', () => {
    for (const ctx of KEYBOARD_CONTEXTS) {
      expect(
        typeof CONTEXT_DECLARATION_ORDER[ctx],
        `Missing declaration order for ${ctx}`,
      ).toBe('number');
    }
  });
});

describe('CONTEXT_DECLARATION_ORDER', () => {
  it('Confirmation has the highest declaration order', () => {
    const max = Math.max(
      ...KEYBOARD_CONTEXTS.map((c) => CONTEXT_DECLARATION_ORDER[c]),
    );
    expect(CONTEXT_DECLARATION_ORDER.Confirmation).toBe(max);
  });

  it('declaration order follows array position: Fullscreen > Dialog > Autocomplete > Chat > Global', () => {
    expect(CONTEXT_DECLARATION_ORDER.Fullscreen).toBeGreaterThan(
      CONTEXT_DECLARATION_ORDER.Dialog,
    );
    expect(CONTEXT_DECLARATION_ORDER.Dialog).toBeGreaterThan(
      CONTEXT_DECLARATION_ORDER.Autocomplete,
    );
    expect(CONTEXT_DECLARATION_ORDER.Autocomplete).toBeGreaterThan(
      CONTEXT_DECLARATION_ORDER.Chat,
    );
    expect(CONTEXT_DECLARATION_ORDER.Chat).toBeGreaterThan(
      CONTEXT_DECLARATION_ORDER.Global,
    );
  });

  it('declaration order is auto-derived from KEYBOARD_CONTEXTS array index', () => {
    for (let i = 0; i < KEYBOARD_CONTEXTS.length; i++) {
      expect(CONTEXT_DECLARATION_ORDER[KEYBOARD_CONTEXTS[i]]).toBe(i);
    }
  });
});
