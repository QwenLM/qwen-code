import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createScheduleTask,
  readScheduleTask,
  listScheduleTasks,
  updateScheduleTask,
  deleteScheduleTask,
  writeScheduleRunRecord,
  getScheduleRunRecords,
  formatScheduleTaskSummary,
  getScheduleCatchUpSummary,
} from './schedule-task-store.js';

describe('scheduleTaskStore', () => {
  let tmpDir: string;
  let qwenDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-store-test-'));
    qwenDir = path.join(tmpDir, '.qwen');
    process.env['QWEN_HOME'] = qwenDir;
    await fs.mkdir(qwenDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env['QWEN_HOME'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('createScheduleTask', () => {
    it('creates a task and writes SKILL.md + state.json', async () => {
      const task = await createScheduleTask({
        name: 'Daily PR Review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the PRs',
        cwd: tmpDir,
        approvalMode: 'auto',
      });

      expect(task.definition.taskId).toHaveLength(16);
      expect(task.definition.name).toBe('Daily PR Review');
      expect(task.definition.schedule.cron).toBe('0 9 * * 1-5');
      expect(task.definition.schedule.enabled).toBe(true);
      expect(task.definition.prompt).toBe('Review the PRs');
      expect(task.state.runs).toEqual([]);
      expect(task.state.lastFiredAt).toBeNull();

      // Verify files on disk
      const skillPath = path.join(
        qwenDir,
        'scheduled-tasks',
        task.definition.taskId,
        'SKILL.md',
      );
      const statePath = path.join(
        qwenDir,
        'scheduled-tasks',
        task.definition.taskId,
        'state.json',
      );

      const skillContent = await fs.readFile(skillPath, 'utf-8');
      expect(skillContent).toContain('name: Daily PR Review');
      expect(skillContent).toContain('cron: 0 9 * * 1-5');
      expect(skillContent).toContain('Review the PRs');

      const stateContent = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);
      expect(state.runs).toEqual([]);
      expect(state.lastFiredAt).toBeNull();
    });

    it('rejects invalid cron expressions', async () => {
      await expect(
        createScheduleTask({
          name: 'Bad',
          cron: 'invalid cron',
          prompt: 'test',
        }),
      ).rejects.toThrow(/Cron expression/);
    });

    it('rejects cron that never matches a date', async () => {
      await expect(
        createScheduleTask({
          name: 'Never',
          cron: '0 0 30 2 *', // Feb 30 doesn't exist
          prompt: 'test',
        }),
      ).rejects.toThrow(/matching fire time/);
    });
  });

  describe('readScheduleTask', () => {
    it('reads a task back from disk', async () => {
      const created = await createScheduleTask({
        name: 'Test',
        cron: '*/5 * * * *',
        prompt: 'Check build',
      });

      const read = await readScheduleTask(created.definition.taskId);
      expect(read).not.toBeNull();
      expect(read!.definition.name).toBe('Test');
      expect(read!.definition.prompt).toBe('Check build');
    });

    it('returns null for non-existent task', async () => {
      const read = await readScheduleTask('nonexistent');
      expect(read).toBeNull();
    });
  });

  describe('listScheduleTasks', () => {
    it('lists all created tasks', async () => {
      await createScheduleTask({
        name: 'Task A',
        cron: '*/1 * * * *',
        prompt: 'a',
      });
      await createScheduleTask({
        name: 'Task B',
        cron: '*/5 * * * *',
        prompt: 'b',
      });

      const tasks = await listScheduleTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.definition.name).sort()).toEqual([
        'Task A',
        'Task B',
      ]);
    });

    it('returns empty array when no tasks', async () => {
      const tasks = await listScheduleTasks();
      expect(tasks).toEqual([]);
    });

    it('skips non-directory entries', async () => {
      const tasksDir = path.join(qwenDir, 'scheduled-tasks');
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, 'not-a-task.txt'), 'hello');

      const tasks = await listScheduleTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe('updateScheduleTask', () => {
    it('updates task fields', async () => {
      const created = await createScheduleTask({
        name: 'Original',
        cron: '*/5 * * * *',
        prompt: 'original prompt',
      });

      const updated = await updateScheduleTask(created.definition.taskId, {
        name: 'Updated',
        prompt: 'new prompt',
      });

      expect(updated).not.toBeNull();
      expect(updated!.definition.name).toBe('Updated');
      expect(updated!.definition.prompt).toBe('new prompt');
    });

    it('validates cron on update', async () => {
      const created = await createScheduleTask({
        name: 'Test',
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      await expect(
        updateScheduleTask(created.definition.taskId, { cron: 'bad' }),
      ).rejects.toThrow(/Cron expression/);
    });

    it('returns null for non-existent task', async () => {
      const result = await updateScheduleTask('nonexistent', { name: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('deleteScheduleTask', () => {
    it('deletes a task and its directory', async () => {
      const created = await createScheduleTask({
        name: 'Delete Me',
        cron: '*/1 * * * *',
        prompt: 'bye',
      });

      const ok = await deleteScheduleTask(created.definition.taskId);
      expect(ok).toBe(true);

      const read = await readScheduleTask(created.definition.taskId);
      expect(read).toBeNull();
    });

    it('returns false for non-existent task', async () => {
      const ok = await deleteScheduleTask('nonexistent');
      expect(ok).toBe(false);
    });
  });

  describe('writeScheduleRunRecord / getScheduleRunRecords', () => {
    it('writes and reads run records', async () => {
      const created = await createScheduleTask({
        name: 'Test',
        cron: '*/1 * * * *',
        prompt: 'test',
      });

      await writeScheduleRunRecord(created.definition.taskId, {
        startedAt: '2026-07-01T09:00:00.000Z',
        endedAt: '2026-07-01T09:01:00.000Z',
        exitCode: 0,
        outputSummary: 'All good',
      });

      const records = await getScheduleRunRecords(
        created.definition.taskId,
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.exitCode).toBe(0);
      expect(records[0]!.outputSummary).toBe('All good');
    });

    it('supports FIFO eviction beyond maxRuns', async () => {
      const created = await createScheduleTask({
        name: 'Test',
        cron: '*/1 * * * *',
        prompt: 'test',
      });

      // Write 51 runs — only 50 should be kept
      for (let i = 0; i < 51; i++) {
        await writeScheduleRunRecord(created.definition.taskId, {
          startedAt: `2026-07-01T${String(i).padStart(2, '0')}:00:00.000Z`,
          endedAt: `2026-07-01T${String(i).padStart(2, '0')}:01:00.000Z`,
          exitCode: 0,
          outputSummary: `Run ${i}`,
        });
      }

      const records = await getScheduleRunRecords(
        created.definition.taskId,
      );
      expect(records.length).toBeLessThanOrEqual(50);
      // First run (i=0) should be evicted
      expect(records[0]!.outputSummary).not.toBe('Run 0');
      // Last run should be kept
      expect(records[records.length - 1]!.outputSummary).toBe('Run 50');
    });

    it('returns empty array for non-existent task', async () => {
      const records = await getScheduleRunRecords('nonexistent');
      expect(records).toEqual([]);
    });

    it('updates lastFiredAt on write', async () => {
      const created = await createScheduleTask({
        name: 'Test',
        cron: '*/1 * * * *',
        prompt: 'test',
      });

      await writeScheduleRunRecord(created.definition.taskId, {
        startedAt: '2026-07-01T09:00:00.000Z',
        endedAt: '2026-07-01T09:01:00.000Z',
        exitCode: 0,
        outputSummary: 'ok',
      });

      const task = await readScheduleTask(created.definition.taskId);
      expect(task!.state.lastFiredAt).toBe('2026-07-01T09:01:00.000Z');
    });
  });

  describe('formatScheduleTaskSummary', () => {
    it('formats a task summary', async () => {
      const task = await createScheduleTask({
        name: 'Daily Build',
        cron: '0 9 * * 1-5',
        prompt: 'Check the build',
      });

      const summary = formatScheduleTaskSummary(task);
      expect(summary).toContain(task.definition.taskId);
      expect(summary).toContain('Daily Build');
      expect(summary).toContain('0 9 * * 1-5');
      expect(summary).toContain('enabled');
    });
  });

  describe('getScheduleCatchUpSummary', () => {
    it('returns null when no new runs', async () => {
      const summary = await getScheduleCatchUpSummary(
        '2026-01-01T00:00:00.000Z',
      );
      expect(summary).toBeNull();
    });

    it('returns runs newer than since', async () => {
      const task = await createScheduleTask({
        name: 'Test',
        cron: '*/1 * * * *',
        prompt: 'test',
      });

      await writeScheduleRunRecord(task.definition.taskId, {
        startedAt: '2026-07-01T09:00:00.000Z',
        endedAt: '2026-07-01T09:01:00.000Z',
        exitCode: 0,
        outputSummary: 'Build passed',
      });

      const summary = await getScheduleCatchUpSummary(
        '2026-06-01T00:00:00.000Z',
      );
      expect(summary).not.toBeNull();
      expect(summary).toContain('Build passed');
      expect(summary).toContain('Test');
    });
  });
});
