/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AuditLog } from './auditLog.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-audit-'));
}

/** Build a fake Date from an ISO string. */
function fakeDate(iso: string): Date {
  return new Date(iso);
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Existing behaviour tests (preserved - constructor signature unchanged)
// ---------------------------------------------------------------------------

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
    const rows = await audit.query({});
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.action === 'token_minted');
    expect(first).toMatchObject({
      ts: 1234,
      action: 'token_minted',
      actorTokenId: 'a',
      target: 'b',
    });
    const second = rows.find((r) => r.action === 'token_revoked');
    expect(second?.action).toBe('token_revoked');
  });

  it('creates the log directory with 0700 and files with 0600 permissions', async () => {
    const path = join(dir, 'nested', 'audit.log');
    const audit = new AuditLog(path);
    await audit.record({ action: 'auth_failed' });
    const nestedDir = join(dir, 'nested');
    expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
    const files = readdirSync(nestedDir).filter((f) => f.startsWith('audit-'));
    expect(files.length).toBeGreaterThan(0);
    expect(statSync(join(nestedDir, files[0]!)).mode & 0o777).toBe(0o600);
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
    await audit.record({
      action: 'session_attached',
      shareId: 'sh1',
      target: 's',
    });
    await audit.record({ action: 'permission_voted', actorTokenId: 'sh1' });
    await audit.record({
      action: 'share_created',
      actorTokenId: 'owner',
      detail: { shareId: 'sh1' },
    });
    await audit.record({ action: 'session_attached', shareId: 'sh2' });
    await audit.record({ action: 'token_minted', detail: { shareId: 12345 } });

    const rows = await audit.query({ shareId: 'sh1' });
    expect(rows.map((r) => r.action).sort()).toEqual([
      'permission_voted',
      'session_attached',
      'share_created',
    ]);
    expect(await audit.query({ shareId: '12345' })).toEqual([]);
  });

  it('skips corrupt lines and returns [] for a missing log', async () => {
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1);
    expect(await audit.query({})).toEqual([]);
    await audit.record({ action: 'token_minted', target: 'a' });
    const logFiles = readdirSync(dir).filter((f) => f.startsWith('audit-'));
    expect(logFiles.length).toBeGreaterThan(0);
    appendFileSync(join(dir, logFiles[0]!), 'not json\n');
    const rows = await audit.query({});
    expect(rows.map((r) => r.target)).toEqual(['a']);
  });

  it('does not lose records when concurrent writes happen', async () => {
    const path = join(dir, 'audit.log');
    let t = 0;
    const audit = new AuditLog(path, () => ++t);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.record({ action: 'token_minted', target: String(i) }),
      ),
    );
    const rows = await audit.query({ limit: 100 });
    expect(new Set(rows.map((r) => r.target)).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// onRecord sink (preserved from previous cycle)
// ---------------------------------------------------------------------------

describe('AuditLog onRecord sink', () => {
  it('fires onRecord once per durably-appended record, with the stamped ts', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const seen: Array<{ ts: number; action: string }> = [];
    const audit = new AuditLog(path, () => 4242, {
      onRecord: (r) => seen.push({ ts: r.ts, action: r.action }),
    });
    await audit.record({ action: 'token_minted', actorTokenId: 'a' });
    await audit.record({ action: 'token_revoked', actorTokenId: 'a' });
    expect(seen).toEqual([
      { ts: 4242, action: 'token_minted' },
      { ts: 4242, action: 'token_revoked' },
    ]);
    const rows = await audit.query({});
    expect(rows.map((r) => r.ts).every((t) => t === 4242)).toBe(true);
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
    const rows = await audit.query({});
    expect(rows.map((r) => r.action)).toContain('auth_failed');
  });
});

// ---------------------------------------------------------------------------
// NEW: daily rotation
// ---------------------------------------------------------------------------

describe('AuditLog daily rotation', () => {
  it('writes to audit-YYYY-MM-DD.log in the parent directory', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1000, {
      nowDate: () => fakeDate('2026-07-09T12:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    const files = readdirSync(dir);
    expect(files).toContain('audit-2026-07-09.log');
  });

  it('rotates to a new file when the date changes', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    let day = '2026-07-09';
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate(`${day}T00:00:00Z`),
    });
    await audit.record({ action: 'auth_failed' });
    day = '2026-07-10';
    await audit.record({ action: 'token_minted' });
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('audit-'))
      .sort();
    expect(files).toEqual(['audit-2026-07-09.log', 'audit-2026-07-10.log']);
  });

  it('query() spans multiple daily files and returns all records', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    let t = 0;
    let day = '2026-07-08';
    const audit = new AuditLog(path, () => ++t, {
      nowDate: () => fakeDate(`${day}T00:00:00Z`),
    });
    await audit.record({ action: 'auth_failed', target: 'day1' });
    day = '2026-07-09';
    await audit.record({ action: 'token_minted', target: 'day2' });
    const rows = await audit.query({});
    expect(rows.map((r) => r.target).sort()).toEqual(['day1', 'day2']);
  });
});

// ---------------------------------------------------------------------------
// NEW: prevHash chain + v:1
// ---------------------------------------------------------------------------

describe('AuditLog prevHash chain', () => {
  it('first record carries prevHash = sha256("genesis:<filename>")', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    const fileName = 'audit-2026-07-09.log';
    const content = readFileSync(join(dir, fileName), 'utf8');
    const line = content.trim();
    const obj = JSON.parse(line) as { prevHash: string; v: number };
    expect(obj.prevHash).toBe(sha256Hex(`genesis:${fileName}`));
  });

  it('second record prevHash = sha256(first-line-bytes-no-newline)', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    await audit.record({ action: 'token_minted' });
    const fileName = 'audit-2026-07-09.log';
    const content = readFileSync(join(dir, fileName), 'utf8');
    const [line1, line2] = content.trim().split('\n');
    const expectedPrevHash = sha256Hex(Buffer.from(line1!, 'utf8'));
    const obj2 = JSON.parse(line2!) as { prevHash: string };
    expect(obj2.prevHash).toBe(expectedPrevHash);
  });

  it('each record carries v:1', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    const content = readFileSync(join(dir, 'audit-2026-07-09.log'), 'utf8');
    const obj = JSON.parse(content.trim()) as { v: number };
    expect(obj.v).toBe(1);
  });

  it('new daily file starts a fresh chain from genesis', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    let day = '2026-07-09';
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate(`${day}T00:00:00Z`),
    });
    await audit.record({ action: 'auth_failed' });
    day = '2026-07-10';
    await audit.record({ action: 'token_minted' });
    const content2 = readFileSync(join(dir, 'audit-2026-07-10.log'), 'utf8');
    const obj2 = JSON.parse(content2.trim()) as { prevHash: string };
    expect(obj2.prevHash).toBe(sha256Hex('genesis:audit-2026-07-10.log'));
  });

  it('chain is maintained across restarts (reopening the same file)', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const nowDate = () => fakeDate('2026-07-09T00:00:00Z');
    const audit1 = new AuditLog(path, () => 1, { nowDate });
    await audit1.record({ action: 'auth_failed' });
    const audit2 = new AuditLog(path, () => 2, { nowDate });
    await audit2.record({ action: 'token_minted' });
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NEW: verifyChain
// ---------------------------------------------------------------------------

describe('AuditLog.verifyChain', () => {
  it('returns ok:true for an empty directory', () => {
    const dir = freshDir();
    expect(AuditLog.verifyChain(dir)).toEqual({ ok: true, failures: [] });
  });

  it('returns ok:true for a directory that does not exist', () => {
    const dir = join(freshDir(), 'nonexistent');
    expect(AuditLog.verifyChain(dir)).toEqual({ ok: true, failures: [] });
  });

  it('returns ok:true for a valid chain', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    await audit.record({ action: 'token_minted' });
    await audit.record({ action: 'token_revoked' });
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('detects a tampered line (first line prevHash wrong)', () => {
    const dir = freshDir();
    const fileName = 'audit-2026-07-09.log';
    const filePath = join(dir, fileName);
    const badLine = JSON.stringify({
      v: 1,
      ts: 1,
      action: 'auth_failed',
      prevHash: 'deadbeef',
    });
    writeFileSync(filePath, badLine + '\n', { mode: 0o600 });
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.file).toBe(filePath);
    expect(result.failures[0]!.line).toBe(1);
  });

  it('detects a tampered interior line (break reported at next line)', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    await audit.record({ action: 'token_minted' });
    await audit.record({ action: 'token_revoked' });
    const filePath = join(dir, 'audit-2026-07-09.log');
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const obj = JSON.parse(lines[1]!) as Record<string, unknown>;
    obj['action'] = 'TAMPERED';
    lines[1] = JSON.stringify(obj);
    writeFileSync(filePath, lines.join('\n') + '\n');
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.line).toBe(3);
  });

  it('ignores trailing partial line (torn tail - recovery domain)', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    const filePath = join(dir, 'audit-2026-07-09.log');
    appendFileSync(filePath, '{"partial":true');
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(true);
  });

  it('verifies multiple daily files independently', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    let day = '2026-07-09';
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate(`${day}T00:00:00Z`),
    });
    await audit.record({ action: 'auth_failed' });
    day = '2026-07-10';
    await audit.record({ action: 'token_minted' });
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NEW: crash recovery
// ---------------------------------------------------------------------------

describe('AuditLog crash recovery', () => {
  it('recover() on a clean file returns truncated:false', () => {
    const dir = freshDir();
    const filePath = join(dir, 'audit-2026-07-09.log');
    const line = JSON.stringify({
      v: 1,
      ts: 1,
      action: 'auth_failed',
      prevHash: 'x',
    });
    writeFileSync(filePath, line + '\n', { mode: 0o600 });
    const result = AuditLog.recover(filePath);
    expect(result.truncated).toBe(false);
    expect(result.removedBytes).toBe(0);
  });

  it('recover() on a file with partial last line removes the partial bytes', () => {
    const dir = freshDir();
    const filePath = join(dir, 'audit-2026-07-09.log');
    const line = JSON.stringify({
      v: 1,
      ts: 1,
      action: 'auth_failed',
      prevHash: 'x',
    });
    writeFileSync(filePath, line + '\n' + '{"partial":true', { mode: 0o600 });
    const before = statSync(filePath).size;
    const result = AuditLog.recover(filePath);
    expect(result.truncated).toBe(true);
    expect(result.removedBytes).toBeGreaterThan(0);
    const after = statSync(filePath).size;
    expect(after).toBe(before - result.removedBytes);
    const content = readFileSync(filePath, 'utf8');
    expect(content.trim()).toBe(line);
  });

  it('recover() on a nonexistent file returns truncated:false', () => {
    const filePath = join(freshDir(), 'missing.log');
    const result = AuditLog.recover(filePath);
    expect(result.truncated).toBe(false);
  });

  it('auto-recovers torn tail on open before writing', async () => {
    const dir = freshDir();
    const path = join(dir, 'audit.log');
    const nowDate = () => fakeDate('2026-07-09T00:00:00Z');
    const filePath = join(dir, 'audit-2026-07-09.log');
    const genesis = sha256Hex('genesis:audit-2026-07-09.log');
    const line1 = JSON.stringify({
      v: 1,
      ts: 1,
      action: 'auth_failed',
      prevHash: genesis,
    });
    writeFileSync(filePath, line1 + '\n' + '{"partial', { mode: 0o600 });
    const audit = new AuditLog(path, () => 2, { nowDate });
    await audit.record({ action: 'token_minted' });
    const result = AuditLog.verifyChain(dir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: directory mode
// ---------------------------------------------------------------------------

describe('AuditLog directory mode', () => {
  it('creates the audit dir with mode 0700', async () => {
    const dir = freshDir();
    const nestedDir = join(dir, 'auditdir');
    const path = join(nestedDir, 'audit.log');
    const audit = new AuditLog(path, () => 1, {
      nowDate: () => fakeDate('2026-07-09T00:00:00Z'),
    });
    await audit.record({ action: 'auth_failed' });
    expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
  });
});
