import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalMode } from '../../config/config.js';
import {
  deleteTask,
  getTaskManifestPath,
  isTaskEnabled,
  listTasks,
  parseTaskManifest,
  readState,
  readTask,
  sanitizeTaskId,
  serializeTaskManifest,
  updateState,
  writeState,
  writeTask,
  type ScheduledTask,
} from './task-store.js';

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'daily-pr-review',
    name: 'daily-pr-review',
    description: 'Review the day’s new PRs each weekday morning',
    schedule: { cron: '0 9 * * 1-5', enabled: true },
    cwd: '/Users/dragon/Documents/qwen-code',
    model: 'claude-opus-4-8',
    approvalMode: ApprovalMode.AUTO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'Review new PRs opened in the last 24h. Be self-contained.',
    ...overrides,
  };
}

describe('schedule/task-store', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-store-'));
    prevHome = process.env['QWEN_HOME'];
    // getScheduledTasksDir() resolves under getGlobalQwenDir(), which honors
    // QWEN_HOME first — redirect the whole store into the temp dir.
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('sanitizeTaskId', () => {
    it('kebab-cases and strips unsafe characters', () => {
      expect(sanitizeTaskId('Daily PR Review!')).toBe('daily-pr-review');
      expect(sanitizeTaskId('  ../../etc/passwd  ')).toBe('etc-passwd');
      expect(sanitizeTaskId('a__b--c')).toBe('a-b-c');
      expect(sanitizeTaskId('...')).toBe('');
    });

    it('never lets a path separator or dot-segment survive', () => {
      const id = sanitizeTaskId('foo/../bar');
      expect(id).not.toContain('/');
      expect(id).not.toContain('..');
      expect(id).toBe('foo-bar');
    });
  });

  describe('serialize / parse round-trip', () => {
    it('preserves every field for a recurring task', () => {
      const task = makeTask();
      const parsed = parseTaskManifest(serializeTaskManifest(task), task.id);
      expect(parsed).toEqual(task);
    });

    it('preserves a one-shot fireAt task', () => {
      const task = makeTask({
        id: 'cleanup-once',
        name: 'cleanup-once',
        schedule: { fireAt: '2026-07-02T15:00:00+08:00', enabled: true },
      });
      const parsed = parseTaskManifest(serializeTaskManifest(task), task.id);
      expect(parsed.schedule).toEqual({
        fireAt: '2026-07-02T15:00:00+08:00',
        enabled: true,
      });
      expect(parsed.schedule.cron).toBeUndefined();
    });

    it('throws when frontmatter is missing', () => {
      expect(() => parseTaskManifest('no frontmatter here', 'x')).toThrow(
        /missing YAML frontmatter/,
      );
    });

    it('defaults an unknown approvalMode to AUTO', () => {
      const md = `---\nname: t\ndescription: d\nschedule:\n  cron: "0 9 * * *"\n  enabled: true\ncwd: /tmp\napprovalMode: banana\nnotify: next-session\nsandbox: false\n---\n\nbody`;
      expect(parseTaskManifest(md, 't').approvalMode).toBe(ApprovalMode.AUTO);
    });

    it('lets cron win when both cron and fireAt are present', () => {
      const md = `---\nname: t\ndescription: d\nschedule:\n  cron: "0 9 * * *"\n  fireAt: "2026-07-02T15:00:00+08:00"\n  enabled: true\ncwd: /tmp\n---\n\nbody`;
      const parsed = parseTaskManifest(md, 't');
      expect(parsed.schedule.cron).toBe('0 9 * * *');
      expect(parsed.schedule.fireAt).toBeUndefined();
    });
  });

  describe('read / write / list / delete', () => {
    it('round-trips a task through disk', async () => {
      const task = makeTask();
      await writeTask(task);
      expect(await readTask(task.id)).toEqual(task);
    });

    it('returns null for a missing task', async () => {
      expect(await readTask('nope')).toBeNull();
    });

    it('lists tasks sorted by id and skips unparseable dirs', async () => {
      await writeTask(makeTask({ id: 'zeta', name: 'zeta' }));
      await writeTask(makeTask({ id: 'alpha', name: 'alpha' }));
      // A directory with a malformed manifest must not hide the rest.
      const badDir = path.dirname(getTaskManifestPath('broken'));
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(getTaskManifestPath('broken'), 'garbage');

      const ids = (await listTasks()).map((t) => t.id);
      expect(ids).toEqual(['alpha', 'zeta']);
    });

    it('returns [] when the store dir does not exist', async () => {
      expect(await listTasks()).toEqual([]);
    });

    it('deletes a task and reports existence', async () => {
      await writeTask(makeTask({ id: 'gone' }));
      expect(await deleteTask('gone')).toBe(true);
      expect(await readTask('gone')).toBeNull();
      expect(await deleteTask('gone')).toBe(false);
    });
  });

  describe('runtime state', () => {
    it('defaults to empty when absent', async () => {
      expect(await readState('x')).toEqual({
        lastFiredAt: null,
        nextRunAt: null,
        lastRunId: null,
        enabledOverride: null,
      });
    });

    it('round-trips and updates state without touching SKILL.md', async () => {
      const task = makeTask({ id: 'stateful' });
      await writeTask(task);
      const before = await fs.readFile(getTaskManifestPath('stateful'), 'utf8');

      await writeState('stateful', {
        lastFiredAt: 111,
        nextRunAt: 222,
        lastRunId: 'run01',
        enabledOverride: null,
      });
      const updated = await updateState('stateful', (s) => ({
        ...s,
        lastFiredAt: 333,
      }));
      expect(updated.lastFiredAt).toBe(333);
      expect(updated.lastRunId).toBe('run01');

      // The daemon writing state must never rewrite the user's definition.
      expect(await fs.readFile(getTaskManifestPath('stateful'), 'utf8')).toBe(
        before,
      );
    });

    it('treats corrupt state.json as empty', async () => {
      const task = makeTask({ id: 'corrupt' });
      await writeTask(task);
      await fs.writeFile(
        path.join(path.dirname(getTaskManifestPath('corrupt')), 'state.json'),
        '{not json',
      );
      expect((await readState('corrupt')).lastFiredAt).toBeNull();
    });
  });

  describe('isTaskEnabled', () => {
    it('lets a runtime override win over the manifest flag', () => {
      const task = makeTask({ schedule: { cron: '0 9 * * *', enabled: true } });
      expect(
        isTaskEnabled(task, {
          lastFiredAt: null,
          nextRunAt: null,
          lastRunId: null,
          enabledOverride: false,
        }),
      ).toBe(false);
      expect(
        isTaskEnabled(task, {
          lastFiredAt: null,
          nextRunAt: null,
          lastRunId: null,
          enabledOverride: null,
        }),
      ).toBe(true);
    });
  });
});
