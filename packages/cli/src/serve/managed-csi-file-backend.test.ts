/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import fsSync, { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedCsiFileBackend } from './managed-csi-file-backend.js';
import { composeManagedCsiFiles } from './managed-csi-file-composer.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import type { ManagedCsiMount } from './managed-csi-mount.js';
import type { ManagedCsiMountReceipt } from './managed-csi-envelope.js';
import { isModifiableDeclarativeTool } from '@qwen-code/qwen-code-core/tools/modifiable-tool.js';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';

const native = {
  open: fs.open,
  mkdir: fs.mkdir,
  lstat: fs.lstat,
  readdir: fs.readdir,
};
const signal = new AbortController().signal;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// This mapping fixture exercises real inodes and handles on Darwin. Only the
// separately labelled Linux group exercises actual /proc/self/fd addressing.
async function fixture(mapped: boolean) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'csi-file-backend-')),
  );
  const root = await native.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const rootStats = await root.stat({ bigint: true });
  const receipt = {
    rootDevice: rootStats.dev.toString(),
    rootInode: rootStats.ino.toString(),
  } as ManagedCsiMountReceipt;
  const owner = randomUUID();
  const addresses = new Map<number, string>([[root.fd, directory]]);
  const opened: Array<{
    handle: FileHandle;
    address: string;
    rawAddress: string;
    close: ReturnType<typeof vi.spyOn>;
  }> = [];
  const backends: ManagedCsiFileBackend[] = [];
  const compositions: Array<
    Awaited<ReturnType<typeof composeManagedCsiFiles>>
  > = [];
  let onOpened: ((handle: FileHandle, address: string) => void) | undefined;
  const oldPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  if (mapped)
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
  const address = (input: Parameters<typeof fs.lstat>[0]) => {
    if (!mapped || typeof input !== 'string') return input;
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(input);
    if (!match) return input;
    const parent = addresses.get(Number(match[1]));
    if (!parent) throw new Error('Fixture received an unknown fd.');
    return match[2] ? path.join(parent, match[2]) : parent;
  };
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const resolved = address(file);
    const handle = await native.open(resolved, flags, mode);
    addresses.set(handle.fd, String(resolved));
    opened.push({
      handle,
      address: String(resolved),
      rawAddress: String(file),
      close: vi.spyOn(handle, 'close'),
    });
    onOpened?.(handle, String(file));
    return handle;
  });
  if (mapped) {
    vi.spyOn(fs, 'lstat').mockImplementation(((file, options) =>
      native.lstat(address(file), options)) as typeof fs.lstat);
    vi.spyOn(fs, 'mkdir').mockImplementation(((file, options) =>
      native.mkdir(address(file), options)) as typeof fs.mkdir);
    vi.spyOn(fs, 'readdir').mockImplementation(((file) =>
      native.readdir(address(file))) as typeof fs.readdir);
  }
  let rootClosed = false;
  let closing: Promise<void> | undefined;
  const mount = {
    rootDirectory: vi.fn(async () => directory),
    withVerifiedRoot: vi.fn(
      async <T>(
        operation: (
          handle: FileHandle,
          value: ManagedCsiMountReceipt,
        ) => Promise<T>,
      ) => {
        if (rootClosed) throw new Error('Fixture original mount is closed.');
        const check = async () => {
          const named = await native.lstat(directory, { bigint: true });
          const current = await root.stat({ bigint: true });
          if (named.ino !== rootStats.ino || current.ino !== rootStats.ino)
            throw new Error('Fixture original mount changed.');
        };
        await check();
        try {
          return await operation(root, receipt);
        } finally {
          await check();
        }
      },
    ),
    close: vi.fn(() => {
      rootClosed = true;
      closing ??= root.close();
      return closing;
    }),
  } as unknown as ManagedCsiMount;
  onTestFinished(async () => {
    try {
      await Promise.allSettled([
        ...compositions.map((composition) => composition.close()),
        ...backends.map((backend) => backend.close()),
      ]);
      for (const entry of opened) {
        expect(entry.close).toHaveBeenCalledTimes(1);
        await expect(entry.handle.stat()).rejects.toMatchObject({
          code: 'EBADF',
        });
      }
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      if (mapped) Object.defineProperty(process, 'platform', oldPlatform);
      if (!rootClosed) await root.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return {
    onOpened: (operation: (handle: FileHandle, address: string) => void) => {
      onOpened = operation;
    },
    directory,
    owner,
    mount,
    opened,
    file: (name: string) => path.join(directory, name),
    backup: (name: string) =>
      path.join(directory, '.qwen-csi-file-history', owner, name),
    async open() {
      const backend = await ManagedCsiFileBackend.open(mount, owner);
      backends.push(backend);
      return backend;
    },
    async compose() {
      const composition = await composeManagedCsiFiles({
        mount,
        ownerSessionId: owner,
        runtimeSessionId: owner,
        profile: 'csi-files-retirement/1',
        capabilityDigest: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
      });
      compositions.push(composition);
      return composition;
    },
  };
}

function cases(mapped: boolean) {
  it('creates one owner and inspects genuine absence without creating working parents', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    expect(
      await backend.textFileIo.inspect(owned.file('missing/leaf')),
    ).toEqual({ kind: 'missing' });
    await expect(native.lstat(owned.file('missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await backend.observeRetained()).toMatchObject({
      retainedBackups: [],
      backupDirectory: {
        volumeDevice: expect.any(String),
        directoryInode: expect.any(String),
      },
    });
    expect(owned.opened).toHaveLength(2);
    expect(owned.opened[0].rawAddress).toMatch(
      /^\/proc\/self\/fd\/\d+\/\.qwen-csi-file-history$/,
    );
    expect(owned.opened[1].rawAddress).toBe(
      `/proc/self/fd/${owned.opened[0].handle.fd}/${owned.owner}`,
    );
    expect(
      await Promise.all(
        owned.opened.map((entry) => fs.realpath(entry.address)),
      ),
    ).toEqual([
      owned.file('.qwen-csi-file-history'),
      owned.file(`.qwen-csi-file-history/${owned.owner}`),
    ]);
  });

  it('retains raw original pins, permissions and unchanged backups across real history reuse', async () => {
    const owned = await fixture(mapped);
    const file = owned.file('raw');
    const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    await fs.writeFile(file, bytes, { mode: 0o640 });
    const composed = await owned.compose();
    expect([...composed.tools.tools.keys()].sort()).toEqual([
      'edit',
      'read_file',
      'write_file',
    ]);
    await composed.history.prepare('first', ['raw']);
    const first = await composed.observe();
    expect(first.storage.retainedBackups).toHaveLength(1);
    const pin = first.storage.retainedBackups[0];
    expect(pin).toMatchObject({
      digest: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mode: 0o640,
    });
    expect(await fs.readFile(owned.backup(pin.name))).toEqual(bytes);
    await composed.history.prepare('second', ['raw']);
    const second = await composed.observe();
    expect(second.storage.retainedBackups).toEqual(
      first.storage.retainedBackups,
    );
    expect(second.history.snapshots[1].trackedFileBackups['raw']).toEqual(
      first.history.snapshots[0].trackedFileBackups['raw'],
    );
    await expect(composed.history.rewind('first')).rejects.toThrow(
      'cannot rewind',
    );
  });

  it('writes through the scoped original inode and creates new parents exclusively', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    const file = owned.file('a');
    await fs.writeFile(file, 'before');
    const original = await fs.stat(file, { bigint: true });
    const stats = await backend.textFileIo.withMutation(
      file,
      signal,
      async (mutation) => {
        expect(mutation.original).toMatchObject({
          kind: 'file',
          response: { content: 'before' },
        });
        return mutation.write({ path: file, content: 'after' });
      },
    );
    expect(BigInt(stats.ino)).toBe(original.ino);
    expect(await fs.readFile(file, 'utf8')).toBe('after');
    const created = owned.file('one/two/new');
    await backend.textFileIo.withMutation(created, signal, (mutation) =>
      mutation.write({ path: created, content: 'new' }),
    );
    expect(await fs.readFile(created, 'utf8')).toBe('new');
    await expect(
      backend.writeTextFile({ path: file, content: 'fallback' }),
    ).rejects.toThrow('scoped');
    expect(() => backend.findFiles('*', [owned.directory])).toThrow('glob');
  });

  it.each(['replace', 'change', 'hardlink'])(
    'refuses %s of an original backup without repinning',
    async (change) => {
      const owned = await fixture(mapped);
      const backend = await owned.open();
      const file = owned.file('a');
      await fs.writeFile(file, 'original');
      const backup = await backend.createBackup(file, 1);
      const leaf = owned.backup(backup.backupFileName!);
      if (change === 'replace') {
        await fs.rename(leaf, owned.file('saved-original'));
        await fs.writeFile(leaf, 'original');
      } else if (change === 'change') await fs.writeFile(leaf, 'changed!');
      else await fs.link(leaf, owned.file('alias'));
      await expect(
        backend.withBackupFile(backup.backupFileName!, async () => 'adopted'),
      ).rejects.toThrow();
      expect(backend.getDrainInspection().blocked).toBe(true);
      await expect(backend.close()).rejects.toThrow();
      await expect(backend.readTextFile({ path: file })).rejects.toThrow();
    },
  );

  it('denies original backup aliases before working bytes and allows ordinary hardlinks', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    const file = owned.file('a');
    await fs.writeFile(file, 'original');
    await fs.link(file, owned.file('ordinary-alias'));
    expect((await backend.readTextFile({ path: file })).content).toBe(
      'original',
    );
    const backup = await backend.createBackup(file, 1);
    await fs.link(
      owned.backup(backup.backupFileName!),
      owned.file('backup-alias'),
    );
    await expect(
      backend.textFileIo.inspect(owned.file('backup-alias')),
    ).rejects.toThrow('alias');
    await expect(backend.close()).rejects.toThrow();
    expect(
      await fs.readFile(owned.backup(backup.backupFileName!), 'utf8'),
    ).toBe('original');
  });

  it('retains a failed partial backup and closes its acquired fd after the group fails', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    await fs.writeFile(owned.file('a'), 'original bytes');
    owned.onOpened((handle, address) => {
      if (address.includes('@v')) {
        const actualWrite = handle.write.bind(handle);
        let count = 0;
        vi.spyOn(handle, 'write').mockImplementation((async (
          bytes: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (count++) throw new Error('partial copy failed');
          return actualWrite(bytes, offset, Math.min(3, length), position);
        }) as typeof handle.write);
      }
    });
    await expect(backend.createBackup(owned.file('a'), 1)).rejects.toThrow(
      'partial copy failed',
    );
    await expect(backend.close()).rejects.toThrow();
    const names = await native.readdir(
      owned.file(`.qwen-csi-file-history/${owned.owner}`),
    );
    expect(names).toHaveLength(1);
    expect(await fs.readFile(owned.backup(names[0]), 'utf8')).toBe('ori');
    await expect(backend.observeRetained()).rejects.toThrow();
  });

  it('joins a writer started without awaiting it and fences escaped writers', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    const file = owned.file('a');
    let escaped!: Parameters<
      Parameters<typeof backend.textFileIo.withMutation>[2]
    >[0]['write'];
    await backend.textFileIo.withMutation(file, signal, async (mutation) => {
      escaped = mutation.write;
      void mutation.write({ path: file, content: 'joined' });
    });
    expect(await fs.readFile(file, 'utf8')).toBe('joined');
    await expect(escaped({ path: file, content: 'escaped' })).rejects.toThrow(
      'not available',
    );
    expect(await fs.readFile(file, 'utf8')).toBe('joined');
  });

  it('joins close behind the complete callback and closes retained handles once', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    const file = owned.file('a');
    await fs.writeFile(file, 'original');
    const entered = deferred();
    const release = deferred();
    const operation = backend.withWorkingFile(file, async (source) => {
      expect(source).not.toBeNull();
      entered.resolve();
      await release.promise;
      expect((await source!.fileHandle.stat()).size).toBe(8);
    });
    await entered.promise;
    const closing = backend.close();
    expect(backend.close()).toBe(closing);
    await expect(backend.withWorkingFile(file, async () => {})).rejects.toThrow(
      'unavailable',
    );
    expect(
      owned.opened.every((entry) => entry.close.mock.calls.length === 0),
    ).toBe(true);
    release.resolve();
    await operation;
    await closing;
    expect(backend.getDrainInspection()).toEqual({
      pendingOperations: 0,
      blocked: false,
      closed: true,
    });
  });

  it.each(['symlink', 'directory', 'reserved'])(
    'refuses %s paths without legacy fallback',
    async (kind) => {
      const owned = await fixture(mapped);
      const backend = await owned.open();
      const file =
        kind === 'reserved'
          ? owned.file(`.qwen-csi-file-history/${owned.owner}/x`)
          : owned.file('a');
      if (kind === 'symlink') await fs.symlink(owned.directory, file);
      if (kind === 'directory') await fs.mkdir(file);
      await expect(async () =>
        backend.textFileIo.inspect(file),
      ).rejects.toThrow();
      if (kind !== 'reserved') await expect(backend.close()).rejects.toThrow();
      else expect(backend.getDrainInspection().blocked).toBe(false);
    },
  );

  it('refuses an existing empty owner and closes a prefix acquired before owner bind fails', async () => {
    const owned = await fixture(mapped);
    await fs.mkdir(owned.file(`.qwen-csi-file-history/${owned.owner}`), {
      recursive: true,
    });
    await expect(owned.open()).rejects.toThrow();
    expect(
      await native.readdir(owned.file(`.qwen-csi-file-history/${owned.owner}`)),
    ).toEqual([]);
  });

  it('closes an acquired directory when its initial fstat fails', async () => {
    const owned = await fixture(mapped);
    owned.onOpened((handle, address) => {
      if (address.endsWith('/.qwen-csi-file-history'))
        vi.spyOn(handle, 'stat').mockRejectedValue(
          new Error('initial directory fstat failed'),
        );
    });
    await expect(owned.open()).rejects.toThrow();
    vi.mocked(owned.opened[0].handle.stat).mockRestore();
    expect(owned.opened[0].close).toHaveBeenCalledTimes(1);
  });

  it('joins short source reads and destination writes without truncating the backup', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    const bytes = Buffer.from('complete raw bytes');
    await fs.writeFile(owned.file('a'), bytes);
    owned.onOpened((handle, address) => {
      if (address.endsWith('/a')) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) =>
          read(
            buffer,
            offset,
            Math.min(length, 2),
            position,
          )) as typeof handle.read);
      }
      if (address.includes('@v')) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) =>
          write(
            buffer,
            offset,
            Math.min(length, 2),
            position,
          )) as typeof handle.write);
      }
    });
    const result = await backend.createBackup(owned.file('a'), 1);
    expect(await fs.readFile(owned.backup(result.backupFileName!))).toEqual(
      bytes,
    );
    expect((await backend.observeRetained()).retainedBackups[0].digest).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('joins original backup registration before another operation admits an inode alias', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    await fs.writeFile(owned.file('a'), 'raw');
    const opened = deferred();
    const release = deferred();
    owned.onOpened((handle, address) => {
      if (address.includes('@v')) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation((async (
          options?: Parameters<typeof handle.stat>[0],
        ) => {
          opened.resolve();
          await release.promise;
          return stat(options);
        }) as typeof handle.stat);
      }
    });
    const copy = backend.createBackup(owned.file('a'), 1);
    void copy.catch(() => {});
    await opened.promise;
    const names = await native.readdir(
      owned.file(`.qwen-csi-file-history/${owned.owner}`),
    );
    await fs.link(owned.backup(names[0]), owned.file('alias'));
    let settled = false;
    const alias = backend.textFileIo
      .inspect(owned.file('alias'))
      .finally(() => {
        settled = true;
      });
    void alias.catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(alias).rejects.toThrow();
    await expect(copy).rejects.toThrow();
    await expect(backend.close()).rejects.toThrow();
  });

  it('retains the original raw bytes after sync fails and refuses qualification', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    await fs.writeFile(owned.file('a'), 'raw');
    owned.onOpened((handle, address) => {
      if (address.includes('@v'))
        vi.spyOn(handle, 'sync').mockRejectedValue(
          new Error('backup sync failed'),
        );
    });
    await expect(backend.createBackup(owned.file('a'), 1)).rejects.toThrow(
      'backup sync failed',
    );
    await expect(backend.close()).rejects.toThrow();
    const names = await native.readdir(
      owned.file(`.qwen-csi-file-history/${owned.owner}`),
    );
    expect(names).toHaveLength(1);
    expect(await fs.readFile(owned.backup(names[0]), 'utf8')).toBe('raw');
    await expect(backend.observeRetained()).rejects.toThrow();
  });

  it('refuses a renamed parent after the complete callback', async () => {
    const owned = await fixture(mapped);
    const backend = await owned.open();
    await fs.mkdir(owned.file('parent'));
    await fs.writeFile(owned.file('parent/a'), 'original');
    await expect(
      backend.withWorkingFile(owned.file('parent/a'), async () => {
        await fs.rename(owned.file('parent'), owned.file('moved-parent'));
        await fs.mkdir(owned.file('parent'));
        await fs.writeFile(owned.file('parent/a'), 'replacement');
      }),
    ).rejects.toThrow();
    await expect(backend.close()).rejects.toThrow();
    expect(await fs.readFile(owned.file('moved-parent/a'), 'utf8')).toBe(
      'original',
    );
  });

  it('rejects a mismatched profile before any mount observation', async () => {
    const owned = await fixture(mapped);
    await expect(
      composeManagedCsiFiles({
        mount: owned.mount,
        ownerSessionId: owned.owner,
        runtimeSessionId: owned.owner,
        profile: 'wrong',
        capabilityDigest: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
      }),
    ).rejects.toThrow('identity');
    expect(owned.mount.withVerifiedRoot).not.toHaveBeenCalled();
    expect(owned.opened).toEqual([]);
  });

  it('previews actual Write/Edit without creating missing parents', async () => {
    const owned = await fixture(mapped);
    const composed = await owned.compose();
    const file = owned.file('missing/leaf');
    for (const name of ['write_file', 'edit']) {
      const tool = composed.tools.tools.get(name)!;
      if (!isModifiableDeclarativeTool(tool))
        throw new Error('Expected the actual modifiable file tool.');
      const context = tool.getModifyContext(signal);
      const params =
        name === 'write_file'
          ? { file_path: file, content: 'new' }
          : { file_path: file, old_string: '', new_string: 'new' };
      expect(await context.getCurrentContent(params)).toBe('');
      expect(await context.getProposedContent(params)).toBe(
        name === 'write_file' ? 'new' : '',
      );
    }
    await expect(native.lstat(owned.file('missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await composed.observe()).storage.retainedBackups).toEqual([]);
  });

  it('preserves actual UTF-16 BOM/CRLF edits and the original raw history bytes', async () => {
    const owned = await fixture(mapped);
    const file = owned.file('encoded.txt');
    const before = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('alpha\r\nsecond\r\n', 'utf16le'),
    ]);
    await fs.writeFile(file, before);
    const composed = await owned.compose();
    await composed.history.prepare('prompt', ['encoded.txt']);
    const result = await composed.history.execute('encoded.txt', () =>
      composed.tools.tools
        .get('edit')!
        .build({ file_path: file, old_string: 'alpha', new_string: 'beta' })
        .execute(signal),
    );
    expect(result.error).toBeUndefined();
    expect(await fs.readFile(file)).toEqual(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('beta\r\nsecond\r\n', 'utf16le'),
      ]),
    );
    const observation = await composed.observe();
    expect(
      await fs.readFile(
        owned.backup(observation.storage.retainedBackups[0].name),
      ),
    ).toEqual(before);
  });

  it('restores history metadata after failed preparation while keeping successful and partial originals', async () => {
    const owned = await fixture(mapped);
    await fs.writeFile(owned.file('a'), 'one');
    await fs.writeFile(owned.file('b'), 'two');
    const composed = await owned.compose();
    await composed.history.prepare('first', ['a']);
    const first = composed.history.state();
    await composed.history.execute('a', () =>
      composed.tools.tools
        .get('write_file')!
        .build({ file_path: owned.file('a'), content: 'changed' })
        .execute(signal),
    );
    const previous = composed.history.state();
    let count = 0;
    owned.onOpened((handle, address) => {
      if (address.includes('@v') && ++count === 2)
        vi.spyOn(handle, 'sync').mockRejectedValue(
          new Error('new backup sync failed'),
        );
    });
    await expect(composed.history.prepare('second', ['b'])).rejects.toThrow();
    expect(composed.history.state()).toEqual(previous);
    expect(composed.history.state().snapshots).toEqual(first.snapshots);
    const leaves = await native.readdir(
      owned.file(`.qwen-csi-file-history/${owned.owner}`),
    );
    expect(leaves).toHaveLength(3);
    expect(
      await fs.readFile(
        owned.backup(
          first.snapshots[0].trackedFileBackups['a'].backupFileName!,
        ),
        'utf8',
      ),
    ).toBe('one');
    await expect(composed.close()).rejects.toThrow();
  });

  it('keeps the actual team-memory secret guard without private pathname discovery', async () => {
    const owned = await fixture(mapped);
    const composed = await owned.compose();
    const file = owned.file('.qwen/team-memory/feedback.md');
    const secret = `ghp_${'a'.repeat(36)}`;
    for (const name of ['write_file', 'edit']) {
      const tool = composed.tools.tools.get(name)!;
      const params =
        name === 'write_file'
          ? { file_path: file, content: secret }
          : { file_path: file, old_string: '', new_string: secret };
      expect(() => tool.build(params)).toThrow(/team memory is shared/i);
    }
    const result = await composed.tools.tools
      .get('write_file')!
      .build({ file_path: file, content: 'safe note' })
      .execute(signal);
    expect(result.error).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe('safe note');
    expect((await composed.observe()).storage.retainedBackups).toEqual([]);
  });

  it('uses actual Read, Write and Edit with prepared history and no pathname mkdir or post-stat', async () => {
    const owned = await fixture(mapped);
    const composed = await owned.compose();
    const file = owned.file('nested/created.html');
    await composed.history.prepare('prompt', ['nested/created.html']);
    const tools = composed.tools.tools;
    const metadata = [
      vi.spyOn(fsSync, 'existsSync').mockName('existsSync'),
      vi.spyOn(fsSync, 'lstatSync').mockName('lstatSync'),
      vi.spyOn(fsSync, 'statSync').mockName('statSync'),
      vi.spyOn(fsSync, 'realpathSync').mockName('realpathSync'),
      vi.spyOn(fsSync, 'mkdirSync').mockName('mkdirSync'),
      vi.spyOn(fsSync, 'readlinkSync').mockName('readlinkSync'),
    ];
    syncBuiltinESMExports();
    const namedFs = await import('node:fs');
    namedFs.existsSync(file);
    namedFs.realpathSync(owned.directory);
    expect(metadata[0]).toHaveBeenCalledWith(file);
    expect(metadata[3]).toHaveBeenCalledWith(owned.directory);
    for (const observation of metadata) observation.mockClear();
    const run = async (tool: AnyDeclarativeTool, params: object) => {
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');
      if (tool.name !== 'read_file')
        await invocation.getConfirmationDetails(signal);
      return invocation.execute(signal);
    };
    const first = await composed.history.execute('nested/created.html', () =>
      run(tools.get('write_file')!, {
        file_path: file,
        content: 'alpha\r\nsecond\r\n',
      }),
    );
    expect(first.error).toBeUndefined();
    expect(first.artifacts).toEqual([
      expect.objectContaining({
        storage: 'workspace',
        workspacePath: 'nested/created.html',
        sizeBytes: Buffer.byteLength('alpha\r\nsecond\r\n'),
      }),
    ]);
    const before = await run(tools.get('read_file')!, { file_path: file });
    expect(before.error).toBeUndefined();
    expect(JSON.stringify(before.llmContent)).toContain('alpha');
    const edited = await composed.history.execute('nested/created.html', () =>
      run(tools.get('edit')!, {
        file_path: file,
        old_string: 'alpha',
        new_string: 'beta',
      }),
    );
    expect(edited.error).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe('beta\r\nsecond\r\n');
    await composed.history.prepare('next', ['nested/created.html']);
    expect((await composed.observe()).storage.retainedBackups).toHaveLength(1);
    expect(
      (await composed.history.history.service.getDiffStats('prompt'))
        ?.filesChanged,
    ).toEqual([file]);
    expect(
      (await composed.history.history.service.getTurnDiff('prompt'))?.files[0]
        ?.isNewFile,
    ).toBe(true);
    for (const observation of metadata)
      expect(
        observation.mock.calls.filter(([candidate]) => {
          const value = String(candidate);
          return (
            value === owned.directory || value.startsWith(owned.directory + '/')
          );
        }),
      ).toEqual([]);
  });
}

describe.runIf(process.platform !== 'win32')(
  'CSI backend mapped inode fixture (not Linux/CSI qualification)',
  () => {
    cases(true);
  },
);
describe.runIf(process.platform === 'linux')(
  'CSI backend native Linux directory-fd fixture (not CSI qualification)',
  () => {
    cases(false);
  },
);
