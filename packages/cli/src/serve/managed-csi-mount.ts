/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { ManagedContextMount } from './managed-context-worker.js';
import {
  linuxDeviceNumber,
  type ManagedCsiMountReceipt,
} from './managed-csi-envelope.js';

const UNAVAILABLE = 'Managed CSI mount is unavailable.';
const MOUNTINFO_LIMIT = 1024 * 1024;

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
    if (this.#closed || process.platform !== 'linux') {
      this.#closed = true;
      throw new Error(UNAVAILABLE);
    }
    try {
      const before = parseManagedCsiMount(
        await readBounded('/proc/self/mountinfo', MOUNTINFO_LIMIT),
        this.#mountRoot,
      );
      const serial = await readBounded(
        `/sys/dev/block/${before.device}/device/serial`,
        256,
      );
      if (serial.replace(/\n$/, '') !== this.#serial) {
        throw new Error(UNAVAILABLE);
      }
      const root = await fs.realpath(this.#mountRoot);
      const stats = await fs.stat(root, { bigint: true });
      if (
        root !== this.#mountRoot ||
        !stats.isDirectory() ||
        stats.dev.toString() !== linuxDeviceNumber(before.device) ||
        stats.ino <= 0n ||
        stats.ino > 0xffff_ffff_ffff_ffffn
      ) {
        throw new Error(UNAVAILABLE);
      }
      const after = parseManagedCsiMount(
        await readBounded('/proc/self/mountinfo', MOUNTINFO_LIMIT),
        this.#mountRoot,
      );
      const identity = JSON.stringify([
        before.mountId,
        before.device,
        before.source,
        stats.dev.toString(),
        stats.ino.toString(),
      ]);
      if (
        this.#closed ||
        JSON.stringify(before) !== JSON.stringify(after) ||
        (this.#pinned !== undefined && this.#pinned !== identity)
      ) {
        throw new Error(UNAVAILABLE);
      }
      this.#pinned = identity;
      return Object.freeze({
        ...before,
        diskSerial: this.#serial,
        rootDevice: stats.dev.toString(),
        rootInode: stats.ino.toString(),
      });
    } catch {
      this.#closed = true;
      throw new Error(UNAVAILABLE);
    }
  }

  override async resolve(cwdRelative: string): Promise<string | undefined> {
    try {
      await this.observe();
      const directory = await super.resolve(cwdRelative);
      await this.observe();
      return directory;
    } catch {
      return undefined;
    }
  }
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
