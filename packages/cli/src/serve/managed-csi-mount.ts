/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { normalizeWorkspaceRelativePath } from './managed-workspace-binding.js';
import { ManagedContextMount } from './managed-context-worker.js';
import {
  ManagedCsiRootDirectory,
  ManagedCsiRootDirectoryCleanupError,
} from './managed-csi-root-directory.js';
import {
  linuxDeviceNumber,
  type ManagedCsiMountReceipt,
} from './managed-csi-envelope.js';

const UNAVAILABLE = 'Managed CSI mount is unavailable.';
const MOUNTINFO_LIMIT = 1024 * 1024;

interface BorrowedDirectory {
  handle: FileHandle;
  address: string;
  stats: BigIntStats;
}

export interface ManagedCsiMountObservation {
  readonly mountId: string;
  readonly device: string;
  readonly source: string;
}

/** ACK Disk profile: one complete writable ext4 NVMe mount without nested mounts. */
export function parseManagedCsiMount(
  mountinfo: string,
  mountRoot: string,
): ManagedCsiMountObservation {
  if (
    !isMountRoot(mountRoot) ||
    Buffer.byteLength(mountinfo) > MOUNTINFO_LIMIT ||
    mountinfo.includes('\r') ||
    mountinfo.includes('\0')
  ) {
    throw new Error(UNAVAILABLE);
  }
  let observed: ManagedCsiMountObservation | undefined;
  for (const line of mountinfo.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length !== separator + 4) {
      throw new Error(UNAVAILABLE);
    }
    const target = unescapeField(fields[4]);
    if (target.startsWith(`${mountRoot}/`)) throw new Error(UNAVAILABLE);
    if (target !== mountRoot) continue;
    const source = unescapeField(fields[separator + 2]);
    if (
      observed !== undefined ||
      !/^[1-9][0-9]{0,9}$/.test(fields[0]) ||
      !/^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,9})$/.test(fields[2]) ||
      BigInt(fields[0]) > 0xffff_ffffn ||
      unescapeField(fields[3]) !== '/' ||
      fields[separator + 1] !== 'ext4' ||
      !/^\/dev\/nvme(?:0|[1-9][0-9]*)n[1-9][0-9]*$/.test(source) ||
      !writable(fields[5]) ||
      !writable(fields[separator + 3])
    ) {
      throw new Error(UNAVAILABLE);
    }
    observed = Object.freeze({
      mountId: fields[0],
      device: fields[2],
      source,
    });
    try {
      linuxDeviceNumber(observed.device);
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }
  if (observed === undefined) throw new Error(UNAVAILABLE);
  return observed;
}

/** A permanent local fence; this observer never obtains or transfers SQL ownership. */
export class ManagedCsiMount extends ManagedContextMount {
  readonly #mountRoot: string;
  readonly #serial: string;
  #pinned: string | undefined;
  #closed = false;
  readonly #observations = new Set<Promise<void>>();
  #directory: Promise<ManagedCsiRootDirectory> | undefined;
  #closing: Promise<void> | undefined;
  #closeFailure: AggregateError | undefined;

  constructor(mountRoot: string, trustedDiskSerial: string) {
    super(mountRoot);
    if (
      !isMountRoot(mountRoot) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(trustedDiskSerial)
    ) {
      throw new Error(UNAVAILABLE);
    }
    this.#mountRoot = mountRoot;
    this.#serial = trustedDiskSerial;
  }

  override get isAvailable(): boolean {
    return !this.#closed && this.#pinned !== undefined;
  }

  async observe(): Promise<ManagedCsiMountReceipt> {
    return this.withVerifiedRoot(async (_handle, receipt) => receipt);
  }

  async withVerifiedRoot<T>(
    operation: (
      handle: FileHandle,
      receipt: ManagedCsiMountReceipt,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#closed || process.platform !== 'linux') {
      void this.close().catch(() => {});
      throw new Error(UNAVAILABLE);
    }
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#observations.add(pending);
    try {
      const before = await this.kernelObservation();
      let directory: ManagedCsiRootDirectory;
      try {
        this.#directory ??= ManagedCsiRootDirectory.open(
          this.#mountRoot,
          linuxDeviceNumber(before.device),
        );
        directory = await this.#directory;
      } catch {
        void this.close().catch(() => {});
        throw new Error(UNAVAILABLE);
      }
      try {
        return await directory.withVerifiedDirectory(async (handle) => {
          const receipt = await this.inspect(before, directory);
          try {
            return await operation(handle, receipt);
          } finally {
            await this.inspect(before, directory);
          }
        });
      } catch (error) {
        if (!directory.isAvailable) void this.close().catch(() => {});
        throw error;
      }
    } finally {
      this.#observations.delete(pending);
      complete();
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      await Promise.all(this.#observations);
      await this.#directory?.then(
        (directory) => directory.close(),
        (error: unknown) => {
          if (error instanceof ManagedCsiRootDirectoryCleanupError) throw error;
        },
      );
      if (this.#closeFailure) throw this.#closeFailure;
    })();
    return this.#closing;
  }

  override async resolve(cwdRelative: string): Promise<string | undefined> {
    try {
      if (normalizeWorkspaceRelativePath(cwdRelative) !== cwdRelative)
        return undefined;
      return await this.withVerifiedRoot(async (root, receipt) => {
        const children: BorrowedDirectory[] = [];
        try {
          let parent = root;
          for (const component of cwdRelative === '.'
            ? []
            : cwdRelative.split('/')) {
            const address = `/proc/self/fd/${parent.fd}/${component}`;
            const before = await fs.lstat(address, { bigint: true });
            const handle = await fs.open(
              address,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const child = { handle, address, stats: before };
            children.push(child);
            if (
              !sameDirectory(
                before,
                await handle.stat({ bigint: true }),
                receipt.rootDevice,
              )
            )
              throw new Error(UNAVAILABLE);
            parent = handle;
          }
          await fs.access(
            `/proc/self/fd/${parent.fd}`,
            constants.R_OK | constants.X_OK,
          );
          return cwdRelative === '.'
            ? this.#mountRoot
            : path.join(this.#mountRoot, ...cwdRelative.split('/'));
        } finally {
          try {
            await verifyChildren(children, receipt.rootDevice);
          } finally {
            await this.closeChildren(
              children.map(({ handle }) => handle).reverse(),
            );
          }
        }
      });
    } catch {
      return undefined;
    }
  }

  override async rootDirectory(): Promise<string | undefined> {
    try {
      return await this.withVerifiedRoot(async () => this.#mountRoot);
    } catch {
      return undefined;
    }
  }

  private async closeChildren(handles: FileHandle[]): Promise<void> {
    const results = await Promise.allSettled(
      handles.map(async (handle) => handle.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
      this.#closeFailure ??= new AggregateError(errors, UNAVAILABLE);
      // The current root borrow must leave before close can join it.
      void this.close().catch(() => {});
      throw this.#closeFailure;
    }
  }

  private async kernelObservation(): Promise<ManagedCsiMountObservation> {
    try {
      const observation = parseManagedCsiMount(
        await readBounded('/proc/self/mountinfo', MOUNTINFO_LIMIT),
        this.#mountRoot,
      );
      const serial = await readBounded(
        `/sys/dev/block/${observation.device}/device/serial`,
        256,
      );
      if (this.#closed || serial.replace(/\n$/, '') !== this.#serial)
        throw new Error(UNAVAILABLE);
      return observation;
    } catch {
      void this.close().catch(() => {});
      throw new Error(UNAVAILABLE);
    }
  }

  private async inspect(
    before: ManagedCsiMountObservation,
    directory: ManagedCsiRootDirectory,
  ): Promise<ManagedCsiMountReceipt> {
    const after = await this.kernelObservation();
    const identity = JSON.stringify([
      before.mountId,
      before.device,
      before.source,
      directory.rootDevice,
      directory.rootInode,
    ]);
    if (
      this.#closed ||
      directory.rootDevice !== linuxDeviceNumber(before.device) ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      (this.#pinned !== undefined && this.#pinned !== identity)
    ) {
      void this.close().catch(() => {});
      throw new Error(UNAVAILABLE);
    }
    this.#pinned = identity;
    return Object.freeze({
      ...before,
      diskSerial: this.#serial,
      rootDevice: directory.rootDevice,
      rootInode: directory.rootInode,
    });
  }
}

async function verifyChildren(
  children: BorrowedDirectory[],
  device: string,
): Promise<void> {
  for (const child of children) {
    if (
      !sameDirectory(
        child.stats,
        await child.handle.stat({ bigint: true }),
        device,
      ) ||
      !sameDirectory(
        child.stats,
        await fs.lstat(child.address, { bigint: true }),
        device,
      )
    )
      throw new Error(UNAVAILABLE);
  }
}

function sameDirectory(
  left: BigIntStats,
  right: BigIntStats,
  device: string,
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev.toString() === device &&
    right.dev === left.dev &&
    right.ino === left.ino
  );
}

function isMountRoot(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 2048 &&
    !value.includes('\\') &&
    !Array.from(value).some(
      (char) =>
        char.charCodeAt(0) <= 31 ||
        (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
    ) &&
    !/[\ud800-\udfff]/u.test(value) &&
    value
      .slice(1)
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function writable(options: string): boolean {
  const fields = options.split(',');
  return (
    fields.filter((field) => field === 'rw').length === 1 &&
    !fields.includes('ro')
  );
}

function unescapeField(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw new Error(UNAVAILABLE);
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function readBounded(file: string, limit: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const buffer = Buffer.alloc(Math.min(8192, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    throw new Error(UNAVAILABLE);
  } finally {
    await handle.close();
  }
}
