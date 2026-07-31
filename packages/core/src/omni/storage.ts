/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Result of promoting a file into the content-addressed object store. */
export interface PutObjectResult {
  /** Absolute path of the stored object. */
  objectPath: string;
  /** True when an identical object already existed (dedup hit). */
  deduped: boolean;
}

/**
 * Content-addressed, immutable object store under `<project>/.qwen/omni/`.
 *
 * S1 scope: only the `objects/` area exists. Layout:
 *
 *   .qwen/omni/
 *   ├── .gitignore            # "*" — self-ignoring
 *   └── objects/sha256/<h[0:2]>/<sha256><ext>
 *
 * Write protocol: copy to a sibling `.tmp-*` file in the final directory,
 * then atomically rename onto the content-addressed name. A pre-existing
 * target is a dedup hit — the temp file is discarded.
 */
export class OmniObjectStore {
  private readonly omniRoot: string;
  private layoutReady: Promise<void> | undefined;

  /** @param qwenDir Absolute path of the project `.qwen` directory. */
  constructor(qwenDir: string) {
    this.omniRoot = path.join(qwenDir, 'omni');
  }

  getOmniRootDir(): string {
    return this.omniRoot;
  }

  getObjectsDir(): string {
    return path.join(this.omniRoot, 'objects', 'sha256');
  }

  /** Compute the final object path for a content hash + extension. */
  objectPathFor(sha256: string, extension: string): string {
    return path.join(
      this.getObjectsDir(),
      sha256.slice(0, 2),
      `${sha256}${extension}`,
    );
  }

  /**
   * Ensure the directory layout and the self-ignoring .gitignore exist.
   * Idempotent and shared across concurrent callers.
   */
  ensureLayout(): Promise<void> {
    this.layoutReady ??= (async () => {
      await fs.mkdir(this.getObjectsDir(), { recursive: true, mode: 0o700 });
      const gitignorePath = path.join(this.omniRoot, '.gitignore');
      try {
        // 'wx' fails when the file already exists — atomic create-once,
        // mirroring gitWorktreeService.ensureWorktreesGitignored().
        await fs.writeFile(gitignorePath, '*\n', { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    })().catch((err) => {
      // Allow a retry on the next call instead of caching the rejection.
      this.layoutReady = undefined;
      throw err;
    });
    return this.layoutReady;
  }

  /**
   * Promote a local file into the object store under its content hash.
   * The caller is responsible for having computed `sha256` over the exact
   * current content of `sourcePath`.
   */
  async putFile(
    sourcePath: string,
    sha256: string,
    extension: string,
  ): Promise<PutObjectResult> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Invalid sha256 object key: ${sha256}`);
    }
    await this.ensureLayout();
    const objectPath = this.objectPathFor(sha256, extension);

    if (await this.exists(objectPath)) {
      return { objectPath, deduped: true };
    }

    const objectDir = path.dirname(objectPath);
    await fs.mkdir(objectDir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(
      objectDir,
      `.tmp-${randomBytes(8).toString('hex')}`,
    );
    try {
      await fs.copyFile(sourcePath, tmpPath);
      await fs.rename(tmpPath, objectPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      // Concurrent writer may have won the rename race — that is a dedup
      // hit, not an error.
      if (await this.exists(objectPath)) {
        return { objectPath, deduped: true };
      }
      throw err;
    }
    return { objectPath, deduped: false };
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
