/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copy-on-Write Overlay Filesystem
 *
 * Provides file isolation for speculative execution. Writes go to a temporary
 * overlay directory while reads resolve to overlay (if previously written)
 * or the real filesystem.
 */

import { mkdir, copyFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Copy-on-write overlay filesystem for speculation safety.
 */
export class OverlayFs {
  private readonly overlayDir: string;
  private readonly writtenFiles = new Map<string, string>(); // relPath -> overlayPath
  // Content hash of the copy-on-write snapshot taken by `redirectWrite`. A
  // preloaded overlay file that still matches it was never written by the tool,
  // even if the real file has changed since the snapshot was taken.
  private readonly preloadedHashes = new Map<string, string>(); // relPath -> sha256

  constructor(private readonly realCwd: string) {
    const id = randomUUID().slice(0, 8);
    this.overlayDir = join(
      tmpdir(),
      'qwen-speculation',
      String(process.pid),
      id,
    );
  }

  /** Get the overlay directory path */
  getOverlayDir(): string {
    return this.overlayDir;
  }

  /**
   * Resolve a read path: return overlay path if the file was previously written,
   * otherwise return the real path.
   */
  resolveReadPath(realPath: string): string {
    const rel = this.toRelative(realPath);
    if (rel && this.writtenFiles.has(rel)) {
      return this.writtenFiles.get(rel)!;
    }
    return realPath;
  }

  /**
   * Redirect a write to the overlay. On first write to a file, copies the
   * original to the overlay (if it exists). Returns the overlay path to write to.
   */
  async redirectWrite(realPath: string): Promise<string> {
    const rel = this.toRelative(realPath);
    if (!rel) {
      throw new Error(`Cannot redirect write outside cwd: ${realPath}`);
    }

    // Already in overlay
    if (this.writtenFiles.has(rel)) {
      return this.writtenFiles.get(rel)!;
    }

    const overlayPath = join(this.overlayDir, rel);
    await mkdir(dirname(overlayPath), { recursive: true });

    // Copy-on-write: copy original to overlay if it exists
    const originalPath = join(this.realCwd, rel);
    if (existsSync(originalPath)) {
      try {
        await copyFile(originalPath, overlayPath);
        const snapshot = await readFile(overlayPath);
        this.preloadedHashes.set(
          rel,
          createHash('sha256').update(snapshot).digest('hex'),
        );
      } catch {
        // Original may be a directory or unreadable — proceed without copy
      }
    }
    // For new files: the overlay path is created but empty — the tool will write to it

    this.writtenFiles.set(rel, overlayPath);
    return overlayPath;
  }

  /**
   * Get all files that were written to the overlay.
   */
  getWrittenFiles(): Map<string, string> {
    return new Map(this.writtenFiles);
  }

  /**
   * Copy all overlay files back to the real filesystem.
   * Returns the list of real paths that were updated.
   *
   * Throws when a file could not be copied. The caller reports the speculation
   * as accepted and injects the tool results that claim the edits landed, so
   * dropping a file here would tell the user -- and the model reading the
   * history -- that an edit is on disk when it is not.
   */
  async applyToReal(): Promise<string[]> {
    const applied: string[] = [];
    const failed: string[] = [];
    const damaged: string[] = [];
    let firstError: unknown;

    for (const [rel, overlayPath] of this.writtenFiles) {
      const realPath = join(this.realCwd, rel);
      // A registered entry is not proof that anything was written. `redirectWrite`
      // registers the path up front and, for a file that does not exist yet, only
      // creates the directory -- so a redirected write that then failed leaves an
      // entry with no overlay file behind it. There is no edit to land and no false
      // success to prevent, so counting it would reject edits that did land.
      let overlayStat;
      try {
        overlayStat = await stat(overlayPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        failed.push(realPath);
        firstError ??= err;
        continue;
      }
      // A later nested redirect can create a registered parent as a directory.
      if (overlayStat.isDirectory()) {
        continue;
      }

      // `redirectWrite` preloads an existing file's original bytes into the
      // overlay. A redirected tool that then fails without writing leaves those
      // bytes behind, so the overlay file existing is not proof of an edit:
      // copying them back would report an unchanged file as applied. Compare the
      // overlay against the snapshot taken at redirect time, not against the
      // current real file: the user may have saved that file while speculation
      // was running, and comparing against the newer content would let the stale
      // snapshot win.
      let overlayContent: Buffer;
      try {
        overlayContent = await readFile(overlayPath);
      } catch (err) {
        failed.push(realPath);
        firstError ??= err;
        continue;
      }
      const preloadedHash = this.preloadedHashes.get(rel);
      if (
        preloadedHash &&
        createHash('sha256').update(overlayContent).digest('hex') ===
          preloadedHash
      ) {
        continue;
      }
      // An unreadable real path is not a new failure: `mkdir`/`copyFile` below
      // will report the same errno, and taking it here would replace the cause
      // the caller relies on (ENOTDIR from `mkdir` under a regular file, for
      // example).
      const realStat = await stat(realPath).catch(() => null);
      if (realStat?.isDirectory()) {
        failed.push(realPath);
        firstError ??= Object.assign(
          new Error(`EISDIR: cannot copy a file over a directory: ${realPath}`),
          { code: 'EISDIR' },
        );
        continue;
      }

      try {
        await mkdir(dirname(realPath), { recursive: true });
      } catch (err) {
        // Nothing has been opened on the real path yet, so this failure leaves
        // the file as it was.
        failed.push(realPath);
        firstError ??= err;
        continue;
      }
      try {
        await copyFile(overlayPath, realPath);
        applied.push(realPath);
      } catch (err) {
        // Keep going so the other files still land, then report this one. The
        // first failure rides along as the cause so the caller can tell EACCES
        // from ENOSPC instead of only seeing that something went wrong.
        //
        // A copy-stage failure is different from a mkdir failure: copyFile opens
        // the destination with O_TRUNC, and libuv unlinks it when the write
        // fails, so the real file can be truncated or gone. Report that
        // separately so the caller does not resubmit over a damaged tree — but
        // only when the destination actually changed. An EACCES on a read-only
        // file fails at `open()` and leaves the bytes untouched; calling that
        // damaged would suppress a resubmit that is still safe.
        failed.push(realPath);
        const afterStat = await stat(realPath).catch(() => null);
        const destinationChanged = realStat
          ? !afterStat ||
            afterStat.size !== realStat.size ||
            afterStat.mtimeMs !== realStat.mtimeMs
          : afterStat !== null;
        if (destinationChanged) {
          damaged.push(realPath);
        }
        firstError ??= err;
      }
    }

    if (failed.length > 0) {
      // The denominator is the number of files actually attempted, not the number
      // registered: an entry with no overlay file behind it was skipped above, so
      // counting it here would report "1 of 2" next to a single path.
      const attempted = applied.length + failed.length;
      const applyError = new Error(
        `Could not apply ${failed.length} of ${attempted} file(s) to disk: ${failed.join(', ')}`,
        { cause: firstError },
      ) as Error & {
        applied: string[];
        failed: string[];
        damaged: string[];
      };
      applyError.applied = applied;
      applyError.failed = failed;
      applyError.damaged = damaged;
      throw applyError;
    }

    return applied;
  }

  /**
   * Clean up the overlay directory.
   */
  async cleanup(): Promise<void> {
    try {
      await rm(this.overlayDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Convert an absolute path to a relative path within cwd.
   * Returns null if the path is outside cwd.
   */
  private toRelative(inputPath: string): string | null {
    // Resolve relative paths against realCwd (not process.cwd())
    const abs = isAbsolute(inputPath)
      ? inputPath
      : join(this.realCwd, inputPath);
    const rel = relative(this.realCwd, abs);
    if (isAbsolute(rel) || rel.startsWith('..')) {
      return null;
    }
    return rel;
  }
}
