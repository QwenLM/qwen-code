/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readLocalJournalBytes,
  readLocalJournalResource,
} from './local-managed-journal-snapshot.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function resource() {
  const runtimeBaseDir = fs.mkdtempSync(
    path.join(tmpdir(), 'managed-resource-link-'),
  );
  directories.push(runtimeBaseDir);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: 'session',
  };
  const bytes = Buffer.from('complete bytes');
  const ref = {
    resourceId: createHash('sha256').update(bytes).digest('hex'),
    kind: 'managed-local-journal-snapshot-page',
    schemaVersion: 1,
    byteLength: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  const directory = path.join(
    runtimeBaseDir,
    'resources',
    sessionKey.sessionId,
    ref.kind,
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, ref.resourceId);
  const pending = path.join(directory, 'pending');
  fs.writeFileSync(file, bytes);
  fs.linkSync(file, pending);
  return { runtimeBaseDir, sessionKey, ref, bytes, file, pending };
}

function unlinkDuringRead(pending: string) {
  let unlinked = false;
  const read = fs.readSync.bind(fs);
  const stat = fs.fstatSync.bind(fs);
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: Parameters<typeof fs.readSync>
  ) => {
    const result = read(...args);
    if (!unlinked) {
      fs.unlinkSync(pending);
      unlinked = true;
    }
    return result;
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((
    ...args: Parameters<typeof fs.fstatSync>
  ) => {
    const value = stat(...args);
    if (!unlinked) return value;
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
      ctimeMs: Number(value.ctimeMs) + 1,
    });
  }) as typeof fs.fstatSync);
}

describe('immutable local journal resource reads', () => {
  it('accepts a publisher pending-link unlink while preserving inode, length, mtime and digest', () => {
    const fixture = resource();
    expect(fs.statSync(fixture.file).nlink).toBe(2);
    unlinkDuringRead(fixture.pending);
    expect(
      readLocalJournalResource(
        fixture.runtimeBaseDir,
        fixture.sessionKey,
        fixture.ref,
      ),
    ).toEqual(fixture.bytes);
    expect(fs.statSync(fixture.file).nlink).toBe(1);
  });

  it('keeps the same ctime change fatal for journal and control reads', () => {
    const fixture = resource();
    unlinkDuringRead(fixture.pending);
    expect(() => readLocalJournalBytes(fixture.file)).toThrow(
      'file changed while reading',
    );
  });

  it('still refuses changed content and missing resource bytes', () => {
    const fixture = resource();
    fs.writeFileSync(fixture.file, Buffer.from('corrupt! bytes'));
    expect(() =>
      readLocalJournalResource(
        fixture.runtimeBaseDir,
        fixture.sessionKey,
        fixture.ref,
      ),
    ).toThrow();
    fs.unlinkSync(fixture.file);
    expect(() =>
      readLocalJournalResource(
        fixture.runtimeBaseDir,
        fixture.sessionKey,
        fixture.ref,
      ),
    ).toThrow();
  });
});
