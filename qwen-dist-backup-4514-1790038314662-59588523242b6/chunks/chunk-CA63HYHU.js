// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/atomicFileWrite.ts
init_esbuild_shims();
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
var debugLogger = createDebugLogger("ATOMIC_WRITE");
async function renameWithRetry(src, dest, retries, delayMs, _renameImpl = fs.rename) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await _renameImpl(src, dest);
      return;
    } catch (error) {
      const isRetryable = isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES");
      if (!isRetryable || attempt === retries) {
        throw error;
      }
      await new Promise(
        (resolve2) => setTimeout(resolve2, delayMs * 2 ** attempt)
      );
    }
  }
}
__name(renameWithRetry, "renameWithRetry");
async function resolveSymlinkChain(filePath) {
  const maxHops = 40;
  let current = filePath;
  for (let i = 0; i < maxHops; i++) {
    let lstats;
    try {
      lstats = await fs.lstat(current);
    } catch (err2) {
      if (isNodeError(err2) && err2.code === "ENOENT") {
        return current;
      }
      throw err2;
    }
    if (!lstats.isSymbolicLink()) {
      return current;
    }
    const linkTarget = await fs.readlink(current);
    if (path.isAbsolute(linkTarget)) {
      current = linkTarget;
    } else {
      const parentDir = await fs.realpath(path.dirname(current));
      current = path.resolve(parentDir, linkTarget);
    }
  }
  const err = new Error(
    `ELOOP: too many levels of symbolic links, resolve '${filePath}'`
  );
  err.code = "ELOOP";
  throw err;
}
__name(resolveSymlinkChain, "resolveSymlinkChain");
async function atomicWriteFile(filePath, data, options, _testFs) {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? "utf-8";
  const renameImpl = _testFs?.rename ?? fs.rename;
  const writeFileImpl = _testFs?.writeFile ?? fs.writeFile;
  const openImpl = _testFs?.open ?? fs.open;
  const chmodImpl = _testFs?.chmod ?? fs.chmod;
  const fchmodImpl = _testFs?.fchmod ?? ((fh, mode) => fh.chmod(mode));
  const unlinkImpl = _testFs?.unlink ?? fs.unlink;
  const targetPath = options?.noFollow ? filePath : await resolveSymlinkChain(filePath).catch((err) => {
    throw annotateWriteError(err, filePath);
  });
  let existingStat;
  try {
    existingStat = options?.noFollow ? await fs.lstat(targetPath) : await fs.stat(targetPath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
  }
  let existingMode;
  if (!options?.forceMode || options?.mode === void 0) {
    existingMode = existingStat !== void 0 && (!options?.noFollow || existingStat.isFile()) ? existingStat.mode & 4095 : void 0;
  }
  const desiredMode = existingMode ?? options?.mode;
  const writeOptions = {};
  if (typeof data === "string") writeOptions.encoding = encoding;
  if (flush) writeOptions.flush = true;
  if (desiredMode !== void 0) writeOptions.mode = desiredMode;
  const tryChmod = /* @__PURE__ */ __name(async (target) => {
    if (desiredMode === void 0) return;
    try {
      await chmodImpl(target, desiredMode);
    } catch (chmodErr) {
      if (!isNodeError(chmodErr) || chmodErr.code !== "ENOSYS" && chmodErr.code !== "ENOTSUP") {
        throw chmodErr;
      }
    }
  }, "tryChmod");
  const ownershipWouldChange = /* @__PURE__ */ __name(() => {
    if (existingStat === void 0) return false;
    if (process.platform === "win32") return false;
    const euid = process.geteuid?.();
    if (euid === void 0) return false;
    return existingStat.uid !== euid;
  }, "ownershipWouldChange");
  if (existingStat !== void 0 && existingStat.isFile() && ownershipWouldChange()) {
    options?.assertCanCommit?.();
    await fs.writeFile(targetPath, data, writeOptions);
    await tryChmod(targetPath);
    return;
  }
  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFileImpl(tmpPath, data, writeOptions);
    await tryChmod(tmpPath);
    await renameWithRetry(
      tmpPath,
      targetPath,
      retries,
      delayMs,
      async (src, dest) => {
        options?.assertCanCommit?.();
        await renameImpl(src, dest);
      }
    );
  } catch (error) {
    try {
      await unlinkImpl(tmpPath);
    } catch {
    }
    if (isNodeError(error) && error.code === "EXDEV") {
      try {
        options?.assertCanCommit?.();
        if (options?.noFollow) {
          try {
            await unlinkImpl(targetPath);
          } catch (unlinkErr) {
            if (!isNodeError(unlinkErr) || unlinkErr.code !== "ENOENT") {
              throw unlinkErr;
            }
          }
          const fd = await openImpl(
            targetPath,
            fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
            desiredMode ?? 438
          );
          let writeOk = false;
          try {
            try {
              await fd.writeFile(
                typeof data === "string" ? Buffer.from(data, encoding) : data
              );
              if (flush) await fd.sync();
              if (desiredMode !== void 0) {
                try {
                  await fchmodImpl(fd, desiredMode);
                } catch (chmodErr) {
                  if (!isNodeError(chmodErr) || chmodErr.code !== "ENOSYS" && chmodErr.code !== "ENOTSUP") {
                    throw chmodErr;
                  }
                }
              }
              writeOk = true;
            } finally {
              await fd.close();
            }
          } catch (writeErr) {
            if (!writeOk) {
              try {
                await unlinkImpl(targetPath);
              } catch (orphanErr) {
                debugLogger.debug(
                  `orphan unlink failed for ${targetPath}:`,
                  orphanErr
                );
              }
            }
            throw writeErr;
          }
        } else {
          await writeFileImpl(targetPath, data, writeOptions);
          await tryChmod(targetPath);
        }
        return;
      } catch (fallbackError) {
        throw annotateWriteError(fallbackError, targetPath);
      }
    }
    throw annotateWriteError(error, targetPath);
  }
}
__name(atomicWriteFile, "atomicWriteFile");
function annotateWriteError(error, targetPath, fnName = "atomicWriteFile") {
  if (error instanceof Error && !error.message.startsWith(`${fnName}(`)) {
    error.message = `${fnName}(${JSON.stringify(targetPath)}): ${error.message}`;
  }
  return error;
}
__name(annotateWriteError, "annotateWriteError");
async function atomicWriteJSON(filePath, data, options) {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    ...options
  });
}
__name(atomicWriteJSON, "atomicWriteJSON");
function blockingSleep(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}
__name(blockingSleep, "blockingSleep");
function renameWithRetrySync(src, dest, retries, delayMs, _renameImpl = fsSync.renameSync) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      _renameImpl(src, dest);
      return;
    } catch (error) {
      const isRetryable = isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES");
      if (!isRetryable || attempt === retries) {
        throw error;
      }
      blockingSleep(delayMs * 2 ** attempt);
    }
  }
}
__name(renameWithRetrySync, "renameWithRetrySync");
function resolveSymlinkChainSync(filePath) {
  const maxHops = 40;
  let current = filePath;
  for (let i = 0; i < maxHops; i++) {
    let lstats;
    try {
      lstats = fsSync.lstatSync(current);
    } catch (err2) {
      if (isNodeError(err2) && err2.code === "ENOENT") {
        return current;
      }
      throw err2;
    }
    if (!lstats.isSymbolicLink()) {
      return current;
    }
    const linkTarget = fsSync.readlinkSync(current);
    if (path.isAbsolute(linkTarget)) {
      current = linkTarget;
    } else {
      const parentDir = fsSync.realpathSync(path.dirname(current));
      current = path.resolve(parentDir, linkTarget);
    }
  }
  const err = new Error(
    `ELOOP: too many levels of symbolic links, resolve '${filePath}'`
  );
  err.code = "ELOOP";
  throw err;
}
__name(resolveSymlinkChainSync, "resolveSymlinkChainSync");
function atomicWriteFileSync(filePath, data, options, _testFs) {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  const flush = options?.flush ?? true;
  const encoding = options?.encoding ?? "utf-8";
  const renameImpl = _testFs?.rename ?? fsSync.renameSync;
  const writeFileImpl = _testFs?.writeFile ?? fsSync.writeFileSync;
  const openImpl = _testFs?.open ?? fsSync.openSync;
  const chmodImpl = _testFs?.chmod ?? fsSync.chmodSync;
  const fchmodImpl = _testFs?.fchmod ?? fsSync.fchmodSync;
  const unlinkImpl = _testFs?.unlink ?? fsSync.unlinkSync;
  let targetPath;
  if (options?.noFollow) {
    targetPath = filePath;
  } else {
    try {
      targetPath = resolveSymlinkChainSync(filePath);
    } catch (err) {
      throw annotateWriteError(err, filePath, "atomicWriteFileSync");
    }
  }
  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let existingMode;
  if (!options?.forceMode || options?.mode === void 0) {
    try {
      const stat2 = fsSync.statSync(targetPath);
      existingMode = stat2.mode & 4095;
    } catch (err) {
      if (!isNodeError(err) || err.code !== "ENOENT") {
        throw err;
      }
    }
  }
  const desiredMode = existingMode ?? options?.mode;
  const writeOptions = {};
  if (typeof data === "string") writeOptions.encoding = encoding;
  if (flush) writeOptions.flush = true;
  if (desiredMode !== void 0) writeOptions.mode = desiredMode;
  const tryChmodSync = /* @__PURE__ */ __name((target) => {
    if (desiredMode === void 0) return;
    try {
      chmodImpl(target, desiredMode);
    } catch (chmodErr) {
      if (!isNodeError(chmodErr) || chmodErr.code !== "ENOSYS" && chmodErr.code !== "ENOTSUP") {
        throw chmodErr;
      }
    }
  }, "tryChmodSync");
  try {
    writeFileImpl(tmpPath, data, writeOptions);
    tryChmodSync(tmpPath);
    renameWithRetrySync(tmpPath, targetPath, retries, delayMs, (src, dest) => {
      options?.assertCanCommit?.();
      renameImpl(src, dest);
    });
  } catch (error) {
    try {
      unlinkImpl(tmpPath);
    } catch {
    }
    if (isNodeError(error) && error.code === "EXDEV") {
      try {
        options?.assertCanCommit?.();
        if (options?.noFollow) {
          try {
            unlinkImpl(targetPath);
          } catch (unlinkErr) {
            if (!isNodeError(unlinkErr) || unlinkErr.code !== "ENOENT") {
              throw unlinkErr;
            }
          }
          const fd = openImpl(
            targetPath,
            fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
            desiredMode ?? 438
          );
          let writeOk = false;
          try {
            try {
              const buf = typeof data === "string" ? Buffer.from(data, encoding) : data;
              fsSync.writeFileSync(fd, buf);
              if (flush) fsSync.fsyncSync(fd);
              if (desiredMode !== void 0) {
                try {
                  fchmodImpl(fd, desiredMode);
                } catch (chmodErr) {
                  if (!isNodeError(chmodErr) || chmodErr.code !== "ENOSYS" && chmodErr.code !== "ENOTSUP") {
                    throw chmodErr;
                  }
                }
              }
              writeOk = true;
            } finally {
              fsSync.closeSync(fd);
            }
          } catch (writeErr) {
            if (!writeOk) {
              try {
                unlinkImpl(targetPath);
              } catch (orphanErr) {
                debugLogger.debug(
                  `orphan unlink failed for ${targetPath}:`,
                  orphanErr
                );
              }
            }
            throw writeErr;
          }
        } else {
          writeFileImpl(targetPath, data, writeOptions);
          tryChmodSync(targetPath);
        }
        return;
      } catch (fallbackError) {
        throw annotateWriteError(
          fallbackError,
          targetPath,
          "atomicWriteFileSync"
        );
      }
    }
    throw annotateWriteError(error, targetPath, "atomicWriteFileSync");
  }
}
__name(atomicWriteFileSync, "atomicWriteFileSync");

export {
  renameWithRetry,
  atomicWriteFile,
  atomicWriteJSON,
  atomicWriteFileSync
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
