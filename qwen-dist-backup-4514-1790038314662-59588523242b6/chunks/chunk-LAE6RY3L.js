// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/grepReadTracking.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var STAT_BATCH_SIZE = 50;
var NON_CACHEABLE_GREP_EXTENSIONS = /* @__PURE__ */ new Set([".ipynb"]);
var debugLogger = createDebugLogger("GREP_READ_TRACKING");
async function recordGrepResultFileReads(config, filePaths) {
  if (config.getFileReadCacheDisabled?.()) {
    return;
  }
  const cache = config.getFileReadCache?.();
  if (!cache) {
    return;
  }
  const uniqueFilePaths = Array.from(new Set(filePaths));
  for (let i = 0; i < uniqueFilePaths.length; i += STAT_BATCH_SIZE) {
    const batch = uniqueFilePaths.slice(i, i + STAT_BATCH_SIZE);
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) {
            return;
          }
          cache.recordRead(filePath, stats, {
            full: false,
            cacheable: isGrepResultCacheable(filePath)
          });
        } catch (error) {
          if (error.code !== "ENOENT") {
            debugLogger.debug(
              "Failed to stat grep result path",
              filePath,
              error
            );
          }
        }
      })
    );
  }
}
__name(recordGrepResultFileReads, "recordGrepResultFileReads");
function isGrepResultCacheable(filePath) {
  return !NON_CACHEABLE_GREP_EXTENSIONS.has(
    path.extname(filePath).toLowerCase()
  );
}
__name(isGrepResultCacheable, "isGrepResultCacheable");

export {
  recordGrepResultFileReads
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
