/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionHandlerRegistryImpl } from '../contexts/ActionHandlerRegistry.js';
import type { Key } from '../contexts/KeypressContext.js';

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    name: 'a',
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: true,
    sequence: 'a',
    ...overrides,
  };
}

describe('ActionHandlerRegistryImpl', () => {
  let registry: ActionHandlerRegistryImpl;

  beforeEach(() => {
    registry = new ActionHandlerRegistryImpl();
  });

  it('starts with no handlers', () => {
    expect(registry.hasHandler('Global', 'app:interrupt')).toBe(false);
    expect(registry.hasFallback('Global')).toBe(false);
    expect(registry.getActionsForContext('Global')).toEqual([]);
  });

  it('registers and invokes a handler', () => {
    const handler = vi.fn(() => true);
    registry.registerHandler('Global', 'app:interrupt', handler);

    expect(registry.hasHandler('Global', 'app:interrupt')).toBe(true);

    const key = makeKey({ name: 'c', ctrl: true });
    const consumed = registry.invokeAction('Global', 'app:interrupt', key);

    expect(handler).toHaveBeenCalledWith(key);
    expect(consumed).toBe(true);
  });

  it('returns false when no handler exists', () => {
    const key = makeKey();
    expect(registry.invokeAction('Chat', 'input:submit', key)).toBe(false);
  });

  it('returns false when handler returns void', () => {
    const handler = vi.fn(); // returns undefined
    registry.registerHandler('Chat', 'input:submit', handler);

    const key = makeKey({ name: 'enter' });
    expect(registry.invokeAction('Chat', 'input:submit', key)).toBe(false);
  });

  it('unregisters a handler', () => {
    const handler = vi.fn(() => true);
    registry.registerHandler('Global', 'app:exit', handler);
    expect(registry.hasHandler('Global', 'app:exit')).toBe(true);

    registry.unregisterHandler('Global', 'app:exit');
    expect(registry.hasHandler('Global', 'app:exit')).toBe(false);

    // Invoking after unregister should return false
    expect(registry.invokeAction('Global', 'app:exit', makeKey())).toBe(false);
  });

  it('registers and invokes a fallback handler', () => {
    const fallback = vi.fn(() => true);
    registry.registerFallback('Chat', fallback);

    expect(registry.hasFallback('Chat')).toBe(true);

    const key = makeKey();
    const consumed = registry.invokeFallback('Chat', key);

    expect(fallback).toHaveBeenCalledWith(key);
    expect(consumed).toBe(true);
  });

  it('returns false when no fallback exists', () => {
    expect(registry.invokeFallback('Confirmation', makeKey())).toBe(false);
  });

  it('unregisters a fallback handler', () => {
    const fallback = vi.fn(() => true);
    registry.registerFallback('Confirmation', fallback);
    expect(registry.hasFallback('Confirmation')).toBe(true);

    registry.unregisterFallback('Confirmation');
    expect(registry.hasFallback('Confirmation')).toBe(false);
  });

  it('supports multiple contexts with different handlers', () => {
    const globalHandler = vi.fn(() => true);
    const chatHandler = vi.fn(() => true);

    registry.registerHandler('Global', 'app:interrupt', globalHandler);
    registry.registerHandler('Chat', 'input:submit', chatHandler);

    const key = makeKey();

    registry.invokeAction('Global', 'app:interrupt', key);
    expect(globalHandler).toHaveBeenCalledTimes(1);
    expect(chatHandler).not.toHaveBeenCalled();

    registry.invokeAction('Chat', 'input:submit', key);
    expect(chatHandler).toHaveBeenCalledTimes(1);
  });

  it('getActionsForContext returns registered actions', () => {
    registry.registerHandler('Chat', 'input:submit', vi.fn());
    registry.registerHandler('Chat', 'edit:deleteLeft', vi.fn());
    registry.registerHandler('Chat', 'cursor:home', vi.fn());

    const actions = registry.getActionsForContext('Chat');
    expect(actions).toContain('input:submit');
    expect(actions).toContain('edit:deleteLeft');
    expect(actions).toContain('cursor:home');
    expect(actions.length).toBe(3);
  });

  it('clear removes all handlers and fallbacks', () => {
    registry.registerHandler('Global', 'app:interrupt', vi.fn());
    registry.registerHandler('Chat', 'input:submit', vi.fn());
    registry.registerFallback('Chat', vi.fn());

    registry.clear();

    expect(registry.hasHandler('Global', 'app:interrupt')).toBe(false);
    expect(registry.hasHandler('Chat', 'input:submit')).toBe(false);
    expect(registry.hasFallback('Chat')).toBe(false);
  });

  it('stacks handlers for same (context, action) and invokes in registration order', () => {
    const handler1 = vi.fn(() => true);
    const handler2 = vi.fn(() => true);

    registry.registerHandler('Chat', 'input:submit', handler1);
    registry.registerHandler('Chat', 'input:submit', handler2);

    const key = makeKey({ name: 'enter' });
    registry.invokeAction('Chat', 'input:submit', key);

    expect(handler1).toHaveBeenCalledWith(key);
    expect(handler2).not.toHaveBeenCalled();
  });

  it('unregister of non-existent handler is safe', () => {
    // Should not throw
    registry.unregisterHandler('Global', 'nonexistent');
    registry.unregisterFallback('Global');
  });
});
