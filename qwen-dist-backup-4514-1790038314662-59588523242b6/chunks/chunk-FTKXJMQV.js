// Force strict mode and setup for ESM
"use strict";
import {
  hashFileSha256
} from "./chunk-S5BHLTHK.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/storage.ts
init_esbuild_shims();
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
var INVOCATION_ID_RE = /^[0-9a-f]{16}$/;
var OBJECT_EXTENSION_RE = /^\.[A-Za-z0-9]{1,8}$/;
function assertInvocationId(invocationId) {
  if (!INVOCATION_ID_RE.test(invocationId)) {
    throw new Error(`Invalid omni policy invocation id: ${invocationId}`);
  }
}
__name(assertInvocationId, "assertInvocationId");
async function assertRealDirIfExists(p) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(
      `Omni object store path is not a real directory (symlink or special file refused): ${p}`
    );
  }
}
__name(assertRealDirIfExists, "assertRealDirIfExists");
async function prepareOmniDownloadsDir(downloadsDir) {
  await fs.mkdir(downloadsDir, { recursive: true, mode: 448 });
  const st = await fs.lstat(downloadsDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(
      `Omni downloads path is not a real directory (symlink or special file refused): ${downloadsDir}`
    );
  }
  return downloadsDir;
}
__name(prepareOmniDownloadsDir, "prepareOmniDownloadsDir");
var OmniObjectStore = class {
  static {
    __name(this, "OmniObjectStore");
  }
  omniRoot;
  layoutReady;
  /** @param qwenDir Absolute path of the project `.qwen` directory. */
  constructor(qwenDir) {
    this.omniRoot = path.join(qwenDir, "omni");
  }
  getOmniRootDir() {
    return this.omniRoot;
  }
  getObjectsDir() {
    return path.join(this.omniRoot, "objects", "sha256");
  }
  /** Root of the policy-invocation work area (stale entries deleted by
   * startup recovery — anything past the grace window belongs to an
   * uncommitted, crashed run). */
  getStagingDir() {
    return path.join(this.omniRoot, "staging");
  }
  /** Root of the failed-invocation debris area, kept for debugging under
   * a retention/size budget and never re-entering recognition/delivery. */
  getQuarantineDir() {
    return path.join(this.omniRoot, "quarantine");
  }
  /**
   * Compute the final object path for a content hash + extension.
   *
   * Both components are validated here, not just at putFile: callers may
   * feed values read back from on-disk cache files (policy-cache.json),
   * and a crafted hash or extension ("/../../…") would otherwise turn
   * this join into a path-traversal primitive pointing outside the store.
   */
  objectPathFor(sha256, extension) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`invalid object hash: ${JSON.stringify(sha256)}`);
    }
    if (!OBJECT_EXTENSION_RE.test(extension)) {
      throw new Error(`invalid object extension: ${JSON.stringify(extension)}`);
    }
    return path.join(
      this.getObjectsDir(),
      sha256.slice(0, 2),
      `${sha256}${extension}`
    );
  }
  /**
   * Ensure the directory layout and the self-ignoring .gitignore exist.
   * Idempotent and shared across concurrent callers. Refuses symlinked
   * store directories.
   */
  ensureLayout() {
    this.layoutReady ??= (async () => {
      await assertRealDirIfExists(this.omniRoot);
      await assertRealDirIfExists(path.join(this.omniRoot, "objects"));
      await assertRealDirIfExists(this.getObjectsDir());
      await assertRealDirIfExists(this.getStagingDir());
      await assertRealDirIfExists(this.getQuarantineDir());
      await fs.mkdir(this.getObjectsDir(), { recursive: true, mode: 448 });
      await fs.mkdir(this.getStagingDir(), { recursive: true, mode: 448 });
      await fs.mkdir(this.getQuarantineDir(), {
        recursive: true,
        mode: 448
      });
      const gitignorePath = path.join(this.omniRoot, ".gitignore");
      try {
        await fs.writeFile(gitignorePath, "*\n", { flag: "wx" });
      } catch (err) {
        if (err.code !== "EEXIST") {
          throw err;
        }
      }
    })().catch((err) => {
      this.layoutReady = void 0;
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
  async createStagingDir(invocationId) {
    assertInvocationId(invocationId);
    await this.ensureLayout();
    const dir = path.join(this.getStagingDir(), invocationId);
    await fs.mkdir(dir, { mode: 448 });
    return dir;
  }
  /**
   * Delete one invocation's staging directory (after a successful commit,
   * or as the failure path while quarantine is not involved).
   */
  async removeStagingDir(invocationId) {
    assertInvocationId(invocationId);
    await fs.rm(path.join(this.getStagingDir(), invocationId), {
      recursive: true,
      force: true
    });
  }
  /**
   * Move a failed invocation's staging directory into
   * `quarantine/<invocationId>/`, preserving the artifact files and adding
   * a `reason.json` (storage design §4.4). The reason file is written into
   * the staging directory BEFORE the rename so the quarantine entry appears
   * complete in one atomic step; a crash in between leaves it in staging,
   * which startup recovery deletes once past the grace window.
   */
  async quarantineInvocation(invocationId, reason) {
    assertInvocationId(invocationId);
    await this.ensureLayout();
    const stagingDir = path.join(this.getStagingDir(), invocationId);
    const st = await fs.lstat(stagingDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(
        `Staging path is not a real directory (symlink or special file refused): ${stagingDir}`
      );
    }
    await fs.writeFile(
      path.join(stagingDir, "reason.json"),
      JSON.stringify(
        { ...reason, failedAt: (/* @__PURE__ */ new Date()).toISOString() },
        null,
        2
      ),
      { mode: 384 }
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
  async putFile(sourcePath, sha256, extension, signal) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Invalid sha256 object key: ${sha256}`);
    }
    await this.ensureLayout();
    const objectPath = this.objectPathFor(sha256, extension);
    const objectDir = path.dirname(objectPath);
    await assertRealDirIfExists(objectDir);
    const existing = await fs.lstat(objectPath).catch(() => void 0);
    if (existing) {
      if (existing.isFile() && !existing.isSymbolicLink()) {
        const existingHash = await hashFileSha256(objectPath, signal);
        if (existingHash === sha256) {
          const now = /* @__PURE__ */ new Date();
          await fs.utimes(objectPath, now, now).catch(() => {
          });
          return { objectPath, deduped: true };
        }
      }
      await fs.rm(objectPath, { force: true, recursive: true });
    }
    await fs.mkdir(objectDir, { recursive: true, mode: 448 });
    const tmpPath = path.join(
      objectDir,
      `.tmp-${randomBytes(8).toString("hex")}`
    );
    try {
      const hash = createHash("sha256");
      const source = createReadStream(sourcePath, signal ? { signal } : {});
      source.on("data", (chunk) => hash.update(chunk));
      await pipeline(source, createWriteStream(tmpPath, { mode: 384 }));
      const actual = hash.digest("hex");
      if (actual !== sha256) {
        throw new Error(
          `Source content changed while storing (expected sha256 ${sha256.slice(0, 12)}\u2026, got ${actual.slice(0, 12)}\u2026). Retry the read.`
        );
      }
      await fs.rename(tmpPath, objectPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      if (signal?.aborted) throw err;
      const winner = await fs.lstat(objectPath).catch(() => void 0);
      if (winner?.isFile() && !winner.isSymbolicLink() && await hashFileSha256(objectPath, signal).catch(() => void 0) === sha256) {
        return { objectPath, deduped: true };
      }
      throw err;
    }
    return { objectPath, deduped: false };
  }
};

export {
  OBJECT_EXTENSION_RE,
  prepareOmniDownloadsDir,
  OmniObjectStore
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
