/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../config/storage.js';
import {
  checkA2AGrant,
  issueA2AGrant,
  listA2AGrants,
  revokeA2AGrant,
} from './a2a-grants.js';
import { getWorkspaceFilePath } from './store.js';

const PROJECT_ROOT = '/a2a-grants-test';
const T0 = 1_000_000;

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-grants-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

const issue = (scope: 'analysis' | 'full', expiresAt?: number) =>
  issueA2AGrant(
    PROJECT_ROOT,
    {
      callerId: 'share_1',
      agentId: 'ag_lead',
      scope,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    T0,
  );

describe('A2A grants', () => {
  it('keeps only a hash of the secret on disk and never lists it', async () => {
    const { secret } = await issue('analysis');
    const onDisk = await fs.readFile(
      getWorkspaceFilePath(PROJECT_ROOT),
      'utf8',
    );

    expect(secret.length).toBeGreaterThan(30);
    expect(onDisk).not.toContain(secret);
    const listed = await listA2AGrants(PROJECT_ROOT);
    expect(listed).toEqual([
      expect.objectContaining({ callerId: 'share_1', agentId: 'ag_lead' }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('secretHash');
  });

  it('checks the secret, the agent, the expiry and the scope', async () => {
    const { secret } = await issue('analysis', T0 + 1000);
    const check = (
      overrides: Partial<{ secret: string; agentId: string }>,
      required: 'analysis' | 'full' = 'analysis',
      now = T0,
    ) =>
      checkA2AGrant(
        PROJECT_ROOT,
        {
          callerId: 'share_1',
          agentId: 'ag_lead',
          secret,
          required,
          ...overrides,
        },
        now,
      );

    await expect(check({})).resolves.toMatchObject({ ok: true });
    await expect(check({ secret: `${secret}x` })).resolves.toEqual({
      ok: false,
      reason: 'bad_secret',
    });
    await expect(check({ agentId: 'ag_other' })).resolves.toEqual({
      ok: false,
      reason: 'no_grant',
    });
    await expect(check({}, 'full')).resolves.toEqual({
      ok: false,
      reason: 'out_of_scope',
    });
    await expect(check({}, 'analysis', T0 + 1000)).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('lets a full grant cover analysis, and stops working once revoked', async () => {
    const { secret } = await issue('full');
    const input = {
      callerId: 'share_1',
      agentId: 'ag_lead',
      secret,
      required: 'analysis' as const,
    };

    await expect(checkA2AGrant(PROJECT_ROOT, input, T0)).resolves.toMatchObject(
      { ok: true },
    );
    await expect(
      revokeA2AGrant(PROJECT_ROOT, { callerId: 'share_1', agentId: 'ag_lead' }),
    ).resolves.toBe(true);
    await expect(checkA2AGrant(PROJECT_ROOT, input, T0)).resolves.toEqual({
      ok: false,
      reason: 'no_grant',
    });
  });
});
