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

import { mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Copy-on-write overlay filesystem for speculation safety.
 */
export class OverlayFs {
  private readonly overlayDir: string;
  private readonly writtenFiles = new Map<string, string>(); // relPath -> overlayPath

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
      try {
        await mkdir(dirname(realPath), { recursive: true });
        await copyFile(overlayPath, realPath);
        applied.push(realPath);
      } catch (err) {
        // Keep going so the other files still land, then report this one. The
        // first failure rides along as the cause so the caller can tell EACCES
        // from ENOSPC instead of only seeing that something went wrong.
        failed.push(realPath);
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
      ) as Error & { applied: string[]; failed: string[] };
      applyError.applied = applied;
      applyError.failed = failed;
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
