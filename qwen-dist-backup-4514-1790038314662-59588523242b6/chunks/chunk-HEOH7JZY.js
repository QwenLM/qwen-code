// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/no-follow-open.ts
init_esbuild_shims();
import fs from "node:fs";

// packages/core/src/utils/file-identity.ts
init_esbuild_shims();
function hasVerifiableInode(ino) {
  return Number(ino) !== 0;
}
__name(hasVerifiableInode, "hasVerifiableInode");

// packages/core/src/utils/no-follow-open.ts
var UNVERIFIABLE_IDENTITY_CODE = "EUNVERIFIABLE";
function isUnverifiableIdentityError(error) {
  return typeof error === "object" && error !== null && error.code === UNVERIFIABLE_IDENTITY_CODE;
}
__name(isUnverifiableIdentityError, "isUnverifiableIdentityError");
function noFollowRejection(filePath, reason, code = "ELOOP") {
  const error = new Error(
    `Refusing to open '${filePath}' without a no-follow guarantee: ${reason}`
  );
  error.code = code;
  return error;
}
__name(noFollowRejection, "noFollowRejection");
function assertSameIdentity(filePath, before, after) {
  if (!hasVerifiableInode(before.ino)) {
    throw noFollowRejection(
      filePath,
      "the filesystem reports inode 0, so the opened file cannot be proven identical to the one that was checked",
      UNVERIFIABLE_IDENTITY_CODE
    );
  }
  if (BigInt(before.dev) !== BigInt(after.dev) || BigInt(before.ino) !== BigInt(after.ino)) {
    throw noFollowRejection(
      filePath,
      "the file identity changed between the pre-open check and the open (possible symlink race)"
    );
  }
}
__name(assertSameIdentity, "assertSameIdentity");
function getNoFollowFlag() {
  return fs.constants?.O_NOFOLLOW;
}
__name(getNoFollowFlag, "getNoFollowFlag");
function openSyncNoFollow(filePath) {
  const baseFlags = fs.constants?.O_RDONLY ?? 0;
  const noFollowFlag = getNoFollowFlag();
  if (typeof noFollowFlag === "number") {
    return fs.openSync(filePath, baseFlags | noFollowFlag);
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw noFollowRejection(filePath, "the path is a symlink");
  }
  const fd = fs.openSync(filePath, baseFlags);
  try {
    assertSameIdentity(filePath, before, fs.fstatSync(fd, { bigint: true }));
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
    }
    throw error;
  }
  return fd;
}
__name(openSyncNoFollow, "openSyncNoFollow");
async function openNoFollow(filePath) {
  const baseFlags = fs.constants?.O_RDONLY ?? 0;
  const noFollowFlag = getNoFollowFlag();
  if (typeof noFollowFlag === "number") {
    return fs.promises.open(filePath, baseFlags | noFollowFlag);
  }
  const before = await fs.promises.lstat(filePath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw noFollowRejection(filePath, "the path is a symlink");
  }
  const handle = await fs.promises.open(filePath, baseFlags);
  try {
    assertSameIdentity(filePath, before, await handle.stat({ bigint: true }));
  } catch (error) {
    await handle.close().catch(() => {
    });
    throw error;
  }
  return handle;
}
__name(openNoFollow, "openNoFollow");

export {
  hasVerifiableInode,
  isUnverifiableIdentityError,
  openSyncNoFollow,
  openNoFollow
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
