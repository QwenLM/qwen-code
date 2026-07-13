/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open, type Entry, type ZipFile } from 'yauzl';

const ZIP_FILE_TYPE_MASK = 0xf000;
const ZIP_DIRECTORY_TYPE = 0x4000;
const ZIP_SYMBOLIC_LINK_TYPE = 0xa000;
const ZIP_DOS_DIRECTORY_ATTRIBUTE = 16;

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function getEntryMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function isDirectoryEntry(entry: Entry, mode: number): boolean {
  if ((mode & ZIP_FILE_TYPE_MASK) === ZIP_DIRECTORY_TYPE) return true;
  if (entry.fileName.endsWith('/')) return true;
  const madeBy = entry.versionMadeBy >>> 8;
  return (
    madeBy === 0 && entry.externalFileAttributes === ZIP_DOS_DIRECTORY_ATTRIBUTE
  );
}

function isSymbolicLinkEntry(mode: number): boolean {
  return (mode & ZIP_FILE_TYPE_MASK) === ZIP_SYMBOLIC_LINK_TYPE;
}

function openZipFile(file: string, signal?: AbortSignal): Promise<ZipFile> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    open(file, { lazyEntries: true }, (error, zipFile) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) {
        zipFile?.close();
        reject(signal?.reason);
      } else if (error) {
        reject(error);
      } else {
        resolve(zipFile);
      }
    });
  });
}

function openEntryStream(
  zipFile: ZipFile,
  entry: Entry,
  signal?: AbortSignal,
): Promise<Readable> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
      } else if (signal?.aborted) {
        stream.destroy();
        reject(signal.reason);
      } else {
        resolve(stream);
      }
    });
  });
}

async function rejectExistingSymbolicLink(destination: string): Promise<void> {
  try {
    const stats = await fs.promises.lstat(destination);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to extract through existing symbolic link: ${destination}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function extractEntry(
  zipFile: ZipFile,
  entry: Entry,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (entry.fileName.startsWith('__MACOSX/')) return;

  const mode = getEntryMode(entry);
  if (isSymbolicLinkEntry(mode)) {
    throw new Error(
      `Zip archive contains unsupported symbolic link entry: ${entry.fileName}`,
    );
  }

  const destination = path.resolve(root, entry.fileName);
  if (!isWithinRoot(root, destination)) {
    throw new Error(
      `Out of bound path "${destination}" found while processing file ${entry.fileName}`,
    );
  }

  const isDirectory = isDirectoryEntry(entry, mode);
  const permissions = (mode || (isDirectory ? 0o755 : 0o644)) & 0o777;
  const destinationDirectory = isDirectory
    ? destination
    : path.dirname(destination);
  await fs.promises.mkdir(destinationDirectory, {
    recursive: true,
    ...(isDirectory ? { mode: permissions } : {}),
  });
  signal?.throwIfAborted();

  const canonicalDestinationDirectory =
    await fs.promises.realpath(destinationDirectory);
  if (!isWithinRoot(root, canonicalDestinationDirectory)) {
    throw new Error(
      `Out of bound path "${canonicalDestinationDirectory}" found while processing file ${entry.fileName}`,
    );
  }
  if (isDirectory) return;

  await rejectExistingSymbolicLink(destination);
  signal?.throwIfAborted();
  const readStream = await openEntryStream(zipFile, entry, signal);
  try {
    await pipeline(
      readStream,
      fs.createWriteStream(destination, { mode: permissions }),
      { signal },
    );
  } catch (error) {
    readStream.destroy();
    signal?.throwIfAborted();
    throw error;
  }
}

function extractEntries(
  zipFile: ZipFile,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      zipFile.removeListener('close', onClose);
      zipFile.removeListener('entry', onEntry);
      if (error === undefined) resolve();
      else reject(error);
    };
    const fail = (error: unknown) => {
      finish(error);
      zipFile.close();
    };
    const onAbort = () => fail(signal?.reason);
    const onError = (error: Error) => fail(error);
    const onClose = () => {
      zipFile.removeListener('error', onError);
      finish();
    };
    const onEntry = (entry: Entry) => {
      void extractEntry(zipFile, entry, root, signal).then(
        () => {
          if (!settled) zipFile.readEntry();
        },
        (error: unknown) => fail(error),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    zipFile.on('error', onError);
    zipFile.on('close', onClose);
    zipFile.on('entry', onEntry);
    if (signal?.aborted) onAbort();
    else zipFile.readEntry();
  });
}

export async function extractZipArchive(
  file: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!path.isAbsolute(destination)) {
    throw new Error('Target directory is expected to be absolute');
  }
  await fs.promises.mkdir(destination, { recursive: true });
  const root = await fs.promises.realpath(destination);
  signal?.throwIfAborted();
  const zipFile = await openZipFile(file, signal);
  try {
    await extractEntries(zipFile, root, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}
