/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  BatchTaskStore,
  batchHomeDir,
  customIdOf,
  parseCustomId,
  refreshTaskStatus,
  validatePlan,
  type BatchTask,
} from './batch-task.js';

const validPlan = {
  version: 1 as const,
  name: 'translate-docs',
  kind: 'document-transform' as const,
  shared: { instructions: 'Translate to English. Return only the document.' },
  items: [
    { id: 'intro', source: 'docs/zh/intro.md', target: 'docs/en/intro.md' },
    { id: 'guide', source: 'docs/zh/guide.md', target: 'docs/en/guide.md' },
  ],
};

describe('validatePlan', () => {
  it('refuses targets outside the project or inside any hidden path', () => {
    for (const target of [
      'packages/app/.qwen/settings.json',
      'vendor/x/.git/hooks/pre-commit',
      '../en/intro.md',
      '/tmp/intro.md',
      'docs/en/../../../etc/passwd',
    ]) {
      expect(() =>
        validatePlan(
          { ...validPlan, items: [{ ...validPlan.items[0], target }] },
          'plan.json',
        ),
      ).toThrow(/outside the project|not allowed for batch delivery/);
    }
    expect(() =>
      validatePlan(
        {
          ...validPlan,
          items: [{ ...validPlan.items[0], target: 'docs/en/./intro.md' }],
        },
        'plan.json',
      ),
    ).not.toThrow();
  });

  it('refuses targets inside tool configuration directories', () => {
    for (const target of [
      '.github/workflows/x.yml',
      './.git/hooks/pre-commit',
      '.Qwen/settings.json',
    ]) {
      expect(() =>
        validatePlan(
          { ...validPlan, items: [{ ...validPlan.items[0], target }] },
          'plan.json',
        ),
      ).toThrow(/not allowed for batch delivery/);
    }
  });

  it('accepts a valid plan and defaults nothing away', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    expect(plan.items).toHaveLength(2);
    expect(plan.completionWindow).toBeUndefined();
  });

  it('rejects duplicate item ids', () => {
    expect(() =>
      validatePlan(
        {
          ...validPlan,
          items: [validPlan.items[0], { ...validPlan.items[1], id: 'intro' }],
        },
        'plan.json',
      ),
    ).toThrow(/duplicate item id/);
  });

  it('rejects two items writing the same target', () => {
    expect(() =>
      validatePlan(
        {
          ...validPlan,
          items: [
            validPlan.items[0],
            { ...validPlan.items[1], target: 'docs/en/intro.md' },
          ],
        },
        'plan.json',
      ),
    ).toThrow(/both write/);
  });

  it('rejects item ids that cannot ride inside a provider custom_id', () => {
    for (const id of ['has space', '-leading-dash', 'a'.repeat(61), '']) {
      expect(() =>
        validatePlan(
          { ...validPlan, items: [{ ...validPlan.items[0], id }] },
          'plan.json',
        ),
      ).toThrow(/custom_id|invalid batch plan/);
    }
  });

  it('rejects unknown fields so agent typos cannot silently pass', () => {
    expect(() =>
      validatePlan({ ...validPlan, model: 'qwen-plus' }, 'plan.json'),
    ).toThrow(/invalid batch plan/);
  });

  it('rejects an empty item list', () => {
    expect(() =>
      validatePlan({ ...validPlan, items: [] }, 'plan.json'),
    ).toThrow(/no items|invalid batch plan/);
  });
});

describe('custom_id mapping', () => {
  it('round-trips item id and attempt', () => {
    expect(parseCustomId(customIdOf('intro', 3))).toEqual({
      itemId: 'intro',
      attempt: 3,
    });
  });

  it('rejects ids without an attempt suffix', () => {
    expect(parseCustomId('intro')).toBeUndefined();
    expect(parseCustomId('#')).toBeUndefined();
  });
});

describe('BatchTaskStore', () => {
  let root: string;
  let store: BatchTaskStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-task-'));
    store = new BatchTaskStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates, saves, and reloads a task', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const task = store.create(plan, root, 'qwen-plus');
    expect(task.id).toMatch(/^translate-docs-\d{14}$/);
    const loaded = store.load(task.id);
    expect(loaded.model).toBe('qwen-plus');
    expect(loaded.items.map((item) => item.state)).toEqual([
      'pending',
      'pending',
    ]);
    expect(loaded.attempts).toEqual([]);
  });

  it('gives two tasks of one plan created in the same second distinct ids', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const first = store.create(plan, root, 'qwen-plus');
    const second = store.create(plan, root, 'qwen-plus');
    expect(second.id).not.toBe(first.id);
    expect(store.load(first.id).id).toBe(first.id);
  });

  it('re-reads a task record only when it changed, given a cache', () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const cache = new Map();
    const first = store.list(cache)[0];
    expect(store.list(cache)[0]).toBe(first);
    task.status = 'running';
    store.save(task);
    expect(store.list(cache)[0].status).toBe('running');
  });

  it('refuses to load a task from a future schema version', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const task = store.create(plan, root, 'qwen-plus');
    const raw = JSON.parse(fs.readFileSync(store.fileOf(task.id), 'utf8'));
    raw.schemaVersion = 99;
    fs.writeFileSync(store.fileOf(task.id), JSON.stringify(raw));
    expect(() => store.load(task.id)).toThrow(/schema version/);
  });

  it('refuses task ids that would walk out of the store', () => {
    expect(() => store.load('../escape')).toThrow(/invalid task id/);
  });

  it('writes through a temp file and leaves only task.json behind', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const task = store.create(plan, root, 'qwen-plus');
    task.items[0].state = 'failed';
    store.save(task);
    expect(fs.readdirSync(path.dirname(store.fileOf(task.id)))).toEqual([
      'task.json',
    ]);
    expect(store.load(task.id).items[0].state).toBe('failed');
  });

  it('keeps task records private to the user', () => {
    if (process.platform === 'win32') return; // POSIX modes only
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const dir = path.dirname(store.fileOf(task.id));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.fileOf(task.id)).mode & 0o777).toBe(0o600);
  });

  it('keeps the ledger out of git', () => {
    store.create(validatePlan(validPlan, 'plan.json'), root, 'qwen-plus');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('treats a lock it cannot read as held instead of spinning', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    // A directory where the lock file should be: it exists, but reading it
    // fails, which used to loop without ever reaching the wait deadline.
    fs.mkdirSync(path.join(path.dirname(store.fileOf(task.id)), 'lock'));
    await expect(
      store.withLock(task.id, async () => 'ran', { waitMs: 0 }),
    ).rejects.toThrow(/in use by another/);
  });

  it('refuses a second holder of the task lock and releases it after', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    await store.withLock(task.id, async () => {
      await expect(
        store.withLock(task.id, async () => undefined),
      ).rejects.toThrow(/in use by another/);
    });
    await expect(store.withLock(task.id, async () => 'ok')).resolves.toBe('ok');
  });

  it('treats a lock whose content is not written yet as held', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const lock = path.join(path.dirname(store.fileOf(task.id)), 'lock');
    // The file exists before its content does; a reader in that gap must
    // not mistake it for a dead holder and steal it.
    fs.writeFileSync(lock, '');
    await expect(store.withLock(task.id, async () => 'ok')).rejects.toThrow(
      /in use by another/,
    );
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('never removes a lock that is no longer its own', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const lock = path.join(path.dirname(store.fileOf(task.id)), 'lock');
    await store.withLock(task.id, async () => {
      // Someone took over (e.g. after a stale check) while we worked.
      fs.writeFileSync(lock, `${process.pid}\nother\nsuccessor\n`);
    });
    expect(fs.readFileSync(lock, 'utf8')).toContain('successor');
  });

  it('waits for a held lock when asked to', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const lock = path.join(path.dirname(store.fileOf(task.id)), 'lock');
    fs.writeFileSync(lock, `${process.pid}\n${os.hostname()}\nholder\n`);
    setTimeout(() => fs.rmSync(lock, { force: true }), 300);
    await expect(
      store.withLock(task.id, async () => 'ok', { waitMs: 5_000 }),
    ).resolves.toBe('ok');
  });

  it('never takes over a lock written on another host', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const lock = path.join(path.dirname(store.fileOf(task.id)), 'lock');
    // Its pid cannot be checked from here, dead-looking or not.
    fs.writeFileSync(lock, '2147483646\nsome-other-host\n');
    await expect(store.withLock(task.id, async () => 'ok')).rejects.toThrow(
      /on some-other-host.*delete/,
    );
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('takes over a lock left by a process that no longer exists', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const lock = path.join(path.dirname(store.fileOf(task.id)), 'lock');
    // Far above any real pid limit, so it cannot name a live process.
    fs.writeFileSync(lock, '2147483646');
    await expect(store.withLock(task.id, async () => 'ok')).resolves.toBe('ok');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not remove a successor acquired after its stale-lock read', async () => {
    const task = store.create(
      validatePlan(validPlan, 'plan.json'),
      root,
      'qwen-plus',
    );
    const dir = path.dirname(store.fileOf(task.id));
    const lock = path.join(dir, 'lock');
    fs.writeFileSync(lock, `2147483646\n${os.hostname()}\nstale\n`);
    const read = fs.readFileSync;
    let successor: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let intercepted = false;
    const entered = vi.fn();
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const content = read(...args);
      if (args[0] === lock && !intercepted) {
        intercepted = true;
        successor = store.withLock(task.id, async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
      }
      return content;
    });
    try {
      await expect(
        store.withLock(task.id, async () => {
          entered();
        }),
      ).rejects.toThrow(/in use by another/);
      expect(release).toBeDefined();
      expect(entered).not.toHaveBeenCalled();
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      spy.mockRestore();
      release?.();
      await successor;
    }
    expect(fs.readdirSync(dir)).toEqual(['task.json']);
  });

  it('lists tasks newest first and skips unreadable ones', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const older = store.create(plan, root, 'qwen-plus');
    const newer = store.create({ ...plan, name: 'other' }, root, 'qwen-plus');
    // createdAt resolution is milliseconds; set it explicitly so the sort
    // key — not the id, not filesystem order — decides the assertion.
    const olderRaw = JSON.parse(
      fs.readFileSync(store.fileOf(older.id), 'utf8'),
    ) as { createdAt: string };
    olderRaw.createdAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(store.fileOf(older.id), JSON.stringify(olderRaw));
    fs.mkdirSync(path.join(root, 'tasks', 'broken'), { recursive: true });
    const ids = store.list().map((task) => task.id);
    expect(ids).toEqual([newer.id, older.id]);
  });
});

describe('refreshTaskStatus', () => {
  const baseTask = (): BatchTask => ({
    schemaVersion: 1,
    id: 't',
    name: 't',
    kind: 'document-transform',
    status: 'prepared',
    createdAt: '',
    updatedAt: '',
    projectRoot: '/tmp',
    model: 'm',
    completionWindow: '24h',
    plan: validatePlan(validPlan, 'plan.json'),
    items: [
      { id: 'intro', source: 'a', target: 'b', state: 'pending' },
      { id: 'guide', source: 'c', target: 'd', state: 'pending' },
    ],
    attempts: [],
  });

  it('marks done only when every item is delivered', () => {
    const task = baseTask();
    task.items[0].state = 'delivered';
    task.attempts.push({
      attempt: 1,
      itemIds: ['intro'],
      submitState: 'created',
    });
    refreshTaskStatus(task);
    expect(task.status).toBe('partial');
    task.items[1].state = 'delivered';
    refreshTaskStatus(task);
    expect(task.status).toBe('done');
  });

  it('surfaces an ambiguous submission over a created one', () => {
    const task = baseTask();
    task.attempts.push({
      attempt: 1,
      itemIds: ['intro'],
      submitState: 'unknown',
    });
    refreshTaskStatus(task);
    expect(task.status).toBe('submit-unknown');
  });

  it('surfaces an ambiguous submission over partial progress', () => {
    // A retry whose create answer was lost starts from failed/delivered
    // item states; the list must still say reconcile-first, not "partial".
    const task = baseTask();
    task.items[0].state = 'failed';
    task.attempts.push({
      attempt: 1,
      itemIds: ['intro'],
      submitState: 'created',
    });
    task.attempts.push({
      attempt: 2,
      itemIds: ['intro'],
      submitState: 'unknown',
    });
    refreshTaskStatus(task);
    expect(task.status).toBe('submit-unknown');
  });

  it('treats an attempt stuck in uploaded as ambiguous too', () => {
    // A process that died with the create request in flight leaves the
    // attempt `uploaded`; the batch may exist, so it must be reconciled.
    const task = baseTask();
    task.attempts.push({
      attempt: 1,
      itemIds: ['intro'],
      submitState: 'uploaded',
      inputFileId: 'file-1',
    });
    refreshTaskStatus(task);
    expect(task.status).toBe('submit-unknown');
  });
});

describe('batchHomeDir', () => {
  it('lives in the user qwen home, not the project, and honors the override', () => {
    expect(batchHomeDir({})).toBe(
      path.join(Storage.getGlobalQwenDir(), 'batch'),
    );
    expect(batchHomeDir({ QWEN_BATCH_HOME: '/elsewhere' })).toBe('/elsewhere');
  });

  it('treats an empty override as unset, not as the current directory', () => {
    // `QWEN_BATCH_HOME=` in an env file is an empty string, not a path. Taken
    // literally it put the task store in the project root, where its
    // `.gitignore` of `*` hid the user's own files from a commit.
    const dflt = batchHomeDir({});
    expect(batchHomeDir({ QWEN_BATCH_HOME: '' })).toBe(dflt);
    expect(batchHomeDir({ QWEN_BATCH_HOME: '   ' })).toBe(dflt);
    expect(path.isAbsolute(batchHomeDir({ QWEN_BATCH_HOME: '' }))).toBe(true);
  });
});
