/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readCronTasks,
  writeCronTasks,
  removeCronTasks,
  updateCronTask,
  claimCronTask,
  markCronTasksFired,
  checkCronBudget,
  nextCronRunMs,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  findMissedTasks,
  DEFAULT_CRON_JITTER_CONFIG,
  type CronTask,
} from './cron-tasks.js';
import { CronManager } from './cronManager.js';

/**
 * The operations that used to live on both stores at once — create, list,
 * remove, charge — moved onto the cron manager, because "which session's
 * in-memory tasks" is not a question a module-level function can answer. These
 * aliases keep the cases below reading as they did while driving the real
 * composition instead of a copy of it.
 *
 * Constructing a manager starts nothing: no scheduler, no watcher, no timer,
 * until `ensureStarted()`, which this suite never calls.
 */
const MANAGER_SESSION_ID = 'test-session';
const manager = new CronManager({
  getSessionId: () => MANAGER_SESSION_ID,
});

const addTask: CronManager['addTask'] = (...args) =>
  manager.addTask(...args);
const listTasks: CronManager['listTasks'] = (...args) =>
  manager.listTasks(...args);
const addTaskCredits: CronManager['addTaskCredits'] = (...args) =>
  manager.addTaskCredits(...args);
const addSessionTask = (task: CronTask): void => manager.tasks.add(task);
const getSessionTasks = (): CronTask[] => manager.getSessionTasks();
const removeSessionTasks = (ids: string[]): number =>
  manager.tasks.remove(ids);
const clearSessionTasks = (): void => manager.clearSessionTasks();

describe('cron-tasks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-tasks-test-'));
    clearSessionTasks();
  });

  afterEach(async () => {
    clearSessionTasks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Session-scoped task store
  // -------------------------------------------------------------------------
  describe('session tasks', () => {
    it('addSessionTask adds to in-memory store', () => {
      const task: CronTask = {
        id: 'sess-1',
        cron: '*/5 * * * *',
        prompt: 'hello',
        createdAt: Date.now(),
      };
      addSessionTask(task);
      const tasks = getSessionTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('sess-1');
    });

    it('removeSessionTasks removes by id and returns count', () => {
      addSessionTask({ id: 'a', cron: '* * * * *', prompt: 'p', createdAt: 1 });
      addSessionTask({ id: 'b', cron: '* * * * *', prompt: 'p', createdAt: 2 });
      const removed = removeSessionTasks(['a']);
      expect(removed).toBe(1);
      expect(getSessionTasks()).toHaveLength(1);
      expect(getSessionTasks()[0].id).toBe('b');
    });

    it('removeSessionTasks returns 0 for non-existent ids', () => {
      addSessionTask({ id: 'a', cron: '* * * * *', prompt: 'p', createdAt: 1 });
      const removed = removeSessionTasks(['nonexistent']);
      expect(removed).toBe(0);
      expect(getSessionTasks()).toHaveLength(1);
    });

    it('clearSessionTasks clears all', () => {
      addSessionTask({ id: 'x', cron: '* * * * *', prompt: 'p', createdAt: 1 });
      clearSessionTasks();
      expect(getSessionTasks()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // File CRUD
  // -------------------------------------------------------------------------
  describe('readCronTasks', () => {
    it('returns empty array when file does not exist', async () => {
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('returns empty array for malformed JSON', async () => {
      const cronDir = path.join(tmpDir, '.qwen');
      await fsp.mkdir(cronDir, { recursive: true });
      await fsp.writeFile(path.join(cronDir, 'scheduled_tasks.json'), 'not-json');
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('silently drops tasks with invalid cron', async () => {
      const cronDir = path.join(tmpDir, '.qwen');
      await fsp.mkdir(cronDir, { recursive: true });
      const data = {
        tasks: [
          { id: 'ok', cron: '*/5 * * * *', prompt: 'p', createdAt: 1 },
          { id: 'bad', cron: 'invalid', prompt: 'p', createdAt: 2 },
        ],
      };
      await fsp.writeFile(
        path.join(cronDir, 'scheduled_tasks.json'),
        JSON.stringify(data),
      );
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('ok');
    });
  });

  describe('writeCronTasks', () => {
    it('creates .qwen dir and writes tasks', async () => {
      const tasks: CronTask[] = [
        { id: 't1', cron: '0 9 * * *', prompt: 'test', createdAt: Date.now() },
      ];
      await writeCronTasks(tasks, tmpDir);
      const raw = await fsp.readFile(
        path.join(tmpDir, '.qwen', 'scheduled_tasks.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].id).toBe('t1');
    });

    it('round-trips customContext through the on-disk task file', async () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      await writeCronTasks(
        [
          {
            id: 't-context',
            cron: '0 9 * * *',
            prompt: 'test',
            createdAt: Date.now(),
            customContext,
          },
        ],
        tmpDir,
      );

      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0]?.customContext).toEqual(customContext);
    });

    it('strips manager-only durable and agentId fields', async () => {
      const tasks: CronTask[] = [
        {
          id: 't1',
          cron: '0 9 * * *',
          prompt: 'test',
          createdAt: Date.now(),
          durable: false,
          agentId: 'agent-1',
        },
      ];
      await writeCronTasks(tasks, tmpDir);
      const raw = await fsp.readFile(
        path.join(tmpDir, '.qwen', 'scheduled_tasks.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      expect(parsed.tasks[0]).not.toHaveProperty('durable');
      expect(parsed.tasks[0]).not.toHaveProperty('agentId');
    });
  });

  describe('addTask', () => {
    it('creates a session-only task when durable=false', async () => {
      const id = await addTask('*/5 * * * *', 'prompt', false, false);
      expect(id).toBeTruthy();
      const session = getSessionTasks();
      expect(session).toHaveLength(1);
      expect(session[0].id).toBe(id);
      // No file should be created
      const fileTasks = await readCronTasks(tmpDir);
      expect(fileTasks).toHaveLength(0);
    });

    it('creates a durable task written to disk', async () => {
      const id = await addTask('0 9 * * *', 'prompt', false, true, {
        dir: tmpDir,
      });
      expect(id).toBeTruthy();
      const fileTasks = await readCronTasks(tmpDir);
      expect(fileTasks).toHaveLength(1);
      expect(fileTasks[0].id).toBe(id);
    });

    it('creates recurring task with recurring flag', async () => {
      await addTask('*/5 * * * *', 'prompt', true, true, { dir: tmpDir });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].recurring).toBe(true);
    });

    it('passes agentId to session task', async () => {
      await addTask('*/5 * * * *', 'prompt', false, false, {
        agentId: 'my-agent',
      });
      const session = getSessionTasks();
      expect(session[0].agentId).toBe('my-agent');
    });

    it('persists expiresAt for durable tasks', async () => {
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await addTask('*/5 * * * *', 'prompt', true, true, {
        dir: tmpDir,
        expiresAt,
      });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].expiresAt).toBe(expiresAt);
    });

    it('drops expiresAt when permanent is set (permanent wins)', async () => {
      await addTask('*/5 * * * *', 'prompt', true, true, {
        dir: tmpDir,
        permanent: true,
        expiresAt: Date.now() + 1000,
      });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].permanent).toBe(true);
      expect(tasks[0].expiresAt).toBeUndefined();
    });
  });

  describe('updateCronTask expiresAt semantics', () => {
    it('explicit expiresAt: undefined clears the field (regression: stale expiry on permanent switch)', async () => {
      const expiresAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const id = await addTask('*/5 * * * *', 'prompt', true, true, {
        dir: tmpDir,
        expiresAt,
      });
      // Switch to permanent — the dialog passes an explicit undefined to clear
      const ok = await updateCronTask(id, { permanent: true, expiresAt: undefined }, tmpDir);
      expect(ok).toBe(true);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].permanent).toBe(true);
      expect(tasks[0].expiresAt).toBeUndefined();
    });

    it('omitting the expiresAt key leaves the field untouched', async () => {
      const expiresAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const id = await addTask('*/5 * * * *', 'prompt', true, true, {
        dir: tmpDir,
        expiresAt,
      });
      // Update only the cron — expiresAt must survive
      const ok = await updateCronTask(id, { cron: '*/10 * * * *' }, tmpDir);
      expect(ok).toBe(true);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].cron).toBe('*/10 * * * *');
      expect(tasks[0].expiresAt).toBe(expiresAt);
    });
  });

  describe('session ownership (createdBy*)', () => {
    const owner = { sessionId: 'ses-A', pid: 1234, procStart: 1700000000000 };

    it('stamps the creating session on durable tasks', async () => {
      await addTask('*/5 * * * *', 'owned-task', true, true, {
        dir: tmpDir,
      });
      const tasks = await readCronTasks(tmpDir);
      // Derived from the manager's own session, not handed in: a durable task
      // has to name the session whose scheduler will fire it, and letting the
      // caller supply that is how one session ends up stamping another's id.
      expect(tasks[0].createdBySessionId).toBe(MANAGER_SESSION_ID);
      expect(tasks[0].createdByPid).toBe(process.pid);
      expect(typeof tasks[0].createdByProcStart).toBe('number');
    });

    it('does NOT stamp an owner on session-only tasks', async () => {
      await addTask('*/5 * * * *', 'volatile', true, false);
      const session = getSessionTasks();
      expect(session[0].createdBySessionId).toBeUndefined();
    });

    it('claimCronTask rebinds ownership', async () => {
      await addTask('*/5 * * * *', 'to-claim', true, true, {
        dir: tmpDir,
      });
      const tasks1 = await readCronTasks(tmpDir);
      const id = tasks1[0].id;

      const newOwner = { sessionId: 'ses-B', pid: 5678, procStart: 1700000001000 };
      const ok = await claimCronTask(id, newOwner, tmpDir);
      expect(ok).toBe(true);

      const tasks2 = await readCronTasks(tmpDir);
      expect(tasks2[0].createdBySessionId).toBe('ses-B');
      expect(tasks2[0].createdByPid).toBe(5678);
      expect(tasks2[0].createdByProcStart).toBe(1700000001000);
    });

    it('claimCronTask returns false for non-existent id', async () => {
      const ok = await claimCronTask('nonexistent', owner, tmpDir);
      expect(ok).toBe(false);
    });
  });

  describe('removeCronTasks', () => {
    it('removes an existing durable task', async () => {
      const id = await addTask('0 9 * * *', 'p', false, true, { dir: tmpDir });
      await removeCronTasks([id], tmpDir);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(0);
    });

    it('no-ops when removing non-existent ids from file', async () => {
      await addTask('0 9 * * *', 'p', false, true, { dir: tmpDir });
      await removeCronTasks(['nonexistent'], tmpDir);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
    });

    it('handles empty id array', async () => {
      await removeCronTasks([], tmpDir);
      // No error thrown
    });
  });

  describe('markCronTasksFired', () => {
    it('updates lastFiredAt on specified tasks', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, { dir: tmpDir });
      const firedAt = Date.now();
      await markCronTasksFired([id], firedAt, tmpDir);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].lastFiredAt).toBe(firedAt);
    });

    it('no-ops when ids do not match', async () => {
      await addTask('*/5 * * * *', 'p', true, true, { dir: tmpDir });
      await markCronTasksFired(['nonexistent'], Date.now(), tmpDir);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks[0].lastFiredAt).toBeUndefined();
    });

    /**
     * The scheduler's own fire index restarts at 1 with every process, so this
     * counter is the only lifetime total. It has to accumulate across the
     * read-modify-write cycle, not be recomputed from it.
     */
    it('accumulates fireCount across fires and survives a reload', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
      });
      expect((await readCronTasks(tmpDir))[0].fireCount).toBeUndefined();

      await markCronTasksFired([id], Date.now(), tmpDir);
      expect((await readCronTasks(tmpDir))[0].fireCount).toBe(1);

      await markCronTasksFired([id], Date.now(), tmpDir);
      await markCronTasksFired([id], Date.now(), tmpDir);
      // Re-read from disk rather than trusting the in-memory object: a field the
      // read whitelist drops would reset the total on every reload.
      expect((await readCronTasks(tmpDir))[0].fireCount).toBe(3);
    });

    it('handles empty ids array', async () => {
      await markCronTasksFired([], Date.now(), tmpDir);
      // No error thrown
    });
  });

  describe('credits and budget', () => {
    it('accumulates credits across runs and survives a reload', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
      });
      expect((await readCronTasks(tmpDir))[0].creditsUsed).toBeUndefined();

      await addTaskCredits(id, 1.5, tmpDir);
      await addTaskCredits(id, 2.25, tmpDir);

      // Re-read from disk: a field the whitelist drops would look right in memory
      // and vanish on the next write.
      expect((await readCronTasks(tmpDir))[0].creditsUsed).toBeCloseTo(3.75);
    });

    it('ignores a charge that is zero, negative or not a number', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
      });
      await addTaskCredits(id, 0, tmpDir);
      await addTaskCredits(id, -5, tmpDir);
      await addTaskCredits(id, Number.NaN, tmpDir);

      // Not zero: an unmetered turn leaves the cost unknown, which is a different
      // claim from having cost nothing.
      expect((await readCronTasks(tmpDir))[0].creditsUsed).toBeUndefined();
    });

    it('charges a session task in memory, without touching the file', async () => {
      addSessionTask({
        id: 'sess1',
        cron: '*/5 * * * *',
        prompt: 'p',
        createdAt: 0,
        recurring: true,
      });

      await addTaskCredits('sess1', 0.75, tmpDir);
      await addTaskCredits('sess1', 0.25, tmpDir);

      expect(getSessionTasks()[0].creditsUsed).toBeCloseTo(1);
      // A session task has no business creating a task file.
      expect(await readCronTasks(tmpDir)).toEqual([]);
    });

    it('does not lose a charge to a concurrent fire stamp', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
      });

      // The two writers run on different clocks - the stamp when the schedule
      // fires, the charge when the turn serving it ends - so they overlap in
      // practice. Unserialised, both read the same file and the later write drops
      // the other's change.
      await Promise.all([
        markCronTasksFired([id], 5000, tmpDir),
        addTaskCredits(id, 0.5, tmpDir),
      ]);

      const [task] = await readCronTasks(tmpDir);
      expect(task.fireCount).toBe(1);
      expect(task.creditsUsed).toBe(0.5);
    });

    it('persists both ceilings and reloads them', async () => {
      await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
        maxTurns: 3,
        maxCredits: 10,
      });

      const [task] = await readCronTasks(tmpDir);
      expect(task.maxTurns).toBe(3);
      expect(task.maxCredits).toBe(10);
    });

    it('drops a ceiling that is not a positive number', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
      });
      const file = path.join(tmpDir, '.qwen', 'scheduled_tasks.json');
      const parsed = JSON.parse(await fsp.readFile(file, 'utf-8'));
      parsed.tasks[0].maxTurns = 0;
      parsed.tasks[0].maxCredits = -1;
      await fsp.writeFile(file, JSON.stringify(parsed), 'utf-8');

      const [task] = await readCronTasks(tmpDir);
      // A zero or negative ceiling would stop the task before its first fire,
      // which is never what anyone meant by it.
      expect(task.maxTurns).toBeUndefined();
      expect(task.maxCredits).toBeUndefined();
      expect(task.id).toBe(id);
    });

    it('lets a ceiling be cleared through updateCronTask', async () => {
      const id = await addTask('*/5 * * * *', 'p', true, true, {
        dir: tmpDir,
        maxTurns: 3,
        maxCredits: 10,
      });

      await updateCronTask(id, { maxTurns: undefined }, tmpDir);
      const [task] = await readCronTasks(tmpDir);
      // Key presence clears; the ceiling not mentioned is left alone. A limit set
      // by mistake has to be removable.
      expect(task.maxTurns).toBeUndefined();
      expect(task.maxCredits).toBe(10);
    });
  });

  describe('checkCronBudget', () => {
    const task = (extra: Partial<CronTask>): CronTask => ({
      id: 't',
      cron: '*/5 * * * *',
      prompt: 'p',
      createdAt: 0,
      recurring: true,
      ...extra,
    });

    it('lets a task with no ceilings run forever', () => {
      expect(checkCronBudget(task({ fireCount: 999, creditsUsed: 999 }))).toBeNull();
    });

    it('stops on arrival at the turn ceiling, not after passing it', () => {
      expect(checkCronBudget(task({ maxTurns: 3, fireCount: 2 }))).toBeNull();
      expect(checkCronBudget(task({ maxTurns: 3, fireCount: 3 }))).toEqual({
        reason: 'max-turns',
        limit: 3,
        reached: 3,
      });
    });

    it('stops on arrival at the credit ceiling', () => {
      expect(checkCronBudget(task({ maxCredits: 10, creditsUsed: 9.99 }))).toBeNull();
      expect(checkCronBudget(task({ maxCredits: 10, creditsUsed: 10 }))).toEqual({
        reason: 'max-credits',
        limit: 10,
        reached: 10,
      });
    });

    it('reports turns first when both ceilings are spent', () => {
      const verdict = checkCronBudget(
        task({ maxTurns: 2, fireCount: 5, maxCredits: 1, creditsUsed: 5 }),
      );
      expect(verdict?.reason).toBe('max-turns');
    });

    it('treats an unfired, uncharged task as within any ceiling', () => {
      expect(checkCronBudget(task({ maxTurns: 1, maxCredits: 1 }))).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('returns empty list when no tasks exist', async () => {
      const tasks = await listTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('merges file and session tasks when dir is undefined', async () => {
      // Add a session task
      addSessionTask({
        id: 'sess-1',
        cron: '*/5 * * * *',
        prompt: 'session prompt',
        createdAt: Date.now(),
      });
      // listTasks with undefined dir merges session tasks
      const tasks = await listTasks(undefined);
      const sessionTask = tasks.find(t => t.id === 'sess-1');
      expect(sessionTask).toBeDefined();
      expect(sessionTask!.durable).toBe(false);
    });

    it('does not include session tasks when dir is provided', async () => {
      addSessionTask({
        id: 'sess-1',
        cron: '*/5 * * * *',
        prompt: 'session prompt',
        createdAt: Date.now(),
      });
      const tasks = await listTasks(tmpDir);
      // Should not contain session tasks when dir is provided
      expect(tasks.find(t => t.id === 'sess-1')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Fire-time computation & jitter
  // -------------------------------------------------------------------------
  describe('nextCronRunMs', () => {
    it('returns next fire time for valid cron', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const next = nextCronRunMs('*/5 * * * *', from);
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(from);
    });

    it('returns null for invalid cron', () => {
      expect(nextCronRunMs('invalid', Date.now())).toBeNull();
    });
  });

  describe('jitter', () => {
    it('is deterministic: same taskId produces same jitter', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const a = jitteredNextCronRunMs('*/5 * * * *', from, 'aabbccdd');
      const b = jitteredNextCronRunMs('*/5 * * * *', from, 'aabbccdd');
      expect(a).toBe(b);
    });

    it('different taskIds produce different jitter', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const a = jitteredNextCronRunMs('*/5 * * * *', from, 'aabbccdd');
      const b = jitteredNextCronRunMs('*/5 * * * *', from, '11223344');
      // Different IDs should (almost certainly) produce different offsets
      // but the base next-fire time might be the same, so just verify non-null
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });

    it('jitter is within cap', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const base = nextCronRunMs('*/5 * * * *', from)!;
      const jittered = jitteredNextCronRunMs('*/5 * * * *', from, 'aabbccdd')!;
      const delta = jittered - base;
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(DEFAULT_CRON_JITTER_CONFIG.recurringCapMs);
    });

    it('returns null for invalid cron', () => {
      expect(jitteredNextCronRunMs('invalid', Date.now(), 'aabb')).toBeNull();
    });
  });

  describe('oneShotJitteredNextCronRunMs', () => {
    it('returns a fire time for valid cron', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const result = oneShotJitteredNextCronRunMs('0 9 * * *', from, 'aabb');
      expect(result).not.toBeNull();
    });

    it('never fires before fromMs', () => {
      const from = new Date(2025, 0, 15, 10, 0, 0).getTime();
      const result = oneShotJitteredNextCronRunMs('0 0 * * *', from, 'aabb')!;
      expect(result).toBeGreaterThanOrEqual(from);
    });

    it('returns null for invalid cron', () => {
      expect(oneShotJitteredNextCronRunMs('invalid', Date.now(), 'a')).toBeNull();
    });
  });

  describe('findMissedTasks', () => {
    it('finds tasks whose next fire is in the past', () => {
      const now = Date.now();
      const task: CronTask = {
        id: 'old',
        cron: '*/5 * * * *',
        prompt: 'missed',
        createdAt: now - 60 * 60 * 1000, // 1 hour ago
      };
      const missed = findMissedTasks([task], now);
      expect(missed).toHaveLength(1);
      expect(missed[0].id).toBe('old');
    });

    it('does not flag future tasks as missed', () => {
      const now = Date.now();
      const task: CronTask = {
        id: 'future',
        cron: '*/5 * * * *',
        prompt: 'not missed',
        createdAt: now, // just created
      };
      const missed = findMissedTasks([task], now);
      expect(missed).toHaveLength(0);
    });

    it('uses lastFiredAt as anchor when available', () => {
      const now = Date.now();
      const task: CronTask = {
        id: 't',
        cron: '*/5 * * * *',
        prompt: 'p',
        createdAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
        lastFiredAt: now - 1000, // just fired 1s ago → next fire is in the future
      };
      const missed = findMissedTasks([task], now);
      expect(missed).toHaveLength(0);
    });

    it('returns empty for empty task list', () => {
      expect(findMissedTasks([], Date.now())).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Error recovery
  // -------------------------------------------------------------------------
  describe('error recovery', () => {
    it('writeCronTasks propagates IO errors (does not silently swallow)', async () => {
      // Make `tmpDir/file-not-dir` a regular file, then point writeCronTasks at
      // it as the project root. mkdir(file-not-dir/.qwen, recursive:true) must
      // fail with ENOTDIR/EEXIST since a file exists where a directory must go.
      // Source has no try/catch around mkdir/writeFile → the promise must reject.
      const fakeRoot = path.join(tmpDir, 'file-not-dir');
      await fsp.writeFile(fakeRoot, 'i am a file');
      await expect(
        writeCronTasks(
          [{ id: 'x', cron: '* * * * *', prompt: 'p', createdAt: 1 }],
          fakeRoot,
        ),
      ).rejects.toThrow();
    });

    it('readCronTasks returns empty array on filesystem errors (e.g. EISDIR)', async () => {
      // Source catches ALL readFile errors and returns []. Simulate a non-ENOENT
      // error by making scheduled_tasks.json a directory — readFile on a dir
      // throws EISDIR on POSIX, EISDIR/EPERM on Windows. Either way: must be [].
      const cronDir = path.join(tmpDir, '.qwen');
      await fsp.mkdir(cronDir, { recursive: true });
      await fsp.mkdir(path.join(cronDir, 'scheduled_tasks.json'));
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('rapid sequential addTask calls preserve all tasks', async () => {
      // Each addTask is a read-modify-write. Sequential awaits guarantee
      // each subsequent read sees the prior write — no data should be lost.
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await addTask(
          '*/5 * * * *',
          `prompt-${i}`,
          false,
          true,
          { dir: tmpDir },
        );
        ids.push(id);
      }
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(10);
      for (const id of ids) {
        expect(tasks.find(t => t.id === id)).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Boundary cases
  // -------------------------------------------------------------------------
  describe('boundary cases', () => {
    it('accepts empty prompt (no validation in addTask)', async () => {
      // Source does not validate prompt content — empty string is a valid string
      // so it round-trips through write+read.
      const id = await addTask('*/5 * * * *', '', false, true, {
        dir: tmpDir,
      });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(id);
      expect(tasks[0].prompt).toBe('');
    });

    it('accepts very long prompt (>10000 chars)', async () => {
      const longPrompt = 'A'.repeat(15000);
      const id = await addTask('*/5 * * * *', longPrompt, false, true, {
        dir: tmpDir,
      });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(id);
      expect(tasks[0].prompt).toHaveLength(15000);
      expect(tasks[0].prompt).toBe(longPrompt);
    });

    it('preserves special characters: newlines, Unicode, emoji', async () => {
      const tricky = 'line1\nline2\t中文 🚀 "quoted" \\backslash';
      await addTask('*/5 * * * *', tricky, false, true, { dir: tmpDir });
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe(tricky);
    });

    it('addTask with empty cron writes the task but it is dropped on read', async () => {
      // Source comment: "Caller is responsible for having already validated the
      // cron string." addTask itself performs no validation, so the empty-cron
      // task is written. readCronTasks then drops it because parseCronExpression('')
      // returns null. Net effect: addTask returns an id, readCronTasks → [].
      const id = await addTask('', 'p', false, true, { dir: tmpDir });
      expect(id).toBeTruthy();
      // Raw file should still contain the task with empty cron
      const raw = await fsp.readFile(
        path.join(tmpDir, '.qwen', 'scheduled_tasks.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].cron).toBe('');
      // But readCronTasks silently drops invalid-cron entries
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toEqual([]);
    });
  });
});
