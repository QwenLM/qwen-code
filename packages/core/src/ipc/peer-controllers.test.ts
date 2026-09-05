/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addPeerController,
  CONTROLLER_TOKEN_PREFIX,
  hashControllerToken,
  listPeerControllers,
  matchControllerToken,
  MAX_CONTROLLER_LABEL_CHARS,
  MAX_CONTROLLERS,
  mintControllerToken,
  PEER_CONTROLLER_SCHEMA_VERSION,
  PeerControllerError,
  type PeerControllerRecord,
  readPeerControllerRegistrySync,
  removePeerController,
  resolveControllerToken,
} from './peer-controllers.js';

const isWindows = process.platform === 'win32';

let tmpDir: string;
let registryPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-controllers-'));
  registryPath = path.join(tmpDir, 'peer-controllers.json');
});

afterEach(async () => {
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
    const { record, token } = await addPeerController('voice', registryPath);

    expect(record.id).toMatch(/^c_[0-9a-f]{8}$/);
    expect(record.label).toBe('voice');
    expect(record.tokenHash).toBe(hashControllerToken(token));

    // The plaintext must not survive anywhere on disk: this is the whole
    // reason the file holds a hash rather than the credential.
    const raw = await fs.readFile(registryPath, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(record.tokenHash);
  });

  it.skipIf(isWindows)('writes the file 0600', async () => {
    await addPeerController('voice', registryPath);
    const stats = await fs.stat(registryPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('heals an over-permissive file', async () => {
    // A copy restored from a backup at 0644 is a credential file the
    // world can read; the next write must fix it rather than preserve it.
    await addPeerController('voice', registryPath);
    await fs.chmod(registryPath, 0o644);
    await addPeerController('second', registryPath);
    const stats = await fs.stat(registryPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', async () => {
    await addPeerController('voice', registryPath);
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['peer-controllers.json']);
  });

  it('appends to the existing grants', async () => {
    const first = await addPeerController('one', registryPath);
    const second = await addPeerController('two', registryPath);
    const stored = await readRaw();
    expect(stored.schemaVersion).toBe(PEER_CONTROLLER_SCHEMA_VERSION);
    expect(stored.controllers.map((record) => record.label)).toEqual([
      'one',
      'two',
    ]);
    expect(first.record.id).not.toBe(second.record.id);
  });

  it('flattens a label before storing it', async () => {
    // The label is printed into an envelope attribute and a terminal
    // listing, so a newline in it would render as free-standing text.
    const { record } = await addPeerController(
      '  voice​bridge\n ',
      registryPath,
    );
    expect(record.label).toBe('voice bridge');
  });

  it('refuses a label that is empty once flattened', async () => {
    await expect(addPeerController('   ', registryPath)).rejects.toMatchObject({
      code: 'invalid-label',
    });
    await expect(addPeerController('​​', registryPath)).rejects.toBeInstanceOf(
      PeerControllerError,
    );
  });

  it('refuses a label past the length cap', async () => {
    await expect(
      addPeerController(
        'x'.repeat(MAX_CONTROLLER_LABEL_CHARS + 1),
        registryPath,
      ),
    ).rejects.toMatchObject({ code: 'invalid-label' });
    // The boundary itself is allowed.
    const { record } = await addPeerController(
      'x'.repeat(MAX_CONTROLLER_LABEL_CHARS),
      registryPath,
    );
    expect(record.label).toHaveLength(MAX_CONTROLLER_LABEL_CHARS);
  });

  it('refuses a duplicate label, whatever its case', async () => {
    await addPeerController('Voice', registryPath);
    await expect(
      addPeerController('voice', registryPath),
    ).rejects.toMatchObject({ code: 'duplicate-label' });
    expect(await listPeerControllers(registryPath)).toHaveLength(1);
  });

  it('refuses to grow past the cap', async () => {
    for (let i = 0; i < MAX_CONTROLLERS; i++) {
      await addPeerController(`c${i}`, registryPath);
    }
    await expect(
      addPeerController('one-too-many', registryPath),
    ).rejects.toMatchObject({ code: 'too-many' });
    expect(await listPeerControllers(registryPath)).toHaveLength(
      MAX_CONTROLLERS,
    );
  });

  it.skipIf(isWindows)('refuses to write through a symlink', async () => {
    // Replacing the link would silently destroy something the user
    // placed on purpose, and the read path ignores a symlinked registry
    // anyway — so say so instead of doing either.
    const real = path.join(tmpDir, 'elsewhere.json');
    await fs.writeFile(real, '{}', 'utf8');
    await fs.symlink(real, registryPath);
    await expect(
      addPeerController('voice', registryPath),
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await fs.readFile(real, 'utf8')).toBe('{}');
  });
});

describe('removePeerController', () => {
  it('removes by id and reports what went', async () => {
    const { record } = await addPeerController('voice', registryPath);
    await addPeerController('other', registryPath);

    const removed = await removePeerController(record.id, registryPath);
    expect(removed?.label).toBe('voice');
    expect(
      (await listPeerControllers(registryPath)).map((r) => r.label),
    ).toEqual(['other']);
  });

  it('matches an id whatever its case, and tolerates surrounding space', async () => {
    const { record } = await addPeerController('voice', registryPath);
    expect(
      await removePeerController(` ${record.id.toUpperCase()} `, registryPath),
    ).not.toBeNull();
    expect(await listPeerControllers(registryPath)).toHaveLength(0);
  });

  it('returns null for an id nothing holds, and writes nothing', async () => {
    await addPeerController('voice', registryPath);
    const before = await fs.readFile(registryPath, 'utf8');
    expect(await removePeerController('c_deadbeef', registryPath)).toBeNull();
    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
  });

  it('is a no-op on a registry that does not exist', async () => {
    expect(await removePeerController('c_deadbeef', registryPath)).toBeNull();
    await expect(fs.stat(registryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('readPeerControllerRegistrySync', () => {
  it('reads back what add wrote', async () => {
    const { record } = await addPeerController('voice', registryPath);
    expect(readPeerControllerRegistrySync(registryPath)).toEqual({
      schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
      controllers: [record],
    });
  });

  it('treats a missing file as no grants', () => {
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it('treats unparseable JSON as no grants', async () => {
    await writeRaw('{ not json');
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it('treats a schema it does not know as no grants', async () => {
    // Failing closed: a newer build's file may mean something this one
    // would misread, and no grant is the safe reading.
    await addPeerController('voice', registryPath);
    const stored = await readRaw();
    await writeRaw(JSON.stringify({ ...stored, schemaVersion: 2 }));
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it('treats a non-array controllers field as no grants', async () => {
    await writeRaw(
      JSON.stringify({
        schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
        controllers: { id: 'c_00000000' },
      }),
    );
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it.skipIf(isWindows)('ignores a symlinked registry', async () => {
    const real = path.join(tmpDir, 'elsewhere.json');
    await addPeerController('voice', real);
    await fs.symlink(real, registryPath);
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it('ignores a file past the size cap', async () => {
    await addPeerController('voice', registryPath);
    const stored = await readRaw();
    await writeRaw(
      JSON.stringify({ ...stored, padding: 'x'.repeat(64 * 1024) }),
    );
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual(
      [],
    );
  });

  it('skips a malformed entry and keeps the rest', async () => {
    // Discarding the whole file would silently revoke the good grants;
    // the cost of the bad one is that its controller is re-added.
    const { record } = await addPeerController('voice', registryPath);
    await writeRaw(
      JSON.stringify({
        schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
        controllers: [
          { ...record, id: 'not-an-id' },
          { ...record, tokenHash: 'zz' },
          { ...record, label: '' },
          { ...record, createdAt: 'yesterday' },
          null,
          record,
        ],
      }),
    );
    expect(readPeerControllerRegistrySync(registryPath).controllers).toEqual([
      record,
    ]);
  });
});

describe('matchControllerToken', () => {
  it('names the grant a token belongs to, and nothing else', async () => {
    const { record, token } = await addPeerController('voice', registryPath);
    await addPeerController('other', registryPath);
    const registry = readPeerControllerRegistrySync(registryPath);

    const matched = matchControllerToken(registry, token);
    expect(matched).toEqual({ id: record.id, label: 'voice' });
    // The hash is a credential's shadow and has no business travelling
    // with a message.
    expect(matched).not.toHaveProperty('tokenHash');
  });

  it('rejects a token no grant holds', async () => {
    await addPeerController('voice', registryPath);
    const registry = readPeerControllerRegistrySync(registryPath);
    expect(
      matchControllerToken(registry, mintControllerToken()),
    ).toBeUndefined();
  });

  it('rejects a token without the prefix', async () => {
    const { token } = await addPeerController('voice', registryPath);
    const registry = readPeerControllerRegistrySync(registryPath);
    expect(
      matchControllerToken(
        registry,
        token.slice(CONTROLLER_TOKEN_PREFIX.length),
      ),
    ).toBeUndefined();
  });

  it('rejects an oversized presentation without hashing it', async () => {
    await addPeerController('voice', registryPath);
    const registry = readPeerControllerRegistrySync(registryPath);
    expect(
      matchControllerToken(
        registry,
        CONTROLLER_TOKEN_PREFIX + 'x'.repeat(1024 * 1024),
      ),
    ).toBeUndefined();
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
    const { record, token } = await addPeerController('voice', registryPath);
    expect(resolveControllerToken(token, registryPath)).toEqual({
      id: record.id,
      label: 'voice',
    });

    await removePeerController(record.id, registryPath);
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
