/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from './auditLog.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-audit-'));
}

describe('AuditLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('appends a stamped JSON line per record call', async () => {
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1234);
    await audit.record({
      action: 'token_minted',
      actorTokenId: 'a',
      target: 'b',
    });
    await audit.record({
      action: 'token_revoked',
      actorTokenId: 'a',
      target: 'b',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      ts: 1234,
      action: 'token_minted',
      actorTokenId: 'a',
      target: 'b',
    });
    expect(JSON.parse(lines[1]).action).toBe('token_revoked');
  });

  it('creates the file with 0600 permissions', async () => {
    const path = join(dir, 'nested', 'audit.log');
    const audit = new AuditLog(path);
    await audit.record({ action: 'auth_failed' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never throws when the path is unwritable', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const path = join(blocker, 'audit.log');
    const audit = new AuditLog(path);
    await expect(
      audit.record({ action: 'token_minted' }),
    ).resolves.toBeUndefined();
  });
});
