/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
  addPeerController,
  CONTROLLER_TOKEN_PREFIX,
  hashControllerToken,
  getPeerControllerRegistryPath,
  listPeerControllers,
  matchControllerToken,
  MAX_CONTROLLER_LABEL_CHARS,
  MAX_CONTROLLERS,
  mintControllerToken,
  PEER_CONTROLLER_SCHEMA_VERSION,
  PeerControllerError,
  type PeerControllerRecord,
  readPeerControllerRegistrySync,
  resetPeerControllerRegistryPathForTest,
  removePeerController,
  resolveControllerToken,
} from './peer-controllers.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

const isWindows = process.platform === 'win32';

let tmpDir: string;
let registryPath: string;

beforeEach(async () => {
  resetPeerControllerRegistryPathForTest();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-controllers-'));
  registryPath = path.join(tmpDir, 'peer-controllers.json');
});

afterEach(async () => {
  resetPeerControllerRegistryPathForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(contents: string): Promise<void> {
  await fs.writeFile(registryPath, contents, 'utf8');
}

async function readRaw(): Promise<{
  schemaVersion: number;
  controllers: PeerControllerRecord[];
}> {
  return JSON.parse(await fs.readFile(registryPath, 'utf8'));
}

const add = (label: string) => addPeerController(label, registryPath);
const list = () => listPeerControllers(registryPath);
const remove = (id: string) => removePeerController(id, registryPath);
const readFile = () => fs.readFile(registryPath, 'utf8');
const fileMode = async (p: string) => (await fs.stat(p)).mode & 0o777;
const registry = () => readPeerControllerRegistrySync(registryPath);
/** The grants the sync reader sees. */
const grants = () => registry().controllers;

/** A current-schema registry file holding `controllers` (plus `extra` keys). */
const registryJson = (controllers: unknown, extra: object = {}) =>
  JSON.stringify({
    schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
    controllers,
    ...extra,
  });

/**
 * Lands `rivalWrite` after each of the next `reads` mutation attempts has
 * read the registry but before it commits, as a waiter that took over a
 * stalled holder's lock would. The mutation reads synchronously as soon
 * as it holds the lock and then waits on I/O, so a `setImmediate` queued
 * at lock time runs in between.
 */
function landWriteAfterReads(rivalWrite: () => void, reads = 1) {
  const realLock = lockfile.lock.bind(lockfile);
  let left = reads;
  return vi
    .spyOn(lockfile, 'lock')
    .mockImplementation(async (file, options) => {
      const release = await realLock(file, options);
      if (left-- > 0) setImmediate(rivalWrite);
      return release;
    });
}

/** Makes registryPath a symlink to `elsewhere.json`, which `fill` creates. */
async function symlinkRegistry(
  fill: (real: string) => Promise<unknown> = (real) =>
    fs.writeFile(real, '{}', 'utf8'),
): Promise<string> {
  const real = path.join(tmpDir, 'elsewhere.json');
  await fill(real);
  await fs.symlink(real, registryPath);
  return real;
}

describe('mintControllerToken', () => {
  it('carries the prefix and 32 bytes of entropy', () => {
    const token = mintControllerToken();
    expect(token.startsWith(CONTROLLER_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(CONTROLLER_TOKEN_PREFIX.length)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('never repeats', () => {
    const tokens = new Set(
      Array.from({ length: 64 }, () => mintControllerToken()),
    );
    expect(tokens.size).toBe(64);
  });
});

describe('hashControllerToken', () => {
  it('is stable and hides the token', () => {
    const token = mintControllerToken();
    expect(hashControllerToken(token)).toBe(hashControllerToken(token));
    expect(hashControllerToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashControllerToken(token)).not.toContain(token);
  });
});

describe('addPeerController', () => {
  it('returns the token once and stores only its hash', async () => {
    const { record, token } = await add('voice');

    expect(record.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(record.label).toBe('voice');
    expect(record.tokenHash).toBe(hashControllerToken(token));

    // The plaintext must not survive anywhere on disk: this is the whole
    // reason the file holds a hash rather than the credential.
    const raw = await readFile();
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice(CONTROLLER_TOKEN_PREFIX.length));
    expect(raw).toContain(record.tokenHash);
  });

  it.skipIf(isWindows)('creates a private registry directory', async () => {
    const nestedRegistry = path.join(tmpDir, 'qwen-home', 'controllers.json');
    await addPeerController('voice', nestedRegistry);
    expect(await fileMode(path.dirname(nestedRegistry))).toBe(0o700);
  });

  it.skipIf(isWindows)('writes the file 0600', async () => {
    await add('voice');
    expect(await fileMode(registryPath)).toBe(0o600);
  });

  it.skipIf(isWindows)('heals an over-permissive file', async () => {
    // A copy restored from a backup at 0644 is a credential file the
    // world can read; the next write must fix it rather than preserve it.
    await add('voice');
    await fs.chmod(registryPath, 0o644);
    await add('second');
    expect(await fileMode(registryPath)).toBe(0o600);
  });

  it('leaves no temp file behind', async () => {
    await add('voice');
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['peer-controllers.json']);
  });

  it('appends to the existing grants', async () => {
    const first = await add('one');
    const second = await add('two');
    const stored = await readRaw();
    expect(stored.schemaVersion).toBe(PEER_CONTROLLER_SCHEMA_VERSION);
    expect(stored.controllers.map((record) => record.label)).toEqual([
      'one',
      'two',
    ]);
    expect(first.record.id).not.toBe(second.record.id);
  });

  it('serializes concurrent additions', async () => {
    await Promise.all(['one', 'two', 'three', 'four'].map(add));
    expect((await list()).map((record) => record.label).sort()).toEqual([
      'four',
      'one',
      'three',
      'two',
    ]);
  });

  it('lets one same-process writer reach the file lock at a time', async () => {
    // #15581: concurrent writers in one process used to contend for the
    // file lock, and the last one ran out of retries whenever the
    // holder's fsync was slow. They now queue in memory first.
    const realLock = lockfile.lock.bind(lockfile);
    let inFlight = 0;
    let peak = 0;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation(async (file, options) => {
        peak = Math.max(peak, ++inFlight);
        try {
          const release = await realLock(file, options);
          return async () => {
            try {
              await release();
            } finally {
              inFlight--;
            }
          };
        } catch (error) {
          inFlight--;
          throw error;
        }
      });
    try {
      await Promise.all(['one', 'two', 'three', 'four'].map(add));
      expect(lockSpy).toHaveBeenCalledTimes(4);
      expect(peak).toBe(1);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('waits out a lock that a crashed process left behind', async () => {
    // #15991: the wait used to end after about 0.7 s, long before a dead
    // holder's lock goes stale (5 s), so the next writer failed. This lock
    // was last refreshed 3 s ago and goes stale in about 2 s.
    const lockDir = `${registryPath}.lock`;
    await fs.mkdir(lockDir);
    const lastRefresh = new Date(Date.now() - 3000);
    await fs.utimes(lockDir, lastRefresh, lastRefresh);
    const startedAt = Date.now();
    const added = await add('voice');
    // The wait shows the planted lock was in the way; a lock the code
    // never looked at would let the write through in milliseconds.
    expect(Date.now() - startedAt).toBeGreaterThan(1500);
    expect((await readRaw()).controllers).toEqual([added.record]);
  });

  it("waits longer than a dead holder's lock can take to go stale", async () => {
    // A lock stamped just before its holder crashed can take `stale` plus
    // 1 s to go stale: proper-lockfile stamps a process's first lock up to
    // 1 s ahead. The writer must still be waiting by then.
    vi.useFakeTimers();
    const lockSpy = vi.spyOn(lockfile, 'lock').mockRejectedValue(
      Object.assign(new Error('Lock file is already being held'), {
        code: 'ELOCKED',
      }),
    );
    try {
      const startedAt = Date.now();
      const outcome = add('voice').catch((error: unknown) => error);
      await vi.waitFor(() => expect(lockSpy).toHaveBeenCalled());
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ code: 'ELOCKED' });
      const { stale } = lockSpy.mock.calls[0][1]!;
      expect(Date.now() - startedAt).toBeGreaterThan(stale! + 1000);
    } finally {
      lockSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // POSIX only: what rmdir reports for a regular file is platform-specific.
  it.skipIf(isWindows)('fails at once when waiting cannot help', async () => {
    // A regular file where the lock directory goes cannot be removed as a
    // stale lock (ENOTDIR), however long the writer waits.
    const lockPath = `${registryPath}.lock`;
    await fs.writeFile(lockPath, '');
    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, longAgo, longAgo);
    const lockSpy = vi.spyOn(lockfile, 'lock');
    try {
      await expect(add('voice')).rejects.toMatchObject({ code: 'ENOTDIR' });
      expect(lockSpy).toHaveBeenCalledTimes(1);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('keeps a grant that landed while an add was in flight', async () => {
    const rival = {
      id: 'c_0000000a',
      label: 'rival',
      tokenHash: 'a'.repeat(64),
      createdAt: 1,
    };
    const lockSpy = landWriteAfterReads(() =>
      writeFileSync(registryPath, registryJson([rival])),
    );
    try {
      const added = await add('voice');
      expect((await readRaw()).controllers).toEqual([rival, added.record]);
      expect(lockSpy).toHaveBeenCalledTimes(2);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('gives up, saving nothing, when the registry keeps changing', async () => {
    // A rival lands a fresh write inside each of five attempts, more than
    // the redo bound allows.
    const rivals: PeerControllerRecord[] = [];
    const lockSpy = landWriteAfterReads(() => {
      rivals.push({
        id: `c_0000000${rivals.length}`,
        label: `rival ${rivals.length}`,
        tokenHash: 'a'.repeat(64),
        createdAt: 1,
      });
      writeFileSync(registryPath, registryJson(rivals));
    }, 5);
    try {
      const failure = await add('voice').catch((error: unknown) => error);
      // The CLI reports a PeerControllerError as it stands instead of
      // blaming the file.
      expect(failure).toBeInstanceOf(PeerControllerError);
      expect(failure).toMatchObject({ code: 'registry-changed' });
      expect(lockSpy).toHaveBeenCalledTimes(3);
      expect((await readRaw()).controllers).toEqual(rivals);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('completes a write after a stale-lock takeover', async () => {
    const { lockSpy, getOnCompromised } = mockCompromisedLock();
    try {
      const added = await add('voice');
      expect(added.record.label).toBe('voice');
      expect(getOnCompromised()).toBeTypeOf('function');
      expect((await readRaw()).controllers).toContainEqual(added.record);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('refuses to overwrite a malformed registry', async () => {
    await writeRaw('{ not json');
    await expect(add('voice')).rejects.toMatchObject({
      code: 'invalid-registry',
    });
    expect(await readFile()).toBe('{ not json');
  });

  it('refuses to overwrite a registry with a malformed entry', async () => {
    const malformed = registryJson([
      {
        id: 'c_00000001',
        label: 'voice',
        tokenHash: 'f'.repeat(64),
        createdAt: 'yesterday',
      },
    ]);
    await writeRaw(malformed);
    await expect(add('second')).rejects.toMatchObject({
      code: 'invalid-registry',
    });
    expect(await readFile()).toBe(malformed);
  });

  it('refuses to overwrite an oversized or foreign-version registry', async () => {
    const inputs = [
      registryJson([], { padding: 'x'.repeat(64 * 1024) }),
      JSON.stringify({ schemaVersion: 2, controllers: [] }),
    ];
    for (const raw of inputs) {
      await writeRaw(raw);
      await expect(add('voice')).rejects.toMatchObject({
        code: 'invalid-registry',
      });
      expect(await readFile()).toBe(raw);
    }
  });

  it('flattens a label before storing it', async () => {
    // The label is printed into an envelope attribute and a terminal
    // listing, so a newline in it would render as free-standing text.
    const { record } = await add('  voice​bridge\n ');
    expect(record.label).toBe('voice bridge');
  });

  it('refuses a label that is empty once flattened', async () => {
    await expect(add('   ')).rejects.toMatchObject({
      code: 'invalid-label',
    });
    await expect(add('​​')).rejects.toBeInstanceOf(PeerControllerError);
  });

  it('refuses a label past the length cap', async () => {
    await expect(
      add('x'.repeat(MAX_CONTROLLER_LABEL_CHARS + 1)),
    ).rejects.toMatchObject({ code: 'invalid-label' });
    // The boundary itself is allowed.
    const { record } = await add('x'.repeat(MAX_CONTROLLER_LABEL_CHARS));
    expect(record.label).toHaveLength(MAX_CONTROLLER_LABEL_CHARS);
  });

  it('refuses a duplicate label, whatever its case', async () => {
    await add('Voice');
    const lockSpy = vi.spyOn(lockfile, 'lock');
    try {
      await expect(add('voice')).rejects.toMatchObject({
        code: 'duplicate-label',
      });
      // A refusal is final; only a registry that changed under the
      // mutation is worth redoing.
      expect(lockSpy).toHaveBeenCalledTimes(1);
    } finally {
      lockSpy.mockRestore();
    }
    expect(await list()).toHaveLength(1);
  });

  it('refuses to grow past the cap', async () => {
    for (let i = 0; i < MAX_CONTROLLERS; i++) {
      await add(`c${i}`);
    }
    await expect(add('one-too-many')).rejects.toMatchObject({
      code: 'too-many',
    });
    expect(await list()).toHaveLength(MAX_CONTROLLERS);
  });

  it.skipIf(isWindows)('refuses to write through a symlink', async () => {
    // Replacing the link would silently destroy something the user
    // placed on purpose, and the read path ignores a symlinked registry
    // anyway — so say so instead of doing either.
    const real = await symlinkRegistry();
    await expect(add('voice')).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await fs.readFile(real, 'utf8')).toBe('{}');
  });
});

describe('removePeerController', () => {
  it('removes by id and reports what went', async () => {
    const { record } = await add('voice');
    await add('other');

    const removed = await remove(record.id);
    expect(removed?.label).toBe('voice');
    expect((await list()).map((r) => r.label)).toEqual(['other']);
  });

  it('matches an id whatever its case, and tolerates surrounding space', async () => {
    const { record } = await add('voice');
    expect(await remove(` ${record.id.toUpperCase()} `)).not.toBeNull();
    expect(await list()).toHaveLength(0);
  });

  it('returns null for an id nothing holds, and writes nothing', async () => {
    await add('voice');
    const before = await readFile();
    expect(await remove('c_deadbeef')).toBeNull();
    expect(await readFile()).toBe(before);
  });

  it('is a no-op on a registry that does not exist', async () => {
    expect(await remove('c_deadbeef')).toBeNull();
    await expect(fs.stat(registryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes concurrent revocations without resurrecting a grant', async () => {
    const first = await add('one');
    const second = await add('two');
    await Promise.all([remove(first.record.id), remove(second.record.id)]);
    expect(await list()).toEqual([]);
  });

  it('keeps a revocation that landed while a revoke was in flight', async () => {
    const first = await add('one');
    const second = await add('two');
    // The rival revokes "two" while this call is revoking "one".
    const lockSpy = landWriteAfterReads(() =>
      writeFileSync(registryPath, registryJson([first.record])),
    );
    try {
      expect(await remove(first.record.id)).toEqual(first.record);
      expect(await list()).toEqual([]);
      expect(
        resolveControllerToken(second.token, registryPath),
      ).toBeUndefined();
      expect(lockSpy).toHaveBeenCalledTimes(2);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('revokes every record that carries the same credential', async () => {
    const token = mintControllerToken();
    const tokenHash = hashControllerToken(token);
    await writeRaw(
      registryJson([
        { id: 'c_00000001', label: 'first', tokenHash, createdAt: 1 },
        { id: 'c_00000002', label: 'second', tokenHash, createdAt: 2 },
      ]),
    );

    await expect(remove('c_00000001')).resolves.toMatchObject({
      id: 'c_00000001',
    });
    expect(resolveControllerToken(token, registryPath)).toBeUndefined();
    expect(await list()).toEqual([]);
  });

  it('drops malformed entries while revoking a valid grant', async () => {
    const { record, token } = await add('voice');
    await writeRaw(
      registryJson([{ ...record, createdAt: 'yesterday' }, record]),
    );

    expect(await list()).toEqual([record]);
    await expect(remove(record.id)).resolves.toMatchObject({ id: record.id });
    expect(resolveControllerToken(token, registryPath)).toBeUndefined();
    expect((await readRaw()).controllers).toEqual([]);
  });

  it.skipIf(isWindows)('still refuses a symlinked registry', async () => {
    await symlinkRegistry();
    await expect(list()).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(remove('c_00000001')).rejects.toMatchObject({
      code: 'unsafe-path',
    });
  });
});

describe('readPeerControllerRegistrySync', () => {
  it('reads back what add wrote', async () => {
    const { record } = await add('voice');
    expect(registry()).toEqual({
      schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
      controllers: [record],
    });
  });

  it('treats a missing file as no grants', () => {
    expect(grants()).toEqual([]);
  });

  it('treats unparseable JSON as no grants', async () => {
    await writeRaw('{ not json');
    expect(grants()).toEqual([]);
    await expect(list()).rejects.toMatchObject({
      code: 'invalid-registry',
      message: expect.not.stringContaining('Refusing to modify'),
    });
  });

  it('treats a schema it does not know as no grants', async () => {
    // Failing closed: a newer build's file may mean something this one
    // would misread, and no grant is the safe reading.
    await add('voice');
    const stored = await readRaw();
    await writeRaw(JSON.stringify({ ...stored, schemaVersion: 2 }));
    expect(grants()).toEqual([]);
  });

  it('treats a non-array controllers field as no grants', async () => {
    await writeRaw(registryJson({ id: 'c_00000000' }));
    expect(grants()).toEqual([]);
  });

  it.skipIf(isWindows)('ignores a symlinked registry', async () => {
    await symlinkRegistry((real) => addPeerController('voice', real));
    expect(grants()).toEqual([]);
  });

  it('ignores a file past the size cap', async () => {
    await add('voice');
    const stored = await readRaw();
    await writeRaw(
      JSON.stringify({ ...stored, padding: 'x'.repeat(64 * 1024) }),
    );
    expect(grants()).toEqual([]);
  });

  it('skips a malformed entry and keeps the rest', async () => {
    // Discarding the whole file would silently revoke the good grants;
    // the cost of the bad one is that its controller is re-added.
    const { record } = await add('voice');
    await writeRaw(
      registryJson([
        { ...record, id: 'not-an-id' },
        { ...record, tokenHash: 'zz' },
        { ...record, label: '' },
        { ...record, createdAt: 'yesterday' },
        null,
        record,
      ]),
    );
    expect(grants()).toEqual([record]);
  });
});

describe('matchControllerToken', () => {
  it('names the grant a token belongs to, and nothing else', async () => {
    const { record, token } = await add('voice');
    await add('other');

    const matched = matchControllerToken(registry(), token);
    expect(matched).toEqual({ id: record.id, label: 'voice' });
    // The hash is a credential's shadow and has no business travelling
    // with a message.
    expect(matched).not.toHaveProperty('tokenHash');
  });

  it('rejects a token no grant holds', async () => {
    await add('voice');
    expect(
      matchControllerToken(registry(), mintControllerToken()),
    ).toBeUndefined();
  });

  it('matches a grant after the first registry entry', async () => {
    await add('first');
    const second = await add('second');
    expect(matchControllerToken(registry(), second.token)).toEqual({
      id: second.record.id,
      label: 'second',
    });
  });

  it('scans every record and returns the last matching identity', () => {
    const token = mintControllerToken();
    const tokenHash = hashControllerToken(token);
    expect(
      matchControllerToken(
        {
          schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
          controllers: [
            { id: 'c_00000001', label: 'first', tokenHash, createdAt: 1 },
            { id: 'c_00000002', label: 'second', tokenHash, createdAt: 2 },
          ],
        },
        token,
      ),
    ).toEqual({ id: 'c_00000002', label: 'second' });
  });

  it('rejects a token without the prefix', async () => {
    const { token } = await add('voice');
    expect(
      matchControllerToken(
        registry(),
        token.slice(CONTROLLER_TOKEN_PREFIX.length),
      ),
    ).toBeUndefined();
  });

  it('rejects an oversized presentation without hashing it', async () => {
    const presented = CONTROLLER_TOKEN_PREFIX + 'x'.repeat(4096);
    await writeRaw(
      registryJson([
        {
          id: 'c_0123abcd',
          label: 'voice',
          tokenHash: hashControllerToken(presented),
          createdAt: Date.now(),
        },
      ]),
    );
    expect(matchControllerToken(registry(), presented)).toBeUndefined();
  });

  it('matches nothing against an empty registry', () => {
    expect(
      matchControllerToken(
        { schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION, controllers: [] },
        mintControllerToken(),
      ),
    ).toBeUndefined();
  });
});

describe('resolveControllerToken', () => {
  it('reads the current file, so a revocation takes effect at once', async () => {
    const { record, token } = await add('voice');
    expect(resolveControllerToken(token, registryPath)).toEqual({
      id: record.id,
      label: 'voice',
    });

    await remove(record.id);
    expect(resolveControllerToken(token, registryPath)).toBeUndefined();
  });

  it('answers without reading anything when the shape is wrong', () => {
    // The registry path does not even exist here: a token that cannot be
    // a grant is rejected before the file is consulted.
    expect(
      resolveControllerToken('a'.repeat(64), path.join(tmpDir, 'absent.json')),
    ).toBeUndefined();
  });
});

describe('getPeerControllerRegistryPath', () => {
  it('pins a relative QWEN_HOME before the working directory changes', () => {
    const originalCwd = process.cwd();
    const originalHome = process.env['QWEN_HOME'];
    try {
      process.env['QWEN_HOME'] = 'relative-qwen-home';
      process.chdir(tmpDir);
      const expected = path.resolve(
        'relative-qwen-home',
        'peer-controllers.json',
      );
      const first = getPeerControllerRegistryPath();
      process.chdir(path.dirname(tmpDir));
      expect(getPeerControllerRegistryPath()).toBe(first);
      expect(first).toBe(expected);
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalHome;
    }
  });

  it('uses one default path for minting, resolving, listing, and revoking', async () => {
    const originalHome = process.env['QWEN_HOME'];
    try {
      process.env['QWEN_HOME'] = path.join(tmpDir, 'qwen-home');
      resetPeerControllerRegistryPathForTest();
      const { record, token } = await addPeerController('voice');
      expect(resolveControllerToken(token)).toEqual({
        id: record.id,
        label: 'voice',
      });
      expect(await listPeerControllers()).toEqual([record]);
      expect(await removePeerController(record.id)).toEqual(record);
      expect(resolveControllerToken(token)).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalHome;
      resetPeerControllerRegistryPathForTest();
    }
  });
});
