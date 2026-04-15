/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BackgroundTaskHub, globalBackgroundTaskHub } from './taskHub.js';

const TYPE_A = 'test-type-a';
const TYPE_B = 'test-type-b';

describe('BackgroundTaskHub', () => {
  describe('createScheduler()', () => {
    it('returns a scheduler wired to the hub registry and drainer', async () => {
      const hub = new BackgroundTaskHub();
      const scheduler = hub.createScheduler();

      let resolveRun: (() => void) | undefined;
      const scheduled = scheduler.schedule({
        taskType: TYPE_A,
        title: 'Test task',
        projectRoot: '/project',
        run: () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      });

      // Task should appear in the shared registry immediately
      const pending = hub.registry.get(scheduled.taskId);
      expect(pending?.status).toBe('running');
      expect(pending?.taskType).toBe(TYPE_A);

      resolveRun?.();
      await scheduled.promise;

      const completed = hub.registry.get(scheduled.taskId);
      expect(completed?.status).toBe('completed');
    });

    it('each call to createScheduler() returns a distinct scheduler instance sharing the same hub', () => {
      const hub = new BackgroundTaskHub();
      const s1 = hub.createScheduler();
      const s2 = hub.createScheduler();
      expect(s1).not.toBe(s2);
    });
  });

  describe('listByType()', () => {
    it('returns only tasks matching the given taskType', async () => {
      const hub = new BackgroundTaskHub();
      const scheduler = hub.createScheduler();

      scheduler.schedule({
        taskType: TYPE_A,
        title: 'A task',
        projectRoot: '/project',
        run: async () => {},
      });
      scheduler.schedule({
        taskType: TYPE_B,
        title: 'B task',
        projectRoot: '/project',
        run: async () => {},
      });

      await hub.drain();

      const aOnly = hub.listByType(TYPE_A);
      expect(aOnly).toHaveLength(1);
      expect(aOnly[0]!.taskType).toBe(TYPE_A);

      const bOnly = hub.listByType(TYPE_B);
      expect(bOnly).toHaveLength(1);
      expect(bOnly[0]!.taskType).toBe(TYPE_B);
    });

    it('filters by projectRoot when provided', async () => {
      const hub = new BackgroundTaskHub();
      const scheduler = hub.createScheduler();

      scheduler.schedule({
        taskType: TYPE_A,
        title: 'A in /project1',
        projectRoot: '/project1',
        run: async () => {},
      });
      scheduler.schedule({
        taskType: TYPE_A,
        title: 'A in /project2',
        projectRoot: '/project2',
        run: async () => {},
      });

      await hub.drain();

      expect(hub.listByType(TYPE_A, '/project1')).toHaveLength(1);
      expect(hub.listByType(TYPE_A, '/project2')).toHaveLength(1);
      expect(hub.listByType(TYPE_A)).toHaveLength(2);
    });

    it('returns an empty array when no tasks of that type exist', () => {
      const hub = new BackgroundTaskHub();
      expect(hub.listByType('nonexistent-type')).toEqual([]);
    });

    it('two different task types registered to the same hub are visible in the shared registry but separated by listByType()', async () => {
      const hub = new BackgroundTaskHub();
      const sA = hub.createScheduler();
      const sB = hub.createScheduler();

      sA.schedule({
        taskType: TYPE_A,
        title: 'A',
        projectRoot: '/p',
        run: async () => {},
      });
      sB.schedule({
        taskType: TYPE_B,
        title: 'B',
        projectRoot: '/p',
        run: async () => {},
      });

      await hub.drain();

      // Shared registry sees all tasks
      expect(hub.registry.list()).toHaveLength(2);
      // listByType gives domain-specific filtered views
      expect(hub.listByType(TYPE_A)).toHaveLength(1);
      expect(hub.listByType(TYPE_B)).toHaveLength(1);
    });
  });

  describe('drain()', () => {
    it('resolves true when all in-flight tasks complete', async () => {
      const hub = new BackgroundTaskHub();
      const scheduler = hub.createScheduler();

      let resolveRun: (() => void) | undefined;
      scheduler.schedule({
        taskType: TYPE_A,
        title: 'Slow task',
        projectRoot: '/project',
        run: () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      });

      // Drain times out while task is blocked
      expect(await hub.drain({ timeoutMs: 10 })).toBe(false);

      resolveRun?.();
      expect(await hub.drain()).toBe(true);
    });

    it('resolves true immediately when no tasks are in flight', async () => {
      const hub = new BackgroundTaskHub();
      expect(await hub.drain()).toBe(true);
    });
  });

  describe('isolation between hub instances', () => {
    it('tasks registered in one hub do not appear in another hub', async () => {
      const hubA = new BackgroundTaskHub();
      const hubB = new BackgroundTaskHub();

      hubA.createScheduler().schedule({
        taskType: TYPE_A,
        title: 'task in A',
        projectRoot: '/p',
        run: async () => {},
      });

      await hubA.drain();

      expect(hubA.listByType(TYPE_A)).toHaveLength(1);
      expect(hubB.listByType(TYPE_A)).toHaveLength(0);
      expect(hubB.registry.list()).toHaveLength(0);
    });
  });

  describe('globalBackgroundTaskHub', () => {
    it('is a BackgroundTaskHub instance', () => {
      expect(globalBackgroundTaskHub).toBeInstanceOf(BackgroundTaskHub);
    });

    it('exposes a registry and drainer', () => {
      expect(globalBackgroundTaskHub.registry).toBeDefined();
      expect(globalBackgroundTaskHub.drainer).toBeDefined();
    });
  });
});
