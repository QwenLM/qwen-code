/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type * as yauzl from 'yauzl';

/** Cap on total uncompressed archive size, guarding against zip bombs. */
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

/** Cap on the number of entries in an archive. */
const MAX_ARCHIVE_ENTRIES = 5000;

/** Symlink targets are paths, not a place to hide arbitrarily large data. */
const MAX_SYMLINK_TARGET_BYTES = 4096;

const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;
const DIRECTORY_TYPE = 0o040000;

interface ArchiveEntry {
  entry: yauzl.Entry;
  mode: number;
  directory: boolean;
  target?: string;
}

export interface ExtractArchiveOptions {
  /** Reject all links by default; plugin ZIPs may opt into contained links. */
  symlinkPolicy?: 'reject' | 'allow-contained';
}

/**
 * Rejects paths that escape `root`. Uses `path.relative` rather than a string
 * prefix check, which can be fooled by sibling directories sharing a prefix.
 */
export function assertInside(root: string, candidate: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Invalid path: Directory traversal not allowed.');
  }
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  const { default: zip } = await import('yauzl');
  return new Promise((resolve, reject) => {
    zip.open(
      archivePath,
      {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) reject(error);
        else resolve(zipFile);
      },
    );
  });
}

function readNextEntry(zipFile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipFile.off('entry', onEntry);
      zipFile.off('end', onEnd);
      zipFile.off('error', onError);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    zipFile.once('entry', onEntry);
    zipFile.once('end', onEnd);
    zipFile.once('error', onError);
    zipFile.readEntry();
  });
}

async function readSymlinkTarget(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<string> {
  if (entry.uncompressedSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new Error(
      `Refusing to install: symlink target is too large (${entry.fileName}).`,
    );
  }

  const target = await new Promise<Buffer>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }

      const chunks: Buffer[] = [];
      let length = 0;
      readStream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > MAX_SYMLINK_TARGET_BYTES) {
          readStream.destroy();
          reject(
            new Error(
              `Refusing to install: symlink target is too large (${entry.fileName}).`,
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      readStream.once('error', reject);
      readStream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(target);
  } catch {
    throw new Error(
      `Refusing to install: symlink target is not valid UTF-8 (${entry.fileName}).`,
    );
  }
}

function assertLexicallyContainedSymlink(
  entryName: string,
  target: string,
): void {
  // ZIP entry names are POSIX paths. Reject backslashes as separators too so
  // an archive has the same containment behavior on every supported OS.
  const portableTarget = target.replaceAll('\\', '/');
  if (
    target.length === 0 ||
    target.includes('\0') ||
    path.posix.isAbsolute(portableTarget) ||
    path.win32.isAbsolute(target) ||
    /^[A-Za-z]:/u.test(target)
  ) {
    throw new Error(
      `Refusing to install: symlink points outside the archive (${entryName}).`,
    );
  }

  const resolvedTarget = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryName), portableTarget),
  );
  if (
    resolvedTarget === '..' ||
    resolvedTarget.startsWith('../') ||
    path.posix.isAbsolute(resolvedTarget)
  ) {
    throw new Error(
      `Refusing to install: symlink points outside the archive (${entryName}).`,
    );
  }
}

/**
 * Validate sizes and link targets before extraction. Keep the entries so file
 * writes can finish before any archive link is created.
 */
async function preflightArchive(
  zipFile: yauzl.ZipFile,
  symlinkPolicy: NonNullable<ExtractArchiveOptions['symlinkPolicy']>,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let entryCount = 0;
  let totalUncompressed = 0;

  for (;;) {
    const entry = await readNextEntry(zipFile);
    if (!entry) break;

    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new Error(
        `Refusing to install: archive has too many entries (> ${MAX_ARCHIVE_ENTRIES}).`,
      );
    }

    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Refusing to install: archive is too large when decompressed (> ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes).`,
      );
    }

    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const directory =
      (mode & FILE_TYPE_MASK) === DIRECTORY_TYPE ||
      entry.fileName.endsWith('/') ||
      (entry.versionMadeBy >>> 8 === 0 && entry.externalFileAttributes === 16);
    if (entry.fileName.includes('\0') || entry.fileName.includes(':')) {
      throw new Error(
        `Refusing to install: invalid archive path (${entry.fileName}).`,
      );
    }
    let target: string | undefined;
    if ((mode & FILE_TYPE_MASK) === SYMLINK_TYPE) {
      if (symlinkPolicy === 'reject') {
        throw new Error(
          `Refusing to install: archive contains a symlink (${entry.fileName}).`,
        );
      }
      target = await readSymlinkTarget(zipFile, entry);
      assertLexicallyContainedSymlink(entry.fileName, target);
    }
    entries.push({ entry, mode, directory, target });
  }

  return entries;
}

/** Check every component before creating children, without following links. */
async function ensureArchiveDirectory(
  root: string,
  dir: string,
  mode = 0o755,
): Promise<void> {
  assertInside(root, dir);
  let current = root;
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await fs.lstat(current)).isDirectory()) {
      throw new Error(
        `Refusing to install: archive directory is not a real directory (${current}).`,
      );
    }
  }
}

async function extractRegularEntry(
  zipFile: yauzl.ZipFile,
  item: ArchiveEntry,
  root: string,
): Promise<void> {
  const dest = path.resolve(root, item.entry.fileName);
  assertInside(root, dest);
  const mode = (item.mode || (item.directory ? 0o755 : 0o644)) & 0o777;
  await ensureArchiveDirectory(
    root,
    item.directory ? dest : path.dirname(dest),
    item.directory ? mode : undefined,
  );
  if (item.directory) return;

  // Exclusive creation also rejects existing symlinks and hard links.
  // Open the destination first so a rejected path never starts decompression.
  const output = await fs.open(dest, 'wx', mode);
  try {
    const input = await new Promise<Readable>((resolve, reject) => {
      zipFile.openReadStream(item.entry, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
    });
    await pipeline(input, output.createWriteStream());
  } finally {
    await output.close();
  }
}

/** Create links only after file writes finish and their real targets are safe. */
async function extractArchiveLinks(
  entries: ArchiveEntry[],
  root: string,
): Promise<void> {
  let pending = entries.filter(
    ({ entry, target }) =>
      target !== undefined && !entry.fileName.startsWith('__MACOSX/'),
  );
  // Bound dependency retries. Native filesystems also limit symlink chains.
  for (let pass = 0; pending.length > 0 && pass < 40; pass++) {
    const deferred: ArchiveEntry[] = [];
    for (const item of pending) {
      const dest = path.resolve(root, item.entry.fileName);
      await ensureArchiveDirectory(root, path.dirname(dest));
      let canonicalTarget: string;
      let targetStat;
      try {
        // Do not use path.join/resolve: normalizing '..' before following
        // intermediate links would validate a different path than the OS.
        canonicalTarget = await fs.realpath(
          `${path.dirname(dest)}${path.sep}${item.target}`,
        );
        targetStat = await fs.stat(canonicalTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        deferred.push(item);
        continue;
      }
      if (!isContained(canonicalTarget, root)) {
        throw new Error(
          `Refusing to install: symlink points outside the containment root (${item.entry.fileName}).`,
        );
      }
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new Error(
          `Refusing to install: symlink targets an unsupported file type (${item.entry.fileName}).`,
        );
      }
      if (
        targetStat.isDirectory() &&
        isContained(path.dirname(dest), canonicalTarget)
      ) {
        throw new Error(
          `Refusing to install: source contains a cyclic directory symlink (${item.entry.fileName}).`,
        );
      }
      await fs.symlink(
        item.target!,
        dest,
        targetStat.isDirectory() ? 'dir' : 'file',
      );
    }
    if (deferred.length === pending.length) break;
    pending = deferred;
  }
  if (pending.length > 0) {
    throw new Error(
      `Refusing to install: source contains a broken or cyclic symlink (${pending[0].entry.fileName}).`,
    );
  }
}

/**
 * Validates every link in a source tree against a canonical containment root.
 * Broken links, link cycles, special-file targets, and directory links back to
 * one of their own ancestors are rejected before any cache copy starts.
 */
export async function assertContainedSymlinks(
  dir: string,
  containmentRoot = dir,
): Promise<void> {
  const canonicalRoot = await fs.realpath(containmentRoot);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let canonicalTarget: string;
      let targetStat;
      try {
        canonicalTarget = await fs.realpath(full);
        targetStat = await fs.stat(full);
      } catch {
        throw new Error(
          `Refusing to install: source contains a broken or cyclic symlink (${entry.name}).`,
        );
      }
      if (!isContained(canonicalTarget, canonicalRoot)) {
        throw new Error(
          `Refusing to install: symlink points outside the containment root (${entry.name}).`,
        );
      }
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new Error(
          `Refusing to install: symlink targets an unsupported file type (${entry.name}).`,
        );
      }
      if (targetStat.isDirectory()) {
        const canonicalParent = await fs.realpath(path.dirname(full));
        if (isContained(canonicalParent, canonicalTarget)) {
          throw new Error(
            `Refusing to install: source contains a cyclic directory symlink (${entry.name}).`,
          );
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      await assertContainedSymlinks(full, canonicalRoot);
    }
  }
}

/**
 * Extracts a zip archive while defending against decompression bombs. The
 * download byte cap only bounds compressed size, so this also bounds the total
 * uncompressed size and entry count before writing files. Links are validated
 * against real targets before creation, after all regular file writes finish.
 * The ZIP library loads only when extraction is requested, keeping it out
 * of Core's startup path.
 */
export async function extractArchiveSafely(
  archivePath: string,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  const symlinkPolicy = options.symlinkPolicy ?? 'reject';
  const zipFile = await openZip(archivePath);
  try {
    const entries = await preflightArchive(zipFile, symlinkPolicy);
    await fs.mkdir(destDir, { recursive: true });
    const root = await fs.realpath(destDir);
    for (const item of entries) {
      if (
        item.target !== undefined ||
        item.entry.fileName.startsWith('__MACOSX/')
      )
        continue;
      await extractRegularEntry(zipFile, item, root);
    }
    await extractArchiveLinks(entries, root);
    if (symlinkPolicy === 'allow-contained') {
      await assertContainedSymlinks(root);
    }
  } finally {
    zipFile.close();
  }
}
