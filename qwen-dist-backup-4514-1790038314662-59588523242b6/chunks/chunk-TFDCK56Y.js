// Force strict mode and setup for ESM
"use strict";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/json-cache-file.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var fileOps = /* @__PURE__ */ new Map();
function serializeFileOperation(key, fn) {
  const prev = fileOps.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => {
    },
    () => {
    }
  );
  fileOps.set(key, settled);
  void settled.then(() => {
    if (fileOps.get(key) === settled) fileOps.delete(key);
  });
  return run;
}
__name(serializeFileOperation, "serializeFileOperation");
var MAX_CORRUPT_BACKUPS = 2;
var OmniJsonCacheFile = class {
  constructor(filePath, debugChannel) {
    this.filePath = filePath;
    this.debugLogger = createDebugLogger(debugChannel);
  }
  static {
    __name(this, "OmniJsonCacheFile");
  }
  debugLogger;
  /**
   * Run one serialized operation against the entry map. `fn` returns the
   * operation result plus whether it changed the map (triggering an
   * atomic save). When the file exists but cannot be read,
   * `unreadableResult` is returned and nothing is saved.
   */
  async access(unreadableResult, fn) {
    return serializeFileOperation(this.filePath, async () => {
      const data = await this.load();
      if (!data) return unreadableResult;
      const { result, changed } = await fn(data.entries);
      if (changed) await this.save(data);
      return result;
    });
  }
  /**
   * Load the cache file. Returns null when the file exists but could not
   * be read (EACCES, EMFILE, …): the caller must skip its operation for
   * this call — proceeding with an empty snapshot and later saving it
   * would overwrite N valid entries with one (self-inflicted cache wipe).
   * Only a genuinely missing file means empty-and-writable.
   */
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { version: 1, entries: {} };
      }
      this.debugLogger.debug(
        `cache read failed, operation skipped: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null && !Array.isArray(parsed.entries)) {
        let pruned = 0;
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (typeof v !== "object" || v === null || Array.isArray(v)) {
            delete parsed.entries[k];
            pruned++;
          }
        }
        if (pruned > 0) {
          this.debugLogger.debug(
            `dropped ${pruned} malformed cache entr${pruned === 1 ? "y" : "ies"} from ${this.filePath}`
          );
        }
        return parsed;
      }
      throw new Error("unexpected shape");
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {
      });
      await this.pruneCorruptBackups();
      this.debugLogger.debug(`corrupt cache backed up to ${backup}`);
      return { version: 1, entries: {} };
    }
  }
  /** Best-effort: keep only the newest {@link MAX_CORRUPT_BACKUPS}. */
  async pruneCorruptBackups() {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.corrupt-`;
    try {
      const backups = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix)).sort().reverse();
      for (const name of backups.slice(MAX_CORRUPT_BACKUPS)) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {
        });
      }
    } catch {
    }
  }
  async save(data) {
    try {
      await fs.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 448
      });
      await atomicWriteFile(this.filePath, JSON.stringify(data, null, 1), {
        mode: 384,
        forceMode: true,
        // Rename-replacement semantics: a symlink planted at the cache
        // path is REPLACED by the rename, never written through — without
        // this the default symlink resolution would redirect the write
        // (and the 0600 chmod) onto the link's target.
        noFollow: true
      });
    } catch (err) {
      this.debugLogger.debug(
        `cache write failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }
};

export {
  serializeFileOperation,
  OmniJsonCacheFile
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
