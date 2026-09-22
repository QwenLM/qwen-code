// Force strict mode and setup for ESM
"use strict";
import {
  readRuntimeStatus
} from "./chunk-KS6F6LZQ.js";
import {
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  Storage
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

// packages/core/src/services/worktreeSessionService.ts
init_esbuild_shims();
import nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var RUNTIME_STATUS_SCAN_MAX_DIRS = 5e3;
var WORKTREE_SESSION_SIDECAR_MAX_BYTES = 64 * 1024;
var RUNTIME_STATUS_SCAN_SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules"
]);
function isValidWorktreeSession(value) {
  if (value === null || typeof value !== "object") return false;
  const v = value;
  return typeof v["slug"] === "string" && typeof v["worktreePath"] === "string" && typeof v["worktreeBranch"] === "string" && typeof v["originalCwd"] === "string" && (v["workspaceCwd"] === void 0 || typeof v["workspaceCwd"] === "string") && typeof v["originalBranch"] === "string" && typeof v["originalHeadCommit"] === "string" && (v["supersededBy"] === void 0 || typeof v["supersededBy"] === "string") && (v["supersedes"] === void 0 || typeof v["supersedes"] === "string");
}
__name(isValidWorktreeSession, "isValidWorktreeSession");
async function readWorktreeSession(filePath, options = {}) {
  let raw;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal ? await fs.readFile(filePath, {
      encoding: "utf-8",
      signal: options.signal
    }) : await fs.readFile(filePath, "utf-8");
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  options.signal?.throwIfAborted();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();
  if (!isValidWorktreeSession(parsed)) return null;
  return parsed;
}
__name(readWorktreeSession, "readWorktreeSession");
async function readWorktreeSessionStrict(filePath) {
  let handle;
  let observedSidecar = false;
  try {
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
    const before = await fs.lstat(filePath, { bigint: true });
    observedSidecar = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      return { state: "invalid", reason: "unsafe sidecar file type" };
    }
    if (before.ino === 0n || before.size > BigInt(WORKTREE_SESSION_SIDECAR_MAX_BYTES)) {
      return { state: "invalid", reason: "unsafe sidecar size or identity" };
    }
    handle = await fs.open(filePath, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) {
      return {
        state: "invalid",
        reason: "sidecar identity changed before read"
      };
    }
    const buffer = Buffer.alloc(WORKTREE_SESSION_SIDECAR_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > WORKTREE_SESSION_SIDECAR_MAX_BYTES) {
      return { state: "invalid", reason: "unsafe sidecar size or identity" };
    }
    const after = await handle.stat({ bigint: true });
    const pathStats = await fs.lstat(filePath, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.size !== BigInt(bytesRead) || after.dev !== opened.dev || after.ino !== opened.ino || !pathStats.isFile() || pathStats.nlink !== 1n || pathStats.dev !== after.dev || pathStats.ino !== after.ino) {
      return {
        state: "invalid",
        reason: "sidecar identity changed during read"
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { state: "invalid", reason: "invalid sidecar JSON" };
    }
    if (!isValidWorktreeSession(parsed)) {
      return { state: "invalid", reason: "invalid sidecar contents" };
    }
    return { state: "valid", session: parsed };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return observedSidecar ? { state: "invalid", reason: "sidecar disappeared during read" } : { state: "missing" };
    }
    return {
      state: "invalid",
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
__name(readWorktreeSessionStrict, "readWorktreeSessionStrict");
async function writeWorktreeSession(filePath, session) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, session);
}
__name(writeWorktreeSession, "writeWorktreeSession");
async function clearWorktreeSession(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}
__name(clearWorktreeSession, "clearWorktreeSession");
async function isSessionRuntimeActive(sessionId, projectRoots) {
  const roots = uniquePaths(
    (Array.isArray(projectRoots) ? projectRoots : [projectRoots]).map(
      (root) => path.resolve(root)
    )
  );
  const runtimeBases = getRuntimeBaseCandidates(roots);
  let sawDeadRuntimeStatus = false;
  for (const runtimeBase of runtimeBases) {
    for (const projectRoot of roots) {
      const statusPath = await Storage.runWithRuntimeBaseDir(
        runtimeBase,
        void 0,
        async () => new Storage(projectRoot).getRuntimeStatusPath(sessionId)
      );
      const statusState = await getRuntimeStatusPathState(
        statusPath,
        sessionId
      );
      if (statusState === "active") {
        return true;
      }
      sawDeadRuntimeStatus ||= statusState === "dead";
    }
    const baseState = await getRuntimeStatusStateInBase(runtimeBase, sessionId);
    if (baseState === "active") {
      return true;
    }
    sawDeadRuntimeStatus ||= baseState === "dead";
  }
  const scanResult = await scanRuntimeStatusUnderRoots(roots, sessionId);
  if (scanResult === "active" || scanResult === "incomplete") {
    return true;
  }
  return !sawDeadRuntimeStatus;
}
__name(isSessionRuntimeActive, "isSessionRuntimeActive");
function getRuntimeBaseCandidates(projectRoots) {
  const currentBase = path.resolve(Storage.getRuntimeBaseDir());
  const candidates = [currentBase];
  for (const root of projectRoots) {
    const rel = path.relative(root, currentBase);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    for (const candidateRoot of projectRoots) {
      candidates.push(path.resolve(candidateRoot, rel));
    }
  }
  return uniquePaths(candidates);
}
__name(getRuntimeBaseCandidates, "getRuntimeBaseCandidates");
async function getRuntimeStatusStateInBase(runtimeBase, sessionId) {
  const projectsDir = path.join(runtimeBase, "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  let sawDeadRuntimeStatus = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statusPath = path.join(
      projectsDir,
      entry.name,
      "chats",
      `${sessionId}.runtime.json`
    );
    const statusState = await getRuntimeStatusPathState(statusPath, sessionId);
    if (statusState === "active") {
      return "active";
    }
    sawDeadRuntimeStatus ||= statusState === "dead";
  }
  return sawDeadRuntimeStatus ? "dead" : "missing";
}
__name(getRuntimeStatusStateInBase, "getRuntimeStatusStateInBase");
async function scanRuntimeStatusUnderRoots(roots, sessionId) {
  const seen = /* @__PURE__ */ new Set();
  const state = { dirs: 0 };
  let sawDeadRuntimeStatus = false;
  for (const root of roots) {
    const result = await scanRuntimeStatusDir(root, sessionId, seen, state);
    if (result === "active" || result === "incomplete") {
      return result;
    }
    sawDeadRuntimeStatus ||= result === "dead";
  }
  return sawDeadRuntimeStatus ? "dead" : "not-found";
}
__name(scanRuntimeStatusUnderRoots, "scanRuntimeStatusUnderRoots");
async function scanRuntimeStatusDir(dir, sessionId, seen, state) {
  if (state.dirs >= RUNTIME_STATUS_SCAN_MAX_DIRS) {
    return "incomplete";
  }
  state.dirs++;
  const realDir = await fs.realpath(dir).catch(() => path.resolve(dir));
  if (seen.has(realDir)) {
    return "not-found";
  }
  seen.add(realDir);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "not-found";
    }
    throw error;
  }
  let sawDeadRuntimeStatus = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.name === "projects") {
      const baseState = await getRuntimeStatusStateInBase(dir, sessionId);
      if (baseState === "active") {
        return "active";
      }
      sawDeadRuntimeStatus ||= baseState === "dead";
      continue;
    }
    if (shouldSkipRuntimeStatusScanDir(entry.name, dir)) {
      continue;
    }
    const result = await scanRuntimeStatusDir(child, sessionId, seen, state);
    if (result !== "not-found") {
      if (result === "dead") {
        sawDeadRuntimeStatus = true;
        continue;
      }
      return result;
    }
  }
  return sawDeadRuntimeStatus ? "dead" : "not-found";
}
__name(scanRuntimeStatusDir, "scanRuntimeStatusDir");
function shouldSkipRuntimeStatusScanDir(name, parent) {
  if (RUNTIME_STATUS_SCAN_SKIP_DIRS.has(name)) {
    return true;
  }
  return name === "worktrees" && path.basename(parent) === ".qwen";
}
__name(shouldSkipRuntimeStatusScanDir, "shouldSkipRuntimeStatusScanDir");
async function getRuntimeStatusPathState(statusPath, sessionId) {
  const status = await readRuntimeStatus(statusPath);
  if (!status || status.sessionId !== sessionId) {
    return "missing";
  }
  if (status.hostname !== os.hostname()) {
    return "active";
  }
  try {
    process.kill(status.pid, 0);
    return "active";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return "dead";
    }
    return "active";
  }
}
__name(getRuntimeStatusPathState, "getRuntimeStatusPathState");
function uniquePaths(paths) {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}
__name(uniquePaths, "uniquePaths");
async function restoreWorktreeContext(sidecarPath, onWarn) {
  let session = null;
  try {
    session = await readWorktreeSession(sidecarPath);
  } catch (error) {
    onWarn?.(error);
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (clearErr) {
      onWarn?.(clearErr);
    }
    return { contextMessage: null, session: null };
  }
  if (!session) {
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (clearErr) {
      onWarn?.(clearErr);
    }
    return { contextMessage: null, session: null };
  }
  if (session.supersededBy !== void 0) {
    onWarn?.(
      new Error(
        `worktree session was superseded by ${session.supersededBy}; not restoring its worktree context.`
      )
    );
    return { contextMessage: null, session: null };
  }
  const expectedParent = path.join(session.originalCwd, ".qwen", "worktrees");
  const resolvedWorktree = path.resolve(session.worktreePath);
  if (!resolvedWorktree.startsWith(expectedParent + path.sep)) {
    onWarn?.(
      new Error(
        `worktreePath ${session.worktreePath} is outside ${expectedParent}; treating sidecar as tampered and clearing.`
      )
    );
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (error) {
      onWarn?.(error);
    }
    return { contextMessage: null, session: null };
  }
  let worktreeAlive = false;
  try {
    const stat2 = await fs.stat(session.worktreePath);
    worktreeAlive = stat2.isDirectory();
  } catch {
    worktreeAlive = false;
  }
  if (!worktreeAlive) {
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (error) {
      onWarn?.(error);
    }
    return { contextMessage: null, session: null };
  }
  return {
    session,
    contextMessage: `[Resumed] Active worktree: "${session.slug}" at ${session.worktreePath} (branch: ${session.worktreeBranch}). Continue using this path for all file operations.`
  };
}
__name(restoreWorktreeContext, "restoreWorktreeContext");

export {
  readWorktreeSession,
  readWorktreeSessionStrict,
  writeWorktreeSession,
  clearWorktreeSession,
  isSessionRuntimeActive,
  restoreWorktreeContext
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
