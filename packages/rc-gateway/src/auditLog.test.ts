/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

  it('rotates when the live file exceeds maxBytes and stays queryable', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    const audit = new AuditLog(path, () => ++t, { maxBytes: 10, maxFiles: 2 });
    await audit.record({ action: 'token_minted', target: 'a' });
    await audit.record({ action: 'token_minted', target: 'b' });
    await audit.record({ action: 'token_minted', target: 'c' });
    expect(existsSync(`${path}.1`)).toBe(true);
    const rows = await audit.query({});
    expect(rows.map((r) => r.target)).toEqual(['c', 'b', 'a']);
  });

  it('keeps at most maxFiles archives (drops the oldest)', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    const audit = new AuditLog(path, () => ++t, { maxBytes: 10, maxFiles: 1 });
    for (const x of ['a', 'b', 'c', 'd']) {
      await audit.record({ action: 'token_minted', target: x });
    }
    expect(existsSync(`${path}.2`)).toBe(false);
    const rows = await audit.query({});
    expect(rows.map((r) => r.target)).toEqual(['d', 'c']);
  });

  it('filters by action / actor / since and caps limit', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    const audit = new AuditLog(path, () => ++t);
    await audit.record({
      action: 'token_minted',
      actorTokenId: 'o',
      target: '1',
    });
    await audit.record({ action: 'auth_failed' });
    await audit.record({
      action: 'token_minted',
      actorTokenId: 'p',
      target: '2',
    });
    expect(
      (await audit.query({ action: 'token_minted' })).map((r) => r.target),
    ).toEqual(['2', '1']);
    expect((await audit.query({ actor: 'o' })).map((r) => r.target)).toEqual([
      '1',
    ]);
    expect((await audit.query({ since: 3 })).map((r) => r.action)).toEqual([
      'token_minted',
    ]);
    expect(await audit.query({ limit: 1 })).toHaveLength(1);
  });

  it('shareId filter unions top-level shareId, actorTokenId, and detail.shareId', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    const audit = new AuditLog(path, () => ++t);
    // top-level shareId (a future guest row)
    await audit.record({
      action: 'session_attached',
      shareId: 'sh1',
      target: 's',
    });
    // actorTokenId == share id (a historical guest row, no top-level shareId)
    await audit.record({ action: 'permission_voted', actorTokenId: 'sh1' });
    // detail.shareId (a historical owner-side create row)
    await audit.record({
      action: 'share_created',
      actorTokenId: 'owner',
      detail: { shareId: 'sh1' },
    });
    // unrelated rows: another share, and a non-string detail.shareId
    await audit.record({ action: 'session_attached', shareId: 'sh2' });
    await audit.record({ action: 'token_minted', detail: { shareId: 12345 } });

    const rows = await audit.query({ shareId: 'sh1' });
    expect(rows.map((r) => r.action).sort()).toEqual([
      'permission_voted',
      'session_attached',
      'share_created',
    ]);
    // a numeric detail.shareId never matches (typeof guard)
    expect(await audit.query({ shareId: '12345' })).toEqual([]);
  });

  it('skips corrupt lines and returns [] for a missing log', async () => {
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1);
    expect(await audit.query({})).toEqual([]);
    await audit.record({ action: 'token_minted', target: 'a' });
    appendFileSync(path, 'not json\n');
    const rows = await audit.query({});
    expect(rows.map((r) => r.target)).toEqual(['a']);
  });

  it('does not lose records when concurrent writes trigger rotation', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    // Tiny cap → every write after the first rotates; large maxFiles → keep all.
    const audit = new AuditLog(path, () => ++t, { maxBytes: 10, maxFiles: 20 });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.record({ action: 'token_minted', target: String(i) }),
      ),
    );
    const rows = await audit.query({ limit: 100 });
    // Without serialized writes, interleaved rotation clobbers archives and
    // some of the 10 entries are lost. With the write mutex, all 10 survive.
    expect(new Set(rows.map((r) => r.target)).size).toBe(10);
  });
});

describe('AuditLog onRecord sink (cycle 49)', () => {
  it('fires onRecord once per durably-appended record, with the stamped ts', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const seen: Array<{ ts: number; action: string }> = [];
    const audit = new AuditLog(path, () => 4242, {
      onRecord: (r) => seen.push({ ts: r.ts, action: r.action }),
    });
    await audit.record({ action: 'token_minted', actorTokenId: 'a' });
    await audit.record({ action: 'token_revoked', actorTokenId: 'a' });
    // The sink saw both records, in order, stamped with the same ts as on disk.
    expect(seen).toEqual([
      { ts: 4242, action: 'token_minted' },
      { ts: 4242, action: 'token_revoked' },
    ]);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]).ts).toBe(4242);
  });

  it('a throwing onRecord never breaks record() (never-throws preserved)', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      onRecord: () => {
        throw new Error('sink boom');
      },
    });
    await expect(
      audit.record({ action: 'auth_failed' }),
    ).resolves.toBeUndefined();
    // The record was still persisted despite the sink throwing.
    expect(readFileSync(path, 'utf8')).toContain('auth_failed');
  });
});
