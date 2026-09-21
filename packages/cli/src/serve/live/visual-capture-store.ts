/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a browser Host's capture lands before `capture_screen_context` reads
 * it. A native Host writes its own file and hands over the path; a browser
 * cannot touch this machine, so the daemon persists the bytes it has already
 * validated and keeps ownership of the path. The directory matches the one the
 * native Host uses so the tool's private-directory check covers both.
 */
const CAPTURE_FILE_TTL_MS = 60_000;

/** Long enough for a stalled read to finish, short enough to stay tidy. */
const STALE_CAPTURE_AGE_MS = 5 * 60_000;

/**
 * POSIX mode bits are not meaningful on win32: `fs` reports a synthesized mode
 * with the group and other bits set, so a private-directory check written for
 * macOS rejects every directory there. Ownership on win32 comes from the ACL of
 * the per-user temp directory instead.
 */
const CHECKS_POSIX_MODE = process.platform !== 'win32';

/**
 * What the coordinator needs of a store. It is an interface rather than the
 * class because the class keeps private state, which makes it nominally typed:
 * a test double could otherwise never stand in for it.
 */
export interface LiveVisualCaptureSink {
  /** Persists the image and returns the path the tool should read. */
  store(image: Buffer): Promise<string>;
  /** Drops anything still held, on shutdown. */
  dispose(): void;
}

export class LiveVisualCaptureStore implements LiveVisualCaptureSink {
  private readonly cleanupTimers = new Map<NodeJS.Timeout, string>();

  constructor(
    private readonly captureDirectory = join(tmpdir(), 'qwen-live-appshot'),
  ) {}

  /**
   * Writes an already validated JPEG and returns its path. The caller is the
   * only source of the file name, so a Host cannot steer the write.
   */
  async store(image: Buffer): Promise<string> {
    await this.prepareCaptureDirectory();
    const path = join(this.captureDirectory, `${randomUUID()}.jpg`);
    await this.writePrivateCapture(path, image);
    this.scheduleCleanup(path);
    return path;
  }

  dispose(): void {
    for (const [timer, path] of this.cleanupTimers) {
      clearTimeout(timer);
      void unlink(path).catch(() => undefined);
    }
    this.cleanupTimers.clear();
  }

  private scheduleCleanup(path: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      void unlink(path).catch(() => undefined);
    }, CAPTURE_FILE_TTL_MS);
    timer.unref?.();
    this.cleanupTimers.set(timer, path);
  }

  private async prepareCaptureDirectory(): Promise<void> {
    await mkdir(this.captureDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.captureDirectory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (CHECKS_POSIX_MODE && (directoryStat.mode & 0o077) !== 0)
    ) {
      throw new Error('The Live capture directory is not private.');
    }
    await this.removeStaleCaptures();
  }

  private async writePrivateCapture(
    path: string,
    image: Buffer,
  ): Promise<void> {
    try {
      // `wx` fails rather than following a planted symlink or reusing a file.
      await writeFile(path, image, { flag: 'wx', mode: 0o600 });
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== image.byteLength ||
        (CHECKS_POSIX_MODE && (stat.mode & 0o077) !== 0)
      ) {
        throw new Error('The Live capture file is not private.');
      }
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  private async removeStaleCaptures(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.captureDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_CAPTURE_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const path = join(this.captureDirectory, entry.name);
        try {
          const stat = await lstat(path);
          if (stat.isFile() && stat.mtimeMs < cutoff) await unlink(path);
        } catch {
          /* another reader may have removed it already */
        }
      }),
    );
  }
}
