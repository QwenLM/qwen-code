// Force strict mode and setup for ESM
"use strict";
import {
  ConversationRuntimeOwnershipError,
  LIVE_HOST_PROTOCOL_VERSION,
  conversationRuntimeInUseError,
  conversationRuntimeOwnershipCompromisedError,
  conversationRuntimeUnavailableError
} from "./chunk-Y5TM7SBV.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/live/discovery.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import * as path from "node:path";
var LIVE_DISCOVERY_RELATIVE_PATH = path.join("live", "daemon.json");
var MAX_DISCOVERY_BYTES = 16 * 1024;
var NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
var DEFAULT_HANDOFF_GRACE_MS = 1e3;
var LOCK_OPTIONS = {
  realpath: false,
  stale: 1e4,
  update: 2e3,
  retries: {
    retries: 120,
    minTimeout: 10,
    maxTimeout: 100,
    factor: 1.2,
    randomize: true
  }
};
var LiveDiscoveryOwnerActiveError = class extends Error {
  constructor(ownerPid) {
    super(`Live discovery is owned by active daemon pid ${ownerPid}.`);
    this.ownerPid = ownerPid;
    this.name = "LiveDiscoveryOwnerActiveError";
  }
  static {
    __name(this, "LiveDiscoveryOwnerActiveError");
  }
};
var LiveDiscoveryStateError = class extends Error {
  static {
    __name(this, "LiveDiscoveryStateError");
  }
  constructor(cause) {
    super("Existing Live discovery record is invalid.", { cause });
    this.name = "LiveDiscoveryStateError";
  }
};
var LiveDiscoveryPublicationError = class extends Error {
  static {
    __name(this, "LiveDiscoveryPublicationError");
  }
  published = true;
  constructor(cause) {
    super("Live discovery publication completed with cleanup errors.", {
      cause
    });
    this.name = "LiveDiscoveryPublicationError";
  }
};
function getStableLiveDiscoveryBaseDir(homeDirectory = homedir()) {
  return path.join(homeDirectory, ".qwen");
}
__name(getStableLiveDiscoveryBaseDir, "getStableLiveDiscoveryBaseDir");
function getLiveDiscoveryPath(runtimeBaseDir) {
  return path.join(runtimeBaseDir, LIVE_DISCOVERY_RELATIVE_PATH);
}
__name(getLiveDiscoveryPath, "getLiveDiscoveryPath");
function assertSafeRecord(record) {
  if (typeof record.url !== "string" || typeof record.instanceNonce !== "string" || record.token !== void 0 && typeof record.token !== "string") {
    throw new Error("Live discovery record is invalid.");
  }
  let url;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("Live discovery URL is invalid.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || isIP(hostname) === 4 && hostname.startsWith("127.");
  if (url.protocol !== "http:" && url.protocol !== "https:" || !loopback || url.username.length > 0 || url.password.length > 0) {
    throw new Error("Live discovery URL must be a loopback HTTP URL.");
  }
  if (!Number.isSafeInteger(record.protocolVersion) || record.protocolVersion <= 0 || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !NONCE_PATTERN.test(record.instanceNonce) || record.token !== void 0 && (record.token.length === 0 || record.token.length > 4096)) {
    throw new Error("Live discovery record is invalid.");
  }
}
__name(assertSafeRecord, "assertSafeRecord");
function assertRecord(record) {
  assertSafeRecord(record);
  if (record.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION) {
    throw new Error("Live discovery record is invalid.");
  }
}
__name(assertRecord, "assertRecord");
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
__name(processIsAlive, "processIsAlive");
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
__name(delay, "delay");
async function readExistingRecord(filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== "win32" && ((stat.mode & 511) !== 384 || typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size <= 0 || stat.size > MAX_DISCOVERY_BYTES) {
    throw new LiveDiscoveryStateError();
  }
  let handle;
  try {
    handle = await fs.open(
      filePath,
      process.platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new LiveDiscoveryStateError(error);
    }
    throw error;
  }
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.nlink !== 1 || handleStat.dev !== stat.dev || handleStat.ino !== stat.ino || handleStat.size !== stat.size || process.platform !== "win32" && ((handleStat.mode & 511) !== 384 || typeof process.getuid === "function" && handleStat.uid !== process.getuid())) {
      throw new LiveDiscoveryStateError();
    }
    const serialized = await handle.readFile("utf8");
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new LiveDiscoveryStateError(error);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new LiveDiscoveryStateError();
    }
    const record = parsed;
    try {
      assertSafeRecord(record);
    } catch {
      throw new LiveDiscoveryStateError();
    }
    return record;
  } finally {
    await handle.close();
  }
}
__name(readExistingRecord, "readExistingRecord");
async function inspectDirectory(directory, requirePrivateMode = true) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (requirePrivateMode && (stat.mode & 511) !== 448 || typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new LiveDiscoveryStateError();
  }
  return { directory, dev: stat.dev, ino: stat.ino };
}
__name(inspectDirectory, "inspectDirectory");
async function assertDirectoryIdentity(expected, requirePrivateMode = true) {
  const current = await inspectDirectory(
    expected.directory,
    requirePrivateMode
  );
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new LiveDiscoveryStateError();
  }
}
__name(assertDirectoryIdentity, "assertDirectoryIdentity");
async function ensureDirectory(directory, requirePrivateMode) {
  try {
    return await inspectDirectory(directory, requirePrivateMode);
  } catch (error) {
    try {
      await fs.lstat(directory);
      throw error;
    } catch (statError) {
      if (statError.code !== "ENOENT") throw error;
    }
  }
  const parent = path.dirname(directory);
  if (parent === directory) throw new LiveDiscoveryStateError();
  const parentIdentity = await ensureDirectory(parent, false);
  await assertDirectoryIdentity(parentIdentity, false);
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (created && process.platform !== "win32") {
    await fs.chmod(directory, 448);
  }
  await assertDirectoryIdentity(parentIdentity, false);
  return inspectDirectory(directory, requirePrivateMode);
}
__name(ensureDirectory, "ensureDirectory");
async function assertLockShapeIfPresent(lockPath) {
  let stat;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new LiveDiscoveryStateError();
  }
}
__name(assertLockShapeIfPresent, "assertLockShapeIfPresent");
async function prepareDirectory(runtimeBaseDir, create = true) {
  const directory = path.dirname(getLiveDiscoveryPath(runtimeBaseDir));
  let runtimeBaseIdentity;
  try {
    runtimeBaseIdentity = await inspectDirectory(runtimeBaseDir, false);
  } catch (error) {
    try {
      await fs.lstat(runtimeBaseDir);
      throw error;
    } catch (statError) {
      if (statError.code !== "ENOENT") throw error;
    }
    if (!create) return void 0;
    runtimeBaseIdentity = await ensureDirectory(runtimeBaseDir, false);
  }
  let created = false;
  try {
    const identity = await inspectDirectory(directory);
    await assertDirectoryIdentity(runtimeBaseIdentity, false);
    return identity;
  } catch (error) {
    try {
      await fs.lstat(directory);
      throw error;
    } catch (statError) {
      if (statError.code !== "ENOENT") throw error;
    }
  }
  if (!create) return void 0;
  await assertDirectoryIdentity(runtimeBaseIdentity, false);
  try {
    await fs.mkdir(directory, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (created && process.platform !== "win32") {
    await fs.chmod(directory, 448);
  }
  await assertDirectoryIdentity(runtimeBaseIdentity, false);
  return inspectDirectory(directory);
}
__name(prepareDirectory, "prepareDirectory");
async function lockDirectory(target) {
  const lockPath = path.join(target.directory, ".daemon.lock");
  await assertLockShapeIfPresent(lockPath);
  const lockfile = (await import("./proper-lockfile-3LHWIM44.js")).default;
  let compromised = false;
  const release = await lockfile.lock(target.directory, {
    ...LOCK_OPTIONS,
    lockfilePath: lockPath,
    onCompromised: /* @__PURE__ */ __name(() => {
      compromised = true;
    }, "onCompromised")
  });
  try {
    await assertLockShapeIfPresent(lockPath);
  } catch (error) {
    let releaseError;
    await release().catch((candidate) => {
      releaseError = candidate;
    });
    throw new LiveDiscoveryStateError(
      releaseError ? new AggregateError(
        [error, releaseError],
        "Live discovery lock validation cleanup failed."
      ) : error
    );
  }
  return {
    release,
    assertHealthy: /* @__PURE__ */ __name(() => {
      if (compromised) throw new LiveDiscoveryStateError();
    }, "assertHealthy")
  };
}
__name(lockDirectory, "lockDirectory");
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
__name(syncDirectory, "syncDirectory");
async function assertLiveDiscoveryPublisher(stableBaseDir, owner) {
  try {
    const target = await prepareDirectory(stableBaseDir, false);
    if (!target) throw conversationRuntimeUnavailableError();
    const lock = await lockDirectory(target);
    let operationError;
    try {
      lock.assertHealthy();
      await assertDirectoryIdentity(target);
      const current = await readExistingRecord(
        getLiveDiscoveryPath(stableBaseDir)
      );
      await assertDirectoryIdentity(target);
      lock.assertHealthy();
      if (!current) throw conversationRuntimeUnavailableError();
      if (current.pid !== owner.pid || current.instanceNonce !== owner.instanceNonce) {
        throw conversationRuntimeInUseError();
      }
      if (current.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION) {
        throw new LiveDiscoveryStateError();
      }
    } catch (error) {
      operationError = error;
    }
    try {
      await lock.release();
      lock.assertHealthy();
    } catch (error) {
      throw new LiveDiscoveryStateError(
        operationError ? new AggregateError(
          [operationError, error],
          "Live discovery admission cleanup failed."
        ) : error
      );
    }
    if (operationError) throw operationError;
  } catch (error) {
    if (error instanceof ConversationRuntimeOwnershipError) throw error;
    if (error instanceof LiveDiscoveryStateError || error.code === "ECOMPROMISED") {
      throw conversationRuntimeOwnershipCompromisedError(error);
    }
    throw conversationRuntimeUnavailableError(error);
  }
}
__name(assertLiveDiscoveryPublisher, "assertLiveDiscoveryPublisher");
async function handoffLiveDiscoveryOwner(runtimeBaseDir, owner, commitOwner, options = {}) {
  const target = await prepareDirectory(runtimeBaseDir, false);
  if (!target) {
    await commitOwner();
    return { reclaimed: false };
  }
  const lock = await lockDirectory(target);
  let result;
  let operationError;
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const filePath = getLiveDiscoveryPath(runtimeBaseDir);
    const current = await readExistingRecord(filePath);
    if (current && (current.pid !== owner.pid || current.instanceNonce !== owner.instanceNonce)) {
      if (current.pid === owner.pid || (options.isProcessAlive ?? processIsAlive)(current.pid)) {
        throw new LiveDiscoveryOwnerActiveError(current.pid);
      }
      await commitOwner();
      lock.assertHealthy();
      await assertDirectoryIdentity(target);
      const confirmed = await readExistingRecord(filePath);
      if (!confirmed || confirmed.pid !== current.pid || confirmed.instanceNonce !== current.instanceNonce) {
        throw new LiveDiscoveryStateError();
      }
      lock.assertHealthy();
      await assertDirectoryIdentity(target);
      await fs.unlink(filePath);
      await syncDirectory(target.directory);
      lock.assertHealthy();
      result = { reclaimed: true };
    } else {
      await commitOwner();
      lock.assertHealthy();
      result = { reclaimed: false };
    }
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  await lock.release().catch((error) => {
    releaseError = error;
  });
  if (releaseError) {
    throw new LiveDiscoveryStateError(
      operationError ? new AggregateError(
        [operationError, releaseError],
        "Live discovery handoff cleanup failed."
      ) : releaseError
    );
  }
  if (operationError) throw operationError;
  if (result?.reclaimed && options.waitForHandoffGrace !== false) {
    await (options.wait ?? delay)(
      options.handoffGraceMs ?? DEFAULT_HANDOFF_GRACE_MS
    );
  }
  return result;
}
__name(handoffLiveDiscoveryOwner, "handoffLiveDiscoveryOwner");
async function writeLiveDiscoveryFile(runtimeBaseDir, record, options = {}) {
  assertRecord(record);
  const target = await prepareDirectory(runtimeBaseDir);
  if (!target) throw new LiveDiscoveryStateError();
  const { directory } = target;
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const temporaryPath = path.join(
    directory,
    `.daemon.${process.pid}.${randomUUID()}.tmp`
  );
  const lock = await lockDirectory(target);
  let handle;
  let operationError;
  let operationSucceeded = false;
  let published = false;
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const current = await readExistingRecord(filePath);
    if (current && (current.pid !== record.pid || current.instanceNonce !== record.instanceNonce)) {
      if ((options.isProcessAlive ?? processIsAlive)(current.pid)) {
        throw new LiveDiscoveryOwnerActiveError(current.pid);
      }
      throw new LiveDiscoveryStateError();
    }
    handle = await fs.open(temporaryPath, "wx", 384);
    const serialized = `${JSON.stringify(record)}
`;
    if (Buffer.byteLength(serialized) > MAX_DISCOVERY_BYTES) {
      throw new Error("Live discovery record is too large.");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.chmod(384);
    await handle.sync();
    await handle.close();
    handle = void 0;
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    await fs.rename(temporaryPath, filePath);
    published = true;
    await syncDirectory(directory);
    lock.assertHealthy();
    operationSucceeded = true;
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  await handle?.close().catch((error) => cleanupErrors.push(error));
  await fs.unlink(temporaryPath).catch((error) => {
    if (error.code !== "ENOENT") cleanupErrors.push(error);
  });
  await lock.release().catch((error) => cleanupErrors.push(error));
  if (!operationSucceeded) {
    const cause = cleanupErrors.length > 0 ? new AggregateError(
      [operationError, ...cleanupErrors],
      "Live discovery publication cleanup failed."
    ) : operationError;
    if (published) throw new LiveDiscoveryPublicationError(cause);
    if (cleanupErrors.length > 0) {
      throw cause;
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new LiveDiscoveryPublicationError(
      new AggregateError(
        cleanupErrors,
        "Live discovery publication cleanup failed."
      )
    );
  }
  return filePath;
}
__name(writeLiveDiscoveryFile, "writeLiveDiscoveryFile");
async function removeLiveDiscoveryFile(runtimeBaseDir, owner) {
  if (!NONCE_PATTERN.test(owner.instanceNonce) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new LiveDiscoveryStateError();
  }
  const target = await prepareDirectory(runtimeBaseDir, false);
  if (!target) return false;
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const lock = await lockDirectory(target);
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const current = await readExistingRecord(filePath);
    if (!current) return false;
    if (current.instanceNonce !== owner.instanceNonce || current.pid !== owner.pid) {
      throw new LiveDiscoveryStateError();
    }
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    await fs.unlink(filePath);
    await syncDirectory(target.directory);
    lock.assertHealthy();
    return true;
  } finally {
    await lock.release();
  }
}
__name(removeLiveDiscoveryFile, "removeLiveDiscoveryFile");

export {
  LIVE_DISCOVERY_RELATIVE_PATH,
  LiveDiscoveryOwnerActiveError,
  LiveDiscoveryStateError,
  LiveDiscoveryPublicationError,
  getStableLiveDiscoveryBaseDir,
  getLiveDiscoveryPath,
  assertLiveDiscoveryPublisher,
  handoffLiveDiscoveryOwner,
  writeLiveDiscoveryFile,
  removeLiveDiscoveryFile
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
