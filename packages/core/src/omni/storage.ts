/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hashFileSha256 } from './recognition.js';

/** Result of promoting a file into the content-addressed object store. */
export interface PutObjectResult {
  /** Absolute path of the stored object. */
  objectPath: string;
  /** True when an identical object already existed (dedup hit). */
  deduped: boolean;
}

/** Why a policy invocation's staging directory was quarantined; persisted
 * as `reason.json` beside the failed artifacts for debugging. */
export interface QuarantineReason {
  /** The fixed policy whose invocation failed. */
  policyId: string;
  /** The media policy tool that ran (or failed to run). */
  toolName: string;
  /** Human-readable failure description. */
  reason: string;
}

/** Policy invocation IDs are orchestrator-generated 16-hex tokens; anything
 * else (path separators, dots, uppercase) is refused before touching the
 * filesystem so staging/quarantine paths can never escape their area. */
const INVOCATION_ID_RE = /^[0-9a-f]{16}$/;

function assertInvocationId(invocationId: string): void {
  if (!INVOCATION_ID_RE.test(invocationId)) {
    throw new Error(`Invalid omni policy invocation id: ${invocationId}`);
  }
}

/** Reject paths that exist but are not what the store expects (symlinks,
 * devices, …). The store never follows symlinks for its own entries. */
async function assertRealDirIfExists(p: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return; // Missing is fine — it will be created.
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(
      `Omni object store path is not a real directory (symlink or special file refused): ${p}`,
    );
  }
}

/**
 * Content-addressed, immutable object store under `<project>/.qwen/omni/`.
 *
 * Layout (storage design §4):
 *
 *   .qwen/omni/
 *   ├── .gitignore            # "*" — self-ignoring
 *   ├── objects/sha256/<h[0:2]>/<sha256><ext>
 *   ├── staging/<invocationId>/   # policy tool work dirs (pre-commit)
 *   └── quarantine/<invocationId>/ # failed invocations + reason.json
 *
 * Write protocol: stream-copy to a sibling `.tmp-*` file in the final
 * directory while re-computing the content hash, verify it matches the
 * expected object key, then atomically rename onto the content-addressed
 * name. Dedup hits are verified by re-hashing the existing object — a
 * pre-existing file with mismatched bytes (corruption, or content planted
 * in a cloned repo) is healed by overwriting it with verified bytes.
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

  /** Root of the policy-invocation work area (deleted wholesale by
   * startup recovery — anything here belongs to an uncommitted run). */
  getStagingDir(): string {
    return path.join(this.omniRoot, 'staging');
  }

  /** Root of the failed-invocation debris area, kept for debugging under
   * a retention/size budget and never re-entering recognition/delivery. */
  getQuarantineDir(): string {
    return path.join(this.omniRoot, 'quarantine');
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
   * Idempotent and shared across concurrent callers. Refuses symlinked
   * store directories.
   */
  ensureLayout(): Promise<void> {
    this.layoutReady ??= (async () => {
      await assertRealDirIfExists(this.omniRoot);
      await assertRealDirIfExists(path.join(this.omniRoot, 'objects'));
      await assertRealDirIfExists(this.getObjectsDir());
      await assertRealDirIfExists(this.getStagingDir());
      await assertRealDirIfExists(this.getQuarantineDir());
      await fs.mkdir(this.getObjectsDir(), { recursive: true, mode: 0o700 });
      await fs.mkdir(this.getStagingDir(), { recursive: true, mode: 0o700 });
      await fs.mkdir(this.getQuarantineDir(), {
        recursive: true,
        mode: 0o700,
      });
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
   * Create the exclusive work directory for one policy invocation and
   * return its absolute path. The directory is the ONLY location the
   * policy tool is allowed to write to (storage design §4.3). Creation is
   * non-recursive and exclusive: a pre-existing entry (id collision or a
   * planted path) fails instead of being silently reused.
   */
  async createStagingDir(invocationId: string): Promise<string> {
    assertInvocationId(invocationId);
    await this.ensureLayout();
    const dir = path.join(this.getStagingDir(), invocationId);
    await fs.mkdir(dir, { mode: 0o700 });
    return dir;
  }

  /**
   * Delete one invocation's staging directory (after a successful commit,
   * or as the failure path while quarantine is not involved).
   */
  async removeStagingDir(invocationId: string): Promise<void> {
    assertInvocationId(invocationId);
    await fs.rm(path.join(this.getStagingDir(), invocationId), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Move a failed invocation's staging directory into
   * `quarantine/<invocationId>/`, preserving the artifact files and adding
   * a `reason.json` (storage design §4.4). The reason file is written into
   * the staging directory BEFORE the rename so the quarantine entry appears
   * complete in one atomic step; a crash in between leaves it in staging,
   * which startup recovery deletes wholesale.
   */
  async quarantineInvocation(
    invocationId: string,
    reason: QuarantineReason,
  ): Promise<string> {
    assertInvocationId(invocationId);
    await this.ensureLayout();
    const stagingDir = path.join(this.getStagingDir(), invocationId);
    // The rename source must be a real directory: a symlink here would
    // make the reason.json write (and the quarantined "content") point
    // outside the omni root.
    const st = await fs.lstat(stagingDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(
        `Staging path is not a real directory (symlink or special file refused): ${stagingDir}`,
      );
    }
    await fs.writeFile(
      path.join(stagingDir, 'reason.json'),
      JSON.stringify(
        { ...reason, failedAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const quarantineDir = path.join(this.getQuarantineDir(), invocationId);
    await fs.rename(stagingDir, quarantineDir);
    return quarantineDir;
  }

  /**
   * Promote a local file into the object store under its content hash.
   * The bytes are re-hashed while copying and verified against `sha256`,
   * so a source file that changed since the caller hashed it (TOCTOU)
   * fails closed instead of poisoning the immutable store.
   */
  async putFile(
    sourcePath: string,
    sha256: string,
    extension: string,
    signal?: AbortSignal,
  ): Promise<PutObjectResult> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Invalid sha256 object key: ${sha256}`);
    }
    await this.ensureLayout();
    const objectPath = this.objectPathFor(sha256, extension);
    const objectDir = path.dirname(objectPath);
    await assertRealDirIfExists(objectDir);

    // Dedup check verifies content, not just presence: an existing entry
    // whose bytes do not hash to its name (corruption, or a planted file
    // shipped inside a cloned repo before .gitignore applied) must never
    // be reused or uploaded. Mismatches fall through and are overwritten
    // with verified bytes.
    const existing = await fs.lstat(objectPath).catch(() => undefined);
    if (existing) {
      if (existing.isFile() && !existing.isSymbolicLink()) {
        const existingHash = await hashFileSha256(objectPath, signal);
        if (existingHash === sha256) {
          return { objectPath, deduped: true };
        }
      }
      // recursive covers a planted directory/symlink at the object path.
      await fs.rm(objectPath, { force: true, recursive: true });
    }

    await fs.mkdir(objectDir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(
      objectDir,
      `.tmp-${randomBytes(8).toString('hex')}`,
    );
    try {
      const hash = createHash('sha256');
      const source = createReadStream(sourcePath, signal ? { signal } : {});
      source.on('data', (chunk) => hash.update(chunk as Buffer));
      await pipeline(source, createWriteStream(tmpPath, { mode: 0o600 }));
      const actual = hash.digest('hex');
      if (actual !== sha256) {
        throw new Error(
          `Source content changed while storing (expected sha256 ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Retry the read.`,
        );
      }
      await fs.rename(tmpPath, objectPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      // A user abort must surface as the abort, not be converted into a
      // dedup "success" (and must not trigger an unabortable re-hash).
      if (signal?.aborted) throw err;
      // Concurrent writer may have won the rename race with verified
      // bytes of the same hash — treat as dedup, but only if it verifies.
      const winner = await fs.lstat(objectPath).catch(() => undefined);
      if (
        winner?.isFile() &&
        !winner.isSymbolicLink() &&
        (await hashFileSha256(objectPath, signal).catch(() => undefined)) ===
          sha256
      ) {
        return { objectPath, deduped: true };
      }
      throw err;
    }
    return { objectPath, deduped: false };
  }
}
