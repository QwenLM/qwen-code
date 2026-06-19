/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateAccountKey } from './accountKeyStore.js';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'acme-acct-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('loadOrCreateAccountKey', () => {
  it('generates and persists the account key 0600 when absent', async () => {
    const generate = vi.fn(async () => 'KEY-PEM');
    const key = await loadOrCreateAccountKey(base, generate);
    expect(key).toBe('KEY-PEM');
    expect(generate).toHaveBeenCalledTimes(1);
    const path = join(base, 'account.key');
    expect(await readFile(path, 'utf8')).toBe('KEY-PEM');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('reuses an existing account key without regenerating', async () => {
    await loadOrCreateAccountKey(base, async () => 'FIRST');
    const generate = vi.fn(async () => 'SECOND');
    const key = await loadOrCreateAccountKey(base, generate);
    expect(key).toBe('FIRST');
    expect(generate).not.toHaveBeenCalled();
  });
});
