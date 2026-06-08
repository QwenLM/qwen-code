/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRegistry } from './registry.js';
import { registerTaskKind, _resetTaskKindsForTest } from './dispatcher.js';
import type { RegistryTaskKind, TaskState, TaskStatus } from './types.js';

/**
 * Minimal `TaskState` carrying only the envelope fields the registry
 * reads (`id`, `kind`, `status`). The registry is kind-agnostic, so the
 * per-kind shapes don't matter here — cast through `unknown`.
 */
function makeEntry(
  id: string,
  kind: RegistryTaskKind,
  status: TaskStatus = 'running',
): TaskState {
  return {
    id,
    kind,
    description: id,
    status,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    abortController: new AbortController(),
  } as unknown as TaskState;
}

describe('TaskRegistry', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  describe('register / get / getAll / getByKind', () => {
    it('register inserts the entry, returns it, and fires the listener', () => {
      const listener = vi.fn();
      registry.subscribe(listener);

      const entry = makeEntry('a1', 'agent');
      const returned = registry.register(entry);

      expect(returned).toBe(entry);
      expect(registry.get('a1')).toBe(entry);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(entry);
    });

    it('register with a duplicate id overwrites the prior entry', () => {
      registry.register(makeEntry('a1', 'agent'));
      const replacement = makeEntry('a1', 'agent', 'completed');
      registry.register(replacement);

      expect(registry.get('a1')).toBe(replacement);
      expect(registry.getAll()).toHaveLength(1);
    });

    it('get returns undefined for a missing id', () => {
      expect(registry.get('missing')).toBeUndefined();
    });

    it('getAll returns every entry regardless of kind', () => {
      registry.register(makeEntry('a1', 'agent'));
      registry.register(makeEntry('s1', 'shell'));
      registry.register(makeEntry('m1', 'monitor'));

      expect(
        registry
          .getAll()
          .map((e) => e.id)
          .sort(),
      ).toEqual(['a1', 'm1', 's1']);
    });

    it('getByKind returns only entries of the requested kind', () => {
      registry.register(makeEntry('a1', 'agent'));
      registry.register(makeEntry('a2', 'agent'));
      registry.register(makeEntry('s1', 'shell'));

      expect(
        registry
          .getByKind('agent')
          .map((e) => e.id)
          .sort(),
      ).toEqual(['a1', 'a2']);
      expect(registry.getByKind('shell').map((e) => e.id)).toEqual(['s1']);
      expect(registry.getByKind('monitor')).toEqual([]);
    });
  });

  describe('update', () => {
    it('mutates the entry and fires the listener', () => {
      registry.register(makeEntry('a1', 'agent'));
      const listener = vi.fn();
      registry.subscribe(listener);

      const result = registry.update('a1', (current) => {
        current.status = 'completed';
        return current;
      });

      expect(result?.status).toBe('completed');
      expect(registry.get('a1')?.status).toBe('completed');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('returns undefined and does not fire for a missing id', () => {
      const listener = vi.fn();
      registry.subscribe(listener);

      const result = registry.update('missing', (c) => c);

      expect(result).toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('stores a replacement object returned by the updater', () => {
      const original = makeEntry('a1', 'agent');
      registry.register(original);
      const replacement = makeEntry('a1', 'agent', 'failed');

      registry.update('a1', () => replacement);

      expect(registry.get('a1')).toBe(replacement);
    });
  });

  describe('mutateSilent', () => {
    it('mutates the entry WITHOUT firing the listener', () => {
      registry.register(makeEntry('m1', 'monitor'));
      const listener = vi.fn();
      registry.subscribe(listener);

      const result = registry.mutateSilent('m1', (current) => {
        current.status = 'completed';
        return current;
      });

      expect(result?.status).toBe('completed');
      expect(registry.get('m1')?.status).toBe('completed');
      expect(listener).not.toHaveBeenCalled();
    });

    it('returns undefined for a missing id', () => {
      expect(registry.mutateSilent('missing', (c) => c)).toBeUndefined();
    });
  });

  describe('evict', () => {
    it('removes the entry and fires the listener with the removed entry', () => {
      const entry = makeEntry('a1', 'agent', 'completed');
      registry.register(entry);
      const listener = vi.fn();
      registry.subscribe(listener);

      registry.evict('a1');

      expect(registry.get('a1')).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(entry);
    });

    it('is a no-op (no listener fire) for a missing id', () => {
      const listener = vi.fn();
      registry.subscribe(listener);

      registry.evict('missing');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('fans out to multiple listeners', () => {
      const a = vi.fn();
      const b = vi.fn();
      registry.subscribe(a);
      registry.subscribe(b);

      registry.register(makeEntry('a1', 'agent'));

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('stops notifying after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = registry.subscribe(listener);

      registry.register(makeEntry('a1', 'agent'));
      unsubscribe();
      registry.register(makeEntry('a2', 'agent'));

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('swallows a listener exception so other listeners still run', () => {
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const healthy = vi.fn();
      registry.subscribe(throwing);
      registry.subscribe(healthy);

      expect(() => registry.register(makeEntry('a1', 'agent'))).not.toThrow();
      expect(healthy).toHaveBeenCalledTimes(1);
    });
  });

  describe('kill dispatch', () => {
    afterEach(() => {
      _resetTaskKindsForTest();
    });

    it("dispatches to the entry kind's kill via the dispatcher", async () => {
      const kill = vi.fn();
      registerTaskKind({ kind: 'agent', name: 'agent', kill });
      registry.register(makeEntry('a1', 'agent'));
      const ctx = {
        registry,
        memoryManager: {} as never,
      };

      await registry.kill('a1', ctx);

      expect(kill).toHaveBeenCalledWith('a1', ctx);
    });

    it('routes to the correct kind when multiple kinds are registered', async () => {
      const agentKill = vi.fn();
      const shellKill = vi.fn();
      registerTaskKind({ kind: 'agent', name: 'agent', kill: agentKill });
      registerTaskKind({ kind: 'shell', name: 'shell', kill: shellKill });
      registry.register(makeEntry('s1', 'shell'));

      await registry.kill('s1', { registry, memoryManager: {} as never });

      expect(shellKill).toHaveBeenCalledTimes(1);
      expect(agentKill).not.toHaveBeenCalled();
    });

    it('is a no-op for a missing id (does not throw or dispatch)', async () => {
      const kill = vi.fn();
      registerTaskKind({ kind: 'agent', name: 'agent', kill });

      await expect(
        registry.kill('missing', { registry, memoryManager: {} as never }),
      ).resolves.toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  describe('_resetForTest', () => {
    it('clears all entries and listeners', () => {
      const listener = vi.fn();
      registry.subscribe(listener);
      registry.register(makeEntry('a1', 'agent'));
      listener.mockClear();

      registry._resetForTest();

      expect(registry.getAll()).toEqual([]);
      registry.register(makeEntry('a2', 'agent'));
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
