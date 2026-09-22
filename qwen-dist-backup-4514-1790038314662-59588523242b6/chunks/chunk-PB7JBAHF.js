// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/conversation-directory-identity.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
function hasVerifiableInode(ino) {
  return Number.isSafeInteger(ino) && ino > 0;
}
__name(hasVerifiableInode, "hasVerifiableInode");
function normalizedInode(ino) {
  return hasVerifiableInode(ino) ? ino : 0;
}
__name(normalizedInode, "normalizedInode");
var ConversationDirectoryIdentityError = class extends Error {
  constructor(scope, reason, cause) {
    super(
      `Conversation ${scope} identity validation failed: ${reason}`,
      cause !== void 0 ? { cause } : void 0
    );
    this.scope = scope;
    this.reason = reason;
  }
  static {
    __name(this, "ConversationDirectoryIdentityError");
  }
  name = "ConversationDirectoryIdentityError";
};
function throwIdentityIoError(scope, cause) {
  throw new ConversationDirectoryIdentityError(scope, "io_error", cause);
}
__name(throwIdentityIoError, "throwIdentityIoError");
var isSameConversationPath = /* @__PURE__ */ __name((left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right, "isSameConversationPath");
function getConversationDirectoryName(storageSessionId) {
  if (storageSessionId.length === 0 || storageSessionId.length > 256) {
    throw new ConversationDirectoryIdentityError("child", "invalid_session_id");
  }
  return `conversation-${createHash("sha256").update(storageSessionId).digest("hex")}`;
}
__name(getConversationDirectoryName, "getConversationDirectoryName");
function getConversationStagedDirectoryName(storageSessionId) {
  return `${getConversationDirectoryName(storageSessionId)}.deleting`;
}
__name(getConversationStagedDirectoryName, "getConversationStagedDirectoryName");
function validateDirectoryStats(stats, scope) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ConversationDirectoryIdentityError(scope, "not_directory");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ConversationDirectoryIdentityError(scope, "wrong_owner");
  }
  if (process.platform !== "win32" && (stats.mode & 63) !== 0) {
    throw new ConversationDirectoryIdentityError(scope, "wrong_mode");
  }
}
__name(validateDirectoryStats, "validateDirectoryStats");
function hasRootIdentity(stats, root) {
  const inodeVerifiable = hasVerifiableInode(stats.ino);
  return stats.dev === root.device && inodeVerifiable === root.inodeVerifiable && (!inodeVerifiable || stats.ino === root.inode);
}
__name(hasRootIdentity, "hasRootIdentity");
function isSameDirectoryIdentity(before, after) {
  const beforeVerifiable = hasVerifiableInode(before.ino);
  const afterVerifiable = hasVerifiableInode(after.ino);
  return before.dev === after.dev && beforeVerifiable === afterVerifiable && (!beforeVerifiable || before.ino === after.ino);
}
__name(isSameDirectoryIdentity, "isSameDirectoryIdentity");
function hasExpectedDirectoryIdentity(identity, expected) {
  const identityInodeVerifiable = hasVerifiableInode(identity.inode);
  const expectedInodeVerifiable = hasVerifiableInode(expected.inode);
  return identity.storageSessionId === expected.storageSessionId && identity.name === expected.name && isSameConversationPath(identity.canonicalPath, expected.canonicalPath) && identity.device === expected.device && identityInodeVerifiable === expectedInodeVerifiable && (!identityInodeVerifiable || identity.inode === expected.inode) && isSameConversationPath(
    identity.root.configuredRoot,
    expected.root.configuredRoot
  ) && isSameConversationPath(
    identity.root.canonicalRoot,
    expected.root.canonicalRoot
  ) && identity.root.device === expected.root.device && identity.root.inodeVerifiable === expected.root.inodeVerifiable && (!identity.root.inodeVerifiable || identity.root.inode === expected.root.inode);
}
__name(hasExpectedDirectoryIdentity, "hasExpectedDirectoryIdentity");
async function createConversationRootIdentity(configuredRoot) {
  try {
    await mkdir(configuredRoot, { recursive: true, mode: 448 });
  } catch (error) {
    let existing;
    try {
      existing = await lstat(configuredRoot);
    } catch {
      throwIdentityIoError("root", error);
    }
    validateDirectoryStats(existing, "root");
    throwIdentityIoError("root", error);
  }
  let before;
  try {
    before = await lstat(configuredRoot);
  } catch (error) {
    throwIdentityIoError("root", error);
  }
  validateDirectoryStats(before, "root");
  let canonicalRoot;
  let after;
  try {
    canonicalRoot = await realpath(configuredRoot);
    after = await lstat(canonicalRoot);
  } catch (error) {
    throwIdentityIoError("root", error);
  }
  validateDirectoryStats(after, "root");
  if (!isSameDirectoryIdentity(before, after)) {
    throw new ConversationDirectoryIdentityError("root", "identity_changed");
  }
  return {
    configuredRoot,
    canonicalRoot,
    device: after.dev,
    inode: normalizedInode(after.ino),
    inodeVerifiable: hasVerifiableInode(after.ino)
  };
}
__name(createConversationRootIdentity, "createConversationRootIdentity");
async function revalidateConversationRootIdentity(root) {
  let configuredStats;
  try {
    configuredStats = await lstat(root.configuredRoot);
  } catch (error) {
    throwIdentityIoError("root", error);
  }
  validateDirectoryStats(configuredStats, "root");
  if (!hasRootIdentity(configuredStats, root)) {
    throw new ConversationDirectoryIdentityError("root", "identity_changed");
  }
  let canonical;
  try {
    canonical = await realpath(root.configuredRoot);
  } catch (error) {
    throwIdentityIoError("root", error);
  }
  if (!isSameConversationPath(canonical, root.canonicalRoot)) {
    throw new ConversationDirectoryIdentityError(
      "root",
      "canonical_path_changed"
    );
  }
  let canonicalStats;
  try {
    canonicalStats = await lstat(root.canonicalRoot);
  } catch (error) {
    throwIdentityIoError("root", error);
  }
  validateDirectoryStats(canonicalStats, "root");
  if (!hasRootIdentity(canonicalStats, root)) {
    throw new ConversationDirectoryIdentityError("root", "identity_changed");
  }
  return root;
}
__name(revalidateConversationRootIdentity, "revalidateConversationRootIdentity");
async function assertExactConversationRootIdentity(root, candidate) {
  await revalidateConversationRootIdentity(root);
  const resolvedCandidate = resolve(candidate);
  if (!isSameConversationPath(resolvedCandidate, root.configuredRoot) && !isSameConversationPath(resolvedCandidate, root.canonicalRoot)) {
    throw new ConversationDirectoryIdentityError("root", "unexpected_identity");
  }
  let stats;
  let canonical;
  try {
    stats = await lstat(resolvedCandidate);
    validateDirectoryStats(stats, "root");
    canonical = await realpath(resolvedCandidate);
  } catch (error) {
    if (error instanceof ConversationDirectoryIdentityError) throw error;
    throwIdentityIoError("root", error);
  }
  if (!isSameConversationPath(canonical, root.canonicalRoot) || !hasRootIdentity(stats, root)) {
    throw new ConversationDirectoryIdentityError("root", "unexpected_identity");
  }
  return root;
}
__name(assertExactConversationRootIdentity, "assertExactConversationRootIdentity");
async function inspectConversationNamedDirectoryIdentity(root, storageSessionId, name, expected) {
  await revalidateConversationRootIdentity(root);
  const candidate = join(root.canonicalRoot, name);
  let before;
  try {
    before = await lstat(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throwIdentityIoError("child", error);
  }
  validateDirectoryStats(before, "child");
  let canonical;
  let after;
  try {
    canonical = await realpath(candidate);
    after = await lstat(canonical);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throwIdentityIoError("child", error);
  }
  validateDirectoryStats(after, "child");
  const child = relative(root.canonicalRoot, canonical);
  if (child !== name || child.includes(sep) || child.startsWith("..") || isAbsolute(child)) {
    throw new ConversationDirectoryIdentityError("child", "not_direct_child");
  }
  if (!isSameDirectoryIdentity(before, after)) {
    throw new ConversationDirectoryIdentityError("child", "identity_changed");
  }
  await revalidateConversationRootIdentity(root);
  const identity = {
    root,
    storageSessionId,
    name,
    canonicalPath: canonical,
    device: after.dev,
    inode: normalizedInode(after.ino)
  };
  if (expected && !hasExpectedDirectoryIdentity(identity, expected)) {
    throw new ConversationDirectoryIdentityError(
      "child",
      "unexpected_identity"
    );
  }
  return identity;
}
__name(inspectConversationNamedDirectoryIdentity, "inspectConversationNamedDirectoryIdentity");
async function inspectConversationDirectoryIdentity(root, storageSessionId, expected) {
  return inspectConversationNamedDirectoryIdentity(
    root,
    storageSessionId,
    getConversationDirectoryName(storageSessionId),
    expected
  );
}
__name(inspectConversationDirectoryIdentity, "inspectConversationDirectoryIdentity");
async function inspectConversationStagedDirectoryIdentity(root, storageSessionId) {
  return inspectConversationNamedDirectoryIdentity(
    root,
    storageSessionId,
    getConversationStagedDirectoryName(storageSessionId)
  );
}
__name(inspectConversationStagedDirectoryIdentity, "inspectConversationStagedDirectoryIdentity");
function isSameConversationDirectoryObject(identity, expected) {
  const identityInodeVerifiable = hasVerifiableInode(identity.inode);
  const expectedInodeVerifiable = hasVerifiableInode(expected.inode);
  return identity.storageSessionId === expected.storageSessionId && identity.device === expected.device && identityInodeVerifiable === expectedInodeVerifiable && (!identityInodeVerifiable || identity.inode === expected.inode) && isSameConversationPath(
    identity.root.canonicalRoot,
    expected.root.canonicalRoot
  ) && identity.root.device === expected.root.device && identity.root.inodeVerifiable === expected.root.inodeVerifiable && (!identity.root.inodeVerifiable || identity.root.inode === expected.root.inode);
}
__name(isSameConversationDirectoryObject, "isSameConversationDirectoryObject");
async function materializeConversationDirectoryIdentity(root, storageSessionId) {
  await revalidateConversationRootIdentity(root);
  const name = getConversationDirectoryName(storageSessionId);
  const candidate = join(root.canonicalRoot, name);
  let created = false;
  try {
    await mkdir(candidate, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throwIdentityIoError("child", error);
    }
  }
  const identity = await inspectConversationDirectoryIdentity(
    root,
    storageSessionId
  );
  if (!identity) {
    throw new ConversationDirectoryIdentityError("child", "identity_changed");
  }
  return { identity, created };
}
__name(materializeConversationDirectoryIdentity, "materializeConversationDirectoryIdentity");

export {
  hasVerifiableInode,
  normalizedInode,
  ConversationDirectoryIdentityError,
  isSameConversationPath,
  getConversationDirectoryName,
  getConversationStagedDirectoryName,
  isSameDirectoryIdentity,
  createConversationRootIdentity,
  revalidateConversationRootIdentity,
  assertExactConversationRootIdentity,
  inspectConversationDirectoryIdentity,
  inspectConversationStagedDirectoryIdentity,
  isSameConversationDirectoryObject,
  materializeConversationDirectoryIdentity
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
