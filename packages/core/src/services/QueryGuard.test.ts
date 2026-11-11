/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryGuard } from './QueryGuard.js';

describe('QueryGuard', () => {
  describe('initial state', () => {
    it('starts idle', () => {
      const guard = new QueryGuard();
      expect(guard.isActive).toBe(false);
      expect(guard.getSnapshot()).toBe(false);
      expect(guard.generation).toBe(0);
    });
  });

  describe('reserve', () => {
    it('transitions idle -> dispatching', () => {
      const guard = new QueryGuard();
      expect(guard.reserve()).toBe(true);
      expect(guard.isActive).toBe(true);
    });

    it('returns false if already dispatching', () => {
      const guard = new QueryGuard();
      guard.reserve();
      expect(guard.reserve()).toBe(false);
    });

    it('returns false if running', () => {
      const guard = new QueryGuard();
      guard.tryStart();
      expect(guard.reserve()).toBe(false);
    });
  });

  describe('cancelReservation', () => {
    it('transitions dispatching -> idle', () => {
      const guard = new QueryGuard();
      guard.reserve();
      guard.cancelReservation();
      expect(guard.isActive).toBe(false);
    });

    it('no-ops if not dispatching', () => {
      const guard = new QueryGuard();
      guard.cancelReservation(); // idle -> no change
      expect(guard.isActive).toBe(false);

      guard.tryStart();
      guard.cancelReservation(); // running -> no change
      expect(guard.isActive).toBe(true);
    });
  });

  describe('tryStart', () => {
    it('transitions idle -> running, returns generation', () => {
      const guard = new QueryGuard();
      const gen = guard.tryStart();
      expect(gen).toBe(1);
      expect(guard.isActive).toBe(true);
      expect(guard.generation).toBe(1);
    });

    it('transitions dispatching -> running', () => {
      const guard = new QueryGuard();
      guard.reserve();
      const gen = guard.tryStart();
      expect(gen).toBe(1);
      expect(guard.isActive).toBe(true);
    });

    it('returns null if already running', () => {
      const guard = new QueryGuard();
      guard.tryStart();
      expect(guard.tryStart()).toBeNull();
    });

    it('increments generation each call', () => {
      const guard = new QueryGuard();
      const gen1 = guard.tryStart()!;
      guard.end(gen1);
      const gen2 = guard.tryStart()!;
      expect(gen2).toBe(gen1 + 1);
    });
  });

  describe('end', () => {
    it('transitions running -> idle when generation matches', () => {
      const guard = new QueryGuard();
      const gen = guard.tryStart()!;
      expect(guard.end(gen)).toBe(true);
      expect(guard.isActive).toBe(false);
    });

    it('returns false for stale generation', () => {
      const guard = new QueryGuard();
      const gen1 = guard.tryStart()!;
      guard.forceEnd();
      // gen1 is now stale
      expect(guard.end(gen1)).toBe(false);
    });

    it('returns false if not running', () => {
      const guard = new QueryGuard();
      expect(guard.end(0)).toBe(false);
    });
  });

  describe('forceEnd', () => {
    it('transitions running -> idle', () => {
      const guard = new QueryGuard();
      guard.tryStart();
      guard.forceEnd();
      expect(guard.isActive).toBe(false);
    });

    it('transitions dispatching -> idle', () => {
      const guard = new QueryGuard();
      guard.reserve();
      guard.forceEnd();
      expect(guard.isActive).toBe(false);
    });

    it('increments generation so stale end() returns false', () => {
      const guard = new QueryGuard();
      const gen = guard.tryStart()!;
      guard.forceEnd();
      expect(guard.end(gen)).toBe(false);
    });

    it('no-ops if already idle', () => {
      const guard = new QueryGuard();
      const gen = guard.generation;
      guard.forceEnd();
      expect(guard.generation).toBe(gen); // no increment
    });
  });

  describe('useSyncExternalStore interface', () => {
    it('subscribe notifies on state changes', () => {
      const guard = new QueryGuard();
      const listener = vi.fn();
      const unsub = guard.subscribe(listener);

      guard.tryStart();
      expect(listener).toHaveBeenCalledTimes(1);

      guard.forceEnd();
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      guard.tryStart();
      expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
    });

    it('getSnapshot returns isActive', () => {
      const guard = new QueryGuard();
      expect(guard.getSnapshot()).toBe(false);
      guard.tryStart();
      expect(guard.getSnapshot()).toBe(true);
    });
  });

  describe('full lifecycle', () => {
    it('reserve -> tryStart -> end cycle', () => {
      const guard = new QueryGuard();

      // Queue processor reserves
      expect(guard.reserve()).toBe(true);
      expect(guard.isActive).toBe(true);

      // processQueueIfReady calls tryStart
      const gen = guard.tryStart()!;
      expect(gen).toBe(1);
      expect(guard.isActive).toBe(true);

      // Query completes
      expect(guard.end(gen)).toBe(true);
      expect(guard.isActive).toBe(false);

      // Can start new cycle
      expect(guard.reserve()).toBe(true);
    });

    it('reserve -> cancelReservation when queue empty', () => {
      const guard = new QueryGuard();
      guard.reserve();
      guard.cancelReservation();
      expect(guard.isActive).toBe(false);
      // Can reserve again immediately
      expect(guard.reserve()).toBe(true);
    });
  });
});
