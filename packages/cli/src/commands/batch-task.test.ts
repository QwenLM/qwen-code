/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    for (const id of ['has space', '-leading-dash', 'a'.repeat(65), '']) {
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

  it('leaves no half-written task file when interrupted mid-save', () => {
    const plan = validatePlan(validPlan, 'plan.json');
    const task = store.create(plan, root, 'qwen-plus');
    // Simulate a crashed writer: a stale tmp file must not corrupt the load.
    fs.writeFileSync(`${store.fileOf(task.id)}.tmp`, '{"truncated');
    expect(store.load(task.id).id).toBe(task.id);
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
});

describe('batchHomeDir', () => {
  it('defaults to .qwen/batch under the cwd and honors the env override', () => {
    expect(batchHomeDir('/proj', {})).toBe(
      path.join('/proj', '.qwen', 'batch'),
    );
    expect(batchHomeDir('/proj', { QWEN_BATCH_HOME: '/elsewhere' })).toBe(
      '/elsewhere',
    );
  });
});
