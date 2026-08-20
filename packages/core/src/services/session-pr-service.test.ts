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
  readSessionPr,
  writeSessionPr,
  type SessionPr,
} from './session-pr-service.js';

const sample: SessionPr = {
  number: 9517,
  url: 'https://github.com/owner/repo/pull/9517',
  createdAt: '2026-08-20T00:00:00.000Z',
};

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-pr-test-'));
  filePath = path.join(tmpDir, 'test.pr.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('writeSessionPr / readSessionPr', () => {
  it('round-trips a PR binding', async () => {
    await writeSessionPr(filePath, sample);
    expect(await readSessionPr(filePath)).toEqual(sample);
  });

  it('creates missing parent directories on write', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'test.pr.json');
    await writeSessionPr(nested, sample);
    expect(await readSessionPr(nested)).toEqual(sample);
  });
});

describe('readSessionPr', () => {
  it('returns null when the file does not exist', async () => {
    expect(await readSessionPr(filePath)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    expect(await readSessionPr(filePath)).toBeNull();
  });

  it.each([
    ['missing url', { number: 1, createdAt: sample.createdAt }],
    ['missing number', { url: sample.url, createdAt: sample.createdAt }],
    ['non-integer number', { ...sample, number: 1.5 }],
    ['non-positive number', { ...sample, number: 0 }],
    ['non-string url', { ...sample, url: 42 }],
    ['non-http url', { ...sample, url: 'javascript:alert(1)' }],
    ['missing createdAt', { number: 1, url: sample.url }],
  ])('returns null for a malformed sidecar: %s', async (_label, value) => {
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
    expect(await readSessionPr(filePath)).toBeNull();
  });

  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('pr sidecar read cancelled');
    controller.abort(reason);

    await expect(
      readSessionPr(filePath, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});
