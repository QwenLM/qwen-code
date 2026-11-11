/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionHandlerRegistryImpl } from './ActionHandlerRegistry.js';
import type { Key } from './KeypressContext.js';

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    name: '',
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: false,
    sequence: '',
    ...overrides,
  };
}

describe('ActionHandlerRegistryImpl', () => {
  let registry: ActionHandlerRegistryImpl;

  beforeEach(() => {
    registry = new ActionHandlerRegistryImpl();
  });

  describe('registerHandler / invokeAction', () => {
    it('registers and invokes a handler that returns true', () => {
      const handler = vi.fn().mockReturnValue(true);
      registry.registerHandler('Global', 'app:interrupt', handler);

      const key = makeKey({ name: 'c', ctrl: true });
      const consumed = registry.invokeAction('Global', 'app:interrupt', key);

      expect(consumed).toBe(true);
      expect(handler).toHaveBeenCalledWith(key);
    });

    it('returns false when handler returns void', () => {
      const handler = vi.fn(); // returns undefined
      registry.registerHandler('Chat', 'input:submit', handler);

      const consumed = registry.invokeAction('Chat', 'input:submit', makeKey());
      expect(consumed).toBe(false);
    });

    it('returns false when no handler is registered', () => {
      const consumed = registry.invokeAction('Chat', 'input:submit', makeKey());
      expect(consumed).toBe(false);
    });

    it('returns false for wrong context', () => {
      const handler = vi.fn().mockReturnValue(true);
      registry.registerHandler('Chat', 'input:submit', handler);

      const consumed = registry.invokeAction(
        'Dialog',
        'input:submit',
        makeKey(),
      );
      expect(consumed).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('unregisterHandler', () => {
    it('removes handler so invokeAction returns false', () => {
      const handler = vi.fn().mockReturnValue(true);
      registry.registerHandler('Global', 'app:exit', handler);
      registry.unregisterHandler('Global', 'app:exit');

      const consumed = registry.invokeAction('Global', 'app:exit', makeKey());
      expect(consumed).toBe(false);
    });

    it('cleans up empty context map', () => {
      registry.registerHandler('Chat', 'shell:forwardKey', vi.fn());
      registry.unregisterHandler('Chat', 'shell:forwardKey');
      expect(registry.getActionsForContext('Chat')).toHaveLength(0);
    });
  });

  describe('registerFallback / invokeFallback', () => {
    it('invokes the fallback handler for a context', () => {
      const fallback = vi.fn().mockReturnValue(true);
      registry.registerFallback('Confirmation', fallback);

      const key = makeKey({ name: 'a', insertable: true });
      const consumed = registry.invokeFallback('Confirmation', key);

      expect(consumed).toBe(true);
      expect(fallback).toHaveBeenCalledWith(key);
    });

    it('lets a prepended fallback handle its key and falls through for other keys', () => {
      const list = vi.fn().mockReturnValue(true);
      const chat = vi.fn((key: Key) => key.name === '4');
      registry.registerFallback('Select', list);
      registry.registerFallback('Select', chat, { prepend: true });
      expect(registry.invokeFallback('Select', makeKey({ name: '4' }))).toBe(
        true,
      );
      expect(list).not.toHaveBeenCalled();
      expect(registry.invokeFallback('Select', makeKey({ name: '1' }))).toBe(
        true,
      );
      expect(list).toHaveBeenCalledTimes(1);
      registry.unregisterFallback('Select', chat);
      expect(registry.invokeFallback('Select', makeKey({ name: '4' }))).toBe(
        true,
      );
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('returns false when no fallback is registered', () => {
      const consumed = registry.invokeFallback('Confirmation', makeKey());
      expect(consumed).toBe(false);
    });
  });

  describe('unregisterFallback', () => {
    it('removes fallback handler', () => {
      const fallback = vi.fn().mockReturnValue(true);
      registry.registerFallback('Confirmation', fallback);
      registry.unregisterFallback('Confirmation');

      const consumed = registry.invokeFallback('Confirmation', makeKey());
      expect(consumed).toBe(false);
    });
  });

  describe('hasHandler / hasFallback', () => {
    it('reports handler existence', () => {
      expect(registry.hasHandler('Global', 'app:exit')).toBe(false);
      registry.registerHandler('Global', 'app:exit', vi.fn());
      expect(registry.hasHandler('Global', 'app:exit')).toBe(true);
    });

    it('reports fallback existence', () => {
      expect(registry.hasFallback('Confirmation')).toBe(false);
      registry.registerFallback('Confirmation', vi.fn());
      expect(registry.hasFallback('Confirmation')).toBe(true);
    });
  });

  describe('getActionsForContext', () => {
    it('returns all registered actions for a context', () => {
      registry.registerHandler('Global', 'app:interrupt', vi.fn());
      registry.registerHandler('Global', 'app:exit', vi.fn());
      registry.registerHandler('Global', 'app:suspend', vi.fn());

      const actions = registry.getActionsForContext('Global');
      expect(actions).toContain('app:interrupt');
      expect(actions).toContain('app:exit');
      expect(actions).toContain('app:suspend');
      expect(actions).toHaveLength(3);
    });

    it('returns an empty array for a context without handlers', () => {
      expect(registry.getActionsForContext('Confirmation')).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all handlers and fallbacks', () => {
      registry.registerHandler('Global', 'app:interrupt', vi.fn());
      registry.registerFallback('Confirmation', vi.fn());

      registry.clear();

      expect(registry.hasHandler('Global', 'app:interrupt')).toBe(false);
      expect(registry.hasFallback('Confirmation')).toBe(false);
    });
  });

  describe('stacked handler behavior', () => {
    it('first registered handler that consumes wins for same (context, action)', () => {
      const first = vi.fn().mockReturnValue(true);
      const second = vi.fn().mockReturnValue(true);

      registry.registerHandler('Chat', 'input:submit', first);
      registry.registerHandler('Chat', 'input:submit', second);

      registry.invokeAction('Chat', 'input:submit', makeKey());

      // With stacked handlers, first registered handler is tried first
      expect(first).toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
    });

    it('falls through to next handler when first returns false', () => {
      const first = vi.fn().mockReturnValue(false);
      const second = vi.fn().mockReturnValue(true);

      registry.registerHandler('Chat', 'input:submit', first);
      registry.registerHandler('Chat', 'input:submit', second);

      const consumed = registry.invokeAction('Chat', 'input:submit', makeKey());

      expect(first).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      expect(consumed).toBe(true);
    });

    it('unregistering a specific handler preserves other handlers', () => {
      const first = vi.fn().mockReturnValue(true);
      const second = vi.fn().mockReturnValue(true);

      registry.registerHandler('Chat', 'input:submit', first);
      registry.registerHandler('Chat', 'input:submit', second);
      registry.unregisterHandler('Chat', 'input:submit', first);

      registry.invokeAction('Chat', 'input:submit', makeKey());

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    });
  });
});
