/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SESSION_PR_LIST_LIMIT,
  readSessionPrs,
  upsertSessionPr,
  writeSessionPrs,
  type SessionPr,
} from './session-pr-service.js';

const entry = (number: number): SessionPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  createdAt: '2026-08-20T00:00:00.000Z',
});

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-pr-test-'));
  filePath = path.join(tmpDir, 'test.pr.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('writeSessionPrs / readSessionPrs', () => {
  it('round-trips a PR list', async () => {
    const prs = [entry(9517), entry(9519)];
    await writeSessionPrs(filePath, prs);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('creates missing parent directories on write', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'test.pr.json');
    await writeSessionPrs(nested, [entry(1)]);
    expect(await readSessionPrs(nested)).toEqual([entry(1)]);
  });
});

describe('readSessionPrs', () => {
  it('returns null when the file does not exist', async () => {
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it.each([
    ['bare object (legacy single shape)', entry(1)],
    ['empty list', { prs: [] }],
    ['entry missing url', { prs: [{ number: 1, createdAt: 'x' }] }],
    ['entry non-integer number', { prs: [{ ...entry(1), number: 1.5 }] }],
    ['entry non-positive number', { prs: [entry(0)] }],
    [
      'entry non-http url',
      { prs: [{ ...entry(1), url: 'javascript:alert(1)' }] },
    ],
    ['entry missing createdAt', { prs: [{ number: 1, url: entry(1).url }] }],
  ])('returns null for a malformed sidecar: %s', async (_label, value) => {
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('pr sidecar read cancelled');
    controller.abort(reason);

    await expect(
      readSessionPrs(filePath, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe('upsertSessionPr', () => {
  it('appends bindings in binding order', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    const prs = await upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    expect(prs.map((p) => p.number)).toEqual([100, 101]);
  });

  it('re-binding the same number refreshes it and moves it to latest', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    await upsertSessionPr(filePath, { number: 101, url: entry(101).url });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/owner/repo/pull/100?updated=1',
    });
    expect(prs.map((p) => p.number)).toEqual([101, 100]);
    expect(prs[1]?.url).toContain('updated=1');
  });

  it('caps the list at SESSION_PR_LIST_LIMIT, dropping the oldest', async () => {
    for (let i = 1; i <= SESSION_PR_LIST_LIMIT + 2; i++) {
      await upsertSessionPr(filePath, {
        number: i,
        url: `https://github.com/owner/repo/pull/${i}`,
      });
    }
    const prs = await readSessionPrs(filePath);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.[0]?.number).toBe(3);
    expect(prs?.[SESSION_PR_LIST_LIMIT - 1]?.number).toBe(
      SESSION_PR_LIST_LIMIT + 2,
    );
  });
});
