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

import { mkdir, copyFile, rm } from 'node:fs/promises';
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
   */
  async applyToReal(): Promise<string[]> {
    const applied: string[] = [];

    for (const [rel, overlayPath] of this.writtenFiles) {
      const realPath = join(this.realCwd, rel);
      try {
        await mkdir(dirname(realPath), { recursive: true });
        await copyFile(overlayPath, realPath);
        applied.push(realPath);
      } catch {
        // Best-effort — log but don't throw
      }
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
  private toRelative(path: string): string | null {
    const rel = relative(this.realCwd, path);
    if (isAbsolute(rel) || rel.startsWith('..')) {
      return null;
    }
    return rel;
  }
}
