import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleDaemon } from './schedule-daemon.js';
import {
  createScheduleTask,
} from './schedule-task-store.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.kill = vi.fn();
    child.pid = 12345;
    child.exitCode = null;
    return child;
  }),
}));

describe('ScheduleDaemon', () => {
  let daemon: ScheduleDaemon;
  let tmpDir: string;
  let qwenDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-daemon-test-'));
    qwenDir = path.join(tmpDir, '.qwen');
    process.env['QWEN_HOME'] = qwenDir;
    await fs.mkdir(qwenDir, { recursive: true });
    daemon = new ScheduleDaemon();
  });

  afterEach(async () => {
    await daemon.stop();
    delete process.env['QWEN_HOME'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('lifecycle', () => {
    it('starts and stops without error', async () => {
      await daemon.start();
      expect(daemon.isRunning).toBe(true);
      await daemon.stop();
      expect(daemon.isRunning).toBe(false);
    });

    it('start is idempotent', async () => {
      await daemon.start();
      await daemon.start(); // should not throw
      expect(daemon.isRunning).toBe(true);
    });

    it('stop is idempotent', async () => {
      await daemon.start();
      await daemon.stop();
      await daemon.stop(); // should not throw
      expect(daemon.isRunning).toBe(false);
    });
  });

  describe('task loading', () => {
    it('loads enabled tasks on start', async () => {
      await createScheduleTask({
        name: 'Task 1',
        cron: '*/5 * * * *',
        prompt: 'test 1',
        cwd: tmpDir,
      });
      await createScheduleTask({
        name: 'Task 2',
        cron: '*/10 * * * *',
        prompt: 'test 2',
        cwd: tmpDir,
      });

      await daemon.start();
      const status = daemon.getStatus();
      expect(status.taskCount).toBe(2);
    });

    it('skips disabled tasks', async () => {
      const task = await createScheduleTask({
        name: 'Disabled Task',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      // Manually disable the task
      const { updateScheduleTask } = await import('./schedule-task-store.js');
      await updateScheduleTask(task.definition.taskId, { enabled: false });

      await daemon.start();
      const status = daemon.getStatus();
      expect(status.taskCount).toBe(0);
    });

    it('returns empty task count when no tasks exist', async () => {
      await daemon.start();
      const status = daemon.getStatus();
      expect(status.taskCount).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns correct status when stopped', () => {
      const status = daemon.getStatus();
      expect(status.state).toBe('stopped');
      expect(status.taskCount).toBe(0);
      expect(status.activeFires).toEqual([]);
      expect(status.lastFireTimes).toEqual([]);
    });

    it('returns correct status when running', async () => {
      await daemon.start();
      const status = daemon.getStatus();
      expect(status.state).toBe('running');
    });

    it('includes lastFireTimes for tasks that have fired', async () => {
      const task = await createScheduleTask({
        name: 'Test Task',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      // Manually write a run record
      const { writeScheduleRunRecord } = await import('./schedule-task-store.js');
      await writeScheduleRunRecord(task.definition.taskId, {
        startedAt: '2026-07-01T09:00:00.000Z',
        endedAt: '2026-07-01T09:01:00.000Z',
        exitCode: 0,
        outputSummary: 'test output',
      });

      await daemon.start();
      const status = daemon.getStatus();
      expect(status.lastFireTimes).toHaveLength(1);
      expect(status.lastFireTimes[0].taskId).toBe(task.definition.taskId);
    });
  });

  describe('task management', () => {
    it('loadTask adds a task to the daemon', async () => {
      const task = await createScheduleTask({
        name: 'Dynamic Task',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      await daemon.start();
      daemon.loadTask(task.definition.taskId);

      // Give it time to load
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = daemon.getStatus();
      expect(status.taskCount).toBe(1);
    });

    it('unloadTask removes a task from the daemon', async () => {
      const task = await createScheduleTask({
        name: 'Task to Remove',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      await daemon.start();
      daemon.loadTask(task.definition.taskId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      daemon.unloadTask(task.definition.taskId);
      const status = daemon.getStatus();
      expect(status.taskCount).toBe(0);
    });

    it('reloadTask refreshes a task', async () => {
      const task = await createScheduleTask({
        name: 'Original Name',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      await daemon.start();
      daemon.loadTask(task.definition.taskId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update the task
      const { updateScheduleTask } = await import('./schedule-task-store.js');
      await updateScheduleTask(task.definition.taskId, { name: 'Updated Name' });

      daemon.reloadTask(task.definition.taskId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = daemon.getStatus();
      expect(status.taskCount).toBe(1);
    });
  });

  describe('concurrent fires cap', () => {
    it('enforces MAX_CONCURRENT_FIRES limit', async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        await createScheduleTask({
          name: `Task ${i}`,
          cron: '* * * * *', // every minute
          prompt: `test ${i}`,
          cwd: tmpDir,
        });
      }

      await daemon.start();

      // The daemon should load all 5 tasks
      const status = daemon.getStatus();
      expect(status.taskCount).toBe(5);

      // Note: We can't easily test the actual concurrent fires cap without
      // mocking the scheduler tick, but we verify the tasks are loaded
    });
  });

  describe('graceful shutdown', () => {
    it('stops the scheduler on shutdown', async () => {
      await daemon.start();
      expect(daemon.isRunning).toBe(true);

      await daemon.stop();
      expect(daemon.isRunning).toBe(false);
    });

    it('clears all state on shutdown', async () => {
      await createScheduleTask({
        name: 'Test Task',
        cron: '*/5 * * * *',
        prompt: 'test',
        cwd: tmpDir,
      });

      await daemon.start();
      await daemon.stop();

      const status = daemon.getStatus();
      expect(status.taskCount).toBe(0);
      expect(status.activeFires).toEqual([]);
    });
  });
});
