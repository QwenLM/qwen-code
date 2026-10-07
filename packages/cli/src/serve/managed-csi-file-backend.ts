/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  promises as fs,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeTextFileContentAsync,
  detectLineEnding,
  type CoreReadTextFileRequest,
  type CoreWriteTextFileRequest,
  type FileSystemService,
  type ReadTextFileResponse,
  type TextFileIo,
  type TextFileMutation,
  type TextFileObservation,
} from '@qwen-code/qwen-code-core/services/fileSystemService.js';
import type {
  FileHistoryBackup,
  RetainedFileHistoryStorage,
} from '@qwen-code/qwen-code-core/services/fileHistoryService.js';
import {
  digestFileReadSource,
  FileReadOpenError,
  readFileHandleBytes,
  type DescriptorFileReadSource,
  type FileReadRequest,
  type FileReadSource,
} from '@qwen-code/qwen-code-core/utils/file-read-source.js';
import { decodeBufferWithEncodingInfoAsync } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { readTextContentRangeFromHandle } from '@qwen-code/qwen-code-core/utils/read-text-range.js';
import type { ManagedCsiMountReceipt } from './managed-csi-envelope.js';
import type { ManagedCsiMount } from './managed-csi-mount.js';

const PREFIX = '.qwen-csi-file-history';
const UNAVAILABLE = 'Managed CSI file backend is unavailable.';
const DIR_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Entry {
  handle: FileHandle;
  address: string;
  stats: BigIntStats;
}

export interface ManagedCsiBackupPin {
  readonly name: string;
  readonly device: string;
  readonly inode: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly mode: number;
}

interface Attempt {
  readonly name: string;
  handle?: FileHandle;
  stats?: BigIntStats;
  pin?: ManagedCsiBackupPin;
}

interface WorkingFile {
  readonly root: FileHandle;
  readonly receipt: ManagedCsiMountReceipt;
  readonly parents: Entry[];
  readonly owned: FileHandle[];
  parent: FileHandle;
  missing: string[];
  leaf?: Entry;
}

export class ManagedCsiFileBackend
  implements FileSystemService, RetainedFileHistoryStorage
{
  readonly textFileIo: TextFileIo;
  readonly #directories: Entry[] = [];
  readonly #directoryHandles: FileHandle[] = [];
  readonly #attempts = new Map<string, Attempt>();
  readonly #pending = new Set<Promise<void>>();
  #inventoryTail: Promise<void> = Promise.resolve();
  #binding: Promise<void> | undefined;
  #receipt: ManagedCsiMountReceipt | undefined;
  #closed = false;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  private constructor(
    readonly mount: ManagedCsiMount,
    readonly directory: string,
    readonly ownerSessionId: string,
  ) {
    this.textFileIo = {
      inspect: (file, signal) => this.inspect(file, signal),
      withMutation: <T>(
        file: string,
        signal: AbortSignal,
        operation: (mutation: TextFileMutation) => Promise<T>,
      ) => this.withMutation(file, signal, operation),
    };
  }

  static async open(
    mount: ManagedCsiMount,
    ownerSessionId: string,
  ): Promise<ManagedCsiFileBackend> {
    if (process.platform !== 'linux' || !UUID.test(ownerSessionId))
      throw new Error(UNAVAILABLE);
    const directory = await mount.rootDirectory();
    if (!directory) throw new Error(UNAVAILABLE);
    const backend = new ManagedCsiFileBackend(mount, directory, ownerSessionId);
    try {
      await backend.run(async () => {});
      return backend;
    } catch (error) {
      try {
        await backend.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], UNAVAILABLE);
      }
      throw error;
    }
  }

  getDrainInspection(): {
    pendingOperations: number;
    blocked: boolean;
    closed: boolean;
  } {
    return {
      pendingOperations: this.#pending.size,
      blocked: this.#failure !== undefined,
      closed: this.#closed,
    };
  }

  async observeRetained(): Promise<{
    backupDirectory: {
      volumeDevice: string;
      volumeInode: string;
      directoryDevice: string;
      directoryInode: string;
    };
    retainedBackups: ManagedCsiBackupPin[];
  }> {
    if (this.#pending.size)
      throw new Error('Retained observation requires an idle backend.');
    return this.run(async () => {
      const retainedBackups: ManagedCsiBackupPin[] = [];
      for (const name of [...this.#attempts.keys()].sort()) {
        const attempt = this.#attempts.get(name)!;
        await this.authenticate(attempt);
        retainedBackups.push({ ...attempt.pin! });
      }
      if (this.#pending.size !== 1)
        throw new Error('Retained observation requires an idle backend.');
      const directory = this.#directories[1];
      return {
        backupDirectory: {
          volumeDevice: this.#receipt!.rootDevice,
          volumeInode: this.#receipt!.rootInode,
          directoryDevice: directory.stats.dev.toString(),
          directoryInode: directory.stats.ino.toString(),
        },
        retainedBackups,
      };
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      await Promise.all(this.#pending);
      const handles = [
        ...[...this.#attempts.values()].flatMap((attempt) =>
          attempt.handle ? [attempt.handle] : [],
        ),
        ...this.#directoryHandles.slice().reverse(),
      ];
      const results = await Promise.allSettled(
        handles.map(async (handle) => handle.close()),
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (this.#failure) errors.unshift(this.#failure);
      if (errors.length) throw new AggregateError(errors, UNAVAILABLE);
    })();
    return this.#closing;
  }

  withWorkingFile<T>(
    file: string,
    operation: (source: DescriptorFileReadSource | null) => Promise<T>,
  ): Promise<T> {
    const components = this.components(file);
    return this.run((root, receipt) =>
      this.working(root, receipt, components, false, async (working) =>
        operation(working.leaf ? await this.source(working.leaf) : null),
      ),
    );
  }

  withBackupFile<T>(
    name: string,
    operation: (source: DescriptorFileReadSource) => Promise<T>,
  ): Promise<T> {
    if (!validLeaf(name))
      return Promise.reject(new Error('Invalid retained backup name.'));
    return this.run(async () => {
      const attempt = this.#attempts.get(name);
      if (!attempt) throw this.fault(new Error('Unknown retained backup.'));
      await this.authenticate(attempt);
      try {
        return await operation(await this.backupSource(attempt));
      } finally {
        await this.authenticate(attempt);
      }
    });
  }

  createBackup(file: string, version: number): Promise<FileHistoryBackup> {
    const components = this.components(file);
    if (!Number.isSafeInteger(version) || version < 1)
      return Promise.reject(new Error('Invalid backup version.'));
    return this.run((root, receipt) =>
      this.working(root, receipt, components, false, async (working) => {
        if (!working.leaf)
          return { backupFileName: null, version, backupTime: new Date() };
        const source = await this.source(working.leaf);
        const name = `${randomUUID()}@v${version}`;
        const attempt: Attempt = { name };
        const address = this.backupAddress(name);
        try {
          await this.withInventory(async () => {
            this.#attempts.set(name, attempt);
            attempt.handle = await fs.open(
              address,
              constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
              0o600,
            );
            attempt.stats = await attempt.handle.stat({ bigint: true });
            this.requireFile(attempt.stats, receipt.rootDevice);
          });
          const handle = attempt.handle!;
          const digest = createHash('sha256');
          const bytes = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position < source.stats.size) {
            const { bytesRead } = await source.fileHandle.read(
              bytes,
              0,
              Math.min(bytes.length, source.stats.size - position),
              position,
            );
            if (bytesRead === 0)
              throw new Error('Source changed during backup.');
            const chunk = bytes.subarray(0, bytesRead);
            digest.update(chunk);
            await this.writeBytes(handle, chunk, position);
            position += bytesRead;
          }
          const rawDigest = digest.digest('hex');
          if ((await digestFileReadSource(source)) !== rawDigest)
            throw new Error('Source changed during backup.');
          await handle.chmod(source.stats.mode & 0o7777);
          await handle.sync();
          await this.#directories[1].handle.sync();
          const final = await handle.stat({ bigint: true });
          if (
            !sameInode(final, attempt.stats!) ||
            final.size !== BigInt(source.stats.size) ||
            final.nlink !== 1n
          )
            throw new Error(UNAVAILABLE);
          const pin = Object.freeze({
            name,
            device: final.dev.toString(),
            inode: final.ino.toString(),
            byteLength: source.stats.size,
            digest: rawDigest,
            mode: Number(final.mode & 0o7777n),
          });
          attempt.pin = pin;
          await this.authenticate(attempt);
          return { backupFileName: name, version, backupTime: new Date() };
        } catch (error) {
          throw this.fault(error);
        }
      }),
    );
  }

  withReadFile<T>(
    request: FileReadRequest,
    operation: (source: FileReadSource) => Promise<T>,
  ): Promise<T> {
    request.signal?.throwIfAborted();
    return this.withWorkingFile(request.path, async (source) => {
      request.signal?.throwIfAborted();
      if (!source)
        throw new FileReadOpenError(
          Object.assign(new Error('File not found.'), { code: 'ENOENT' }),
        );
      return operation(source);
    });
  }

  readTextFile(params: CoreReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.withWorkingFile(params.path, async (source) => {
      if (!source)
        throw Object.assign(new Error('File not found.'), { code: 'ENOENT' });
      if (
        (params.line ?? 0) > 0 ||
        Number.isFinite(params.limit) ||
        params.maxOutputBytes !== undefined
      ) {
        const { content, ...metadata } = await readTextContentRangeFromHandle(
          source.fileHandle,
          {
            fileSize: source.stats.size,
            offset: params.line ?? 0,
            limit: params.limit ?? Infinity,
            maxOutputBytes: params.maxOutputBytes ?? 256 * 1024,
            maxScanBytes: source.stats.size,
            signal: params.signal,
          },
        );
        return { content, _meta: metadata };
      }
      return this.text(source, params.signal);
    });
  }

  async writeTextFile(_params: CoreWriteTextFileRequest): Promise<never> {
    throw new Error(
      'Managed CSI text writes require the scoped mutation writer.',
    );
  }

  findFiles(_fileName: string, _searchPaths: readonly string[]): string[] {
    throw new Error('Managed CSI file tools do not support pathname glob.');
  }

  private inspect(
    file: string,
    signal?: AbortSignal,
  ): Promise<TextFileObservation> {
    signal?.throwIfAborted();
    return this.withWorkingFile(file, async (source) =>
      source
        ? {
            kind: 'file',
            response: await this.text(source, signal),
            stats: source.stats,
          }
        : { kind: 'missing' },
    );
  }

  private withMutation<T>(
    file: string,
    signal: AbortSignal,
    operation: (mutation: TextFileMutation) => Promise<T>,
  ): Promise<T> {
    const components = this.components(file);
    signal.throwIfAborted();
    return this.run((root, receipt) =>
      this.working(root, receipt, components, true, async (working) => {
        const source = working.leaf ? await this.source(working.leaf) : null;
        const original: TextFileObservation = source
          ? {
              kind: 'file',
              response: await this.text(source, signal),
              stats: source.stats,
            }
          : { kind: 'missing' };
        let active = true;
        let write: Promise<Stats> | undefined;
        try {
          return await operation({
            original,
            write: (params) => {
              if (!active || write || params.path !== file)
                return Promise.reject(
                  new Error('CSI mutation writer is not available.'),
                );
              write = this.commit(working, params, signal);
              void write.catch(() => {});
              return write;
            },
          });
        } finally {
          active = false;
          await write;
        }
      }),
    );
  }

  private async commit(
    working: WorkingFile,
    params: CoreWriteTextFileRequest,
    signal: AbortSignal,
  ): Promise<Stats> {
    signal.throwIfAborted();
    const bytes = await encodeTextFileContentAsync(
      params.path,
      params.content,
      params._meta,
    );
    signal.throwIfAborted();
    try {
      if (working.leaf) await this.verifyEntry(working.leaf, true);
      else {
        if (await this.lstat(addressOf(working.parent, working.missing[0])))
          throw new Error('CSI target appeared before mutation.');
        while (working.missing.length > 1) {
          const component = working.missing[0];
          const address = addressOf(working.parent, component);
          await fs.mkdir(address, { mode: 0o700 });
          const entry = await this.openDirectory(
            address,
            working.receipt.rootDevice,
            working.owned,
          );
          working.parents.push(entry);
          await entry.handle.sync();
          await working.parent.sync();
          working.parent = entry.handle;
          working.missing.shift();
        }
        const address = addressOf(working.parent, working.missing[0]);
        const handle = await fs.open(
          address,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        working.owned.push(handle);
        const stats = await handle.stat({ bigint: true });
        this.requireFile(stats, working.receipt.rootDevice);
        working.leaf = { handle, address, stats };
        working.missing = [];
      }
      const leaf = working.leaf;
      await this.checkAlias(leaf.stats);
      await this.writeBytes(leaf.handle, bytes, 0, signal);
      await leaf.handle.truncate(bytes.length);
      await leaf.handle.sync();
      await working.parent.sync();
      const committed = await leaf.handle.stat({ bigint: true });
      if (
        !sameInode(leaf.stats, committed) ||
        committed.mode !== leaf.stats.mode ||
        committed.size !== BigInt(bytes.length)
      )
        throw new Error(UNAVAILABLE);
      leaf.stats = committed;
      await this.verifyEntry(leaf, true);
      return (await this.source(leaf)).stats;
    } catch (error) {
      throw this.fault(error);
    }
  }

  private async text(
    source: DescriptorFileReadSource,
    signal?: AbortSignal,
  ): Promise<ReadTextFileResponse> {
    const bytes = await readFileHandleBytes(
      source.fileHandle,
      source.stats.size,
      signal,
    );
    if (bytes.length !== source.stats.size)
      throw this.fault(new Error('CSI file changed while reading.'));
    const { content, encoding, bom } =
      await decodeBufferWithEncodingInfoAsync(bytes);
    signal?.throwIfAborted();
    return {
      content,
      _meta: {
        encoding,
        bom,
        lineEnding: detectLineEnding(content),
        originalLineCount: content.split('\n').length,
        originalLineCountExact: true,
        truncatedByBytes: false,
      },
    };
  }

  private components(file: string): string[] {
    if (
      !path.isAbsolute(file) ||
      path.resolve(file) !== file ||
      !file.startsWith(this.directory + '/')
    )
      throw new Error('CSI file path is not canonical.');
    const components = file.slice(this.directory.length + 1).split('/');
    if (!components.every(validLeaf) || components[0] === PREFIX)
      throw new Error('CSI file path is reserved or invalid.');
    return components;
  }

  private async run<T>(
    operation: (
      root: FileHandle,
      receipt: ManagedCsiMountReceipt,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#closed || this.#failure)
      throw this.#failure ?? new Error(UNAVAILABLE);
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#pending.add(pending);
    try {
      return await this.mount.withVerifiedRoot(async (root, receipt) => {
        this.#binding ??= this.bind(root, receipt);
        await this.#binding;
        await this.verifyStorage();
        try {
          return await operation(root, receipt);
        } finally {
          await this.verifyStorage();
        }
      });
    } catch (error) {
      this.fault(error);
      throw error;
    } finally {
      this.#pending.delete(pending);
      complete();
    }
  }

  private async bind(
    root: FileHandle,
    receipt: ManagedCsiMountReceipt,
  ): Promise<void> {
    this.#receipt = receipt;
    try {
      const prefixAddress = addressOf(root, PREFIX);
      if (!(await this.lstat(prefixAddress))) {
        await fs.mkdir(prefixAddress, { mode: 0o700 });
        await root.sync();
      }
      const prefix = await this.openDirectory(
        prefixAddress,
        receipt.rootDevice,
        this.#directoryHandles,
      );
      this.#directories.push(prefix);
      const ownerAddress = addressOf(prefix.handle, this.ownerSessionId);
      await fs.mkdir(ownerAddress, { mode: 0o700 });
      await prefix.handle.sync();
      const owner = await this.openDirectory(
        ownerAddress,
        receipt.rootDevice,
        this.#directoryHandles,
      );
      this.#directories.push(owner);
      await owner.handle.sync();
      if ((await fs.readdir(`/proc/self/fd/${owner.handle.fd}`)).length)
        throw new Error(
          'CSI history initial bind requires an empty directory.',
        );
    } catch (error) {
      throw this.fault(error);
    }
  }

  private verifyStorage(): Promise<void> {
    return this.withInventory(async () => {
      try {
        if (this.#failure) throw this.#failure;
        for (const directory of this.#directories)
          await this.verifyEntry(directory, false);
        const owner = this.#directories[1];
        const names = (
          await fs.readdir(`/proc/self/fd/${owner.handle.fd}`)
        ).sort();
        const expected = [...this.#attempts.keys()].sort();
        if (
          names.length !== expected.length ||
          names.some((name, i) => name !== expected[i])
        )
          throw new Error('CSI history contains unknown or missing leaves.');
        for (const attempt of this.#attempts.values()) {
          if (!attempt.handle || !attempt.stats)
            throw new Error('CSI backup registration is incomplete.');
          const named = await fs.lstat(this.backupAddress(attempt.name), {
            bigint: true,
          });
          const opened = await attempt.handle.stat({ bigint: true });
          this.requireFile(named, this.#receipt!.rootDevice);
          if (
            !sameInode(named, attempt.stats) ||
            !sameInode(opened, attempt.stats)
          )
            throw new Error(UNAVAILABLE);
        }
      } catch (error) {
        throw this.fault(error);
      }
    });
  }

  private async working<T>(
    root: FileHandle,
    receipt: ManagedCsiMountReceipt,
    components: string[],
    writable: boolean,
    operation: (working: WorkingFile) => Promise<T>,
  ): Promise<T> {
    const working: WorkingFile = {
      root,
      receipt,
      parent: root,
      parents: [],
      owned: [],
      missing: components,
    };
    try {
      for (let index = 0; index < components.length - 1; index++) {
        const address = addressOf(working.parent, components[index]);
        if (!(await this.lstat(address))) break;
        const entry = await this.openDirectory(
          address,
          receipt.rootDevice,
          working.owned,
        );
        if (
          this.#directories.some((directory) =>
            sameInode(directory.stats, entry.stats),
          )
        )
          throw this.fault(
            new Error('CSI retained directory alias is forbidden.'),
          );
        working.parents.push(entry);
        working.parent = entry.handle;
        working.missing = components.slice(index + 1);
      }
      if (working.missing.length === 1) {
        const address = addressOf(working.parent, working.missing[0]);
        const before = await this.lstat(address);
        if (before) {
          this.requireFile(before, receipt.rootDevice);
          const handle = await fs.open(
            address,
            (writable ? constants.O_RDWR : constants.O_RDONLY) |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
          );
          working.owned.push(handle);
          const opened = await handle.stat({ bigint: true });
          if (!stableFile(before, opened))
            throw this.fault(new Error(UNAVAILABLE));
          await this.checkAlias(opened);
          working.leaf = { handle, address, stats: opened };
          working.missing = [];
        }
      }
      return await operation(working);
    } finally {
      try {
        await this.verifyWorking(working);
      } finally {
        await this.closeEphemeral(working.owned.reverse());
      }
    }
  }

  private async verifyWorking(working: WorkingFile): Promise<void> {
    if (working.leaf) {
      await this.verifyEntry(working.leaf, true);
      await this.checkAlias(working.leaf.stats);
    } else if (await this.lstat(addressOf(working.parent, working.missing[0])))
      throw this.fault(
        new Error('CSI missing path changed during observation.'),
      );
    for (const parent of working.parents) await this.verifyEntry(parent, false);
  }

  private async openDirectory(
    address: string,
    device: string,
    owned: FileHandle[],
  ): Promise<Entry> {
    const before = await fs.lstat(address, { bigint: true });
    if (!before.isDirectory() || before.dev.toString() !== device)
      throw this.fault(new Error(UNAVAILABLE));
    const handle = await fs.open(address, DIR_FLAGS);
    owned.push(handle);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || !sameInode(before, opened))
        throw new Error(UNAVAILABLE);
      return { handle, address, stats: opened };
    } catch (error) {
      throw this.fault(error);
    }
  }

  private async verifyEntry(entry: Entry, file: boolean): Promise<void> {
    try {
      const named = await fs.lstat(entry.address, { bigint: true });
      const opened = await entry.handle.stat({ bigint: true });
      if (
        file
          ? !stableFile(entry.stats, named) || !stableFile(entry.stats, opened)
          : !named.isDirectory() ||
            !opened.isDirectory() ||
            !sameInode(entry.stats, named) ||
            !sameInode(entry.stats, opened)
      )
        throw new Error(UNAVAILABLE);
    } catch (error) {
      throw this.fault(error);
    }
  }

  private async source(entry: Entry): Promise<DescriptorFileReadSource> {
    const stats = await entry.handle.stat();
    if (
      !Number.isSafeInteger(stats.size) ||
      stats.size < 0 ||
      BigInt(stats.size) !== entry.stats.size
    )
      throw this.fault(new Error(UNAVAILABLE));
    return { kind: 'descriptor', fileHandle: entry.handle, stats };
  }

  private async backupSource(
    attempt: Attempt,
  ): Promise<DescriptorFileReadSource> {
    return {
      kind: 'descriptor',
      fileHandle: attempt.handle!,
      stats: await attempt.handle!.stat(),
    };
  }

  private async authenticate(attempt: Attempt): Promise<void> {
    try {
      const pin = attempt.pin;
      if (!pin || !attempt.handle || !attempt.stats)
        throw new Error('CSI retained backup is incomplete.');
      const opened = await attempt.handle.stat({ bigint: true });
      const named = await fs.lstat(this.backupAddress(attempt.name), {
        bigint: true,
      });
      this.requireFile(opened, pin.device);
      if (
        !sameInode(opened, attempt.stats) ||
        !sameInode(named, attempt.stats) ||
        !named.isFile() ||
        opened.size !== BigInt(pin.byteLength) ||
        named.size !== opened.size ||
        opened.mode !== named.mode ||
        Number(opened.mode & 0o7777n) !== pin.mode ||
        opened.nlink !== 1n ||
        (await digestFileReadSource(await this.backupSource(attempt))) !==
          pin.digest
      )
        throw new Error('CSI retained backup pin changed.');
    } catch (error) {
      throw this.fault(error);
    }
  }

  private checkAlias(stats: BigIntStats): Promise<void> {
    return this.withInventory(async () => {
      if (
        [...this.#attempts.values()].some(
          (attempt) => attempt.stats && sameInode(attempt.stats, stats),
        )
      )
        throw this.fault(new Error('CSI retained backup alias is forbidden.'));
    });
  }

  private withInventory<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#inventoryTail.then(() => {
      if (this.#failure) throw this.#failure;
      return operation();
    });
    this.#inventoryTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private requireFile(stats: BigIntStats, device: string): void {
    if (
      !stats.isFile() ||
      stats.dev.toString() !== device ||
      stats.size < 0n ||
      stats.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw this.fault(
        Object.assign(
          new Error(
            'CSI tools require an ordinary file on the original device.',
          ),
          stats.isDirectory() ? { code: 'EISDIR' } : {},
        ),
      );
    }
  }

  private backupAddress(name: string): string {
    return addressOf(this.#directories[1].handle, name);
  }

  private async lstat(address: string): Promise<BigIntStats | null> {
    try {
      return await fs.lstat(address, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.fault(error);
    }
  }

  private async writeBytes(
    handle: FileHandle,
    bytes: Buffer,
    position: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (
        !Number.isSafeInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        bytesWritten > bytes.length - offset
      )
        throw new Error('CSI file write did not progress.');
      offset += bytesWritten;
    }
    signal?.throwIfAborted();
  }

  private async closeEphemeral(handles: FileHandle[]): Promise<void> {
    const results = await Promise.allSettled(
      handles.map(async (handle) => handle.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw this.fault(new AggregateError(errors, UNAVAILABLE));
  }

  private fault(error: unknown): Error {
    this.#failure ??= error instanceof Error ? error : new Error(String(error));
    void this.close().catch(() => {});
    return this.#failure;
  }
}

function validLeaf(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    [...name].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}
function addressOf(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`;
}
function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function stableFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isFile() &&
    sameInode(a, b) &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
