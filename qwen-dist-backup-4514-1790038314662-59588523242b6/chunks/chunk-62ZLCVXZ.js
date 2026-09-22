// Force strict mode and setup for ESM
"use strict";
import {
  MAX_WORKSPACE_PATH_LENGTH,
  canonicalizeWorkspace
} from "./chunk-6PLDPT2C.js";
import {
  getGlobalQwenDirLite
} from "./chunk-IDS7MSUP.js";
import {
  isWithinRoot
} from "./chunk-MR3PXB6E.js";
import {
  isUnverifiableIdentityError,
  openNoFollow
} from "./chunk-HEOH7JZY.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-registration-store.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// packages/cli/src/serve/workspace-inputs.ts
init_esbuild_shims();
var MAX_REGISTERED_WORKSPACES = 256;
var MAX_CONFIGURED_REGISTERED_WORKSPACES = 256;
var QWEN_SERVE_MAX_WORKSPACES_ENV = "QWEN_SERVE_MAX_WORKSPACES";
function resolveMaxRegisteredWorkspaces(configured, env) {
  const raw = env[QWEN_SERVE_MAX_WORKSPACES_ENV];
  const value = configured ?? (raw === void 0 ? MAX_REGISTERED_WORKSPACES : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_REGISTERED_WORKSPACES) {
    const source = configured === void 0 ? `${QWEN_SERVE_MAX_WORKSPACES_ENV}=${JSON.stringify(raw)}` : `maxRegisteredWorkspaces option ${String(configured)}`;
    throw new TypeError(
      `Invalid ${source}: must be an integer from 1 to ${MAX_CONFIGURED_REGISTERED_WORKSPACES}.`
    );
  }
  return value;
}
__name(resolveMaxRegisteredWorkspaces, "resolveMaxRegisteredWorkspaces");
var DuplicateWorkspaceInputError = class extends Error {
  static {
    __name(this, "DuplicateWorkspaceInputError");
  }
  constructor(workspace) {
    super(
      `Duplicate --workspace value resolves to ${JSON.stringify(workspace)}. Pass distinct --workspace values.`
    );
    this.name = "DuplicateWorkspaceInputError";
  }
};
var NestedWorkspaceInputError = class extends Error {
  static {
    __name(this, "NestedWorkspaceInputError");
  }
  constructor(parent, child) {
    super(
      `Nested --workspace values are not supported yet: ${JSON.stringify(child)} is inside ${JSON.stringify(parent)}. Pass non-nested --workspace values.`
    );
    this.name = "NestedWorkspaceInputError";
  }
};
var MissingWorkspaceInputError = class extends Error {
  static {
    __name(this, "MissingWorkspaceInputError");
  }
  constructor() {
    super("--workspace requires a value.");
    this.name = "MissingWorkspaceInputError";
  }
};
function normalizeWorkspaceInputs(workspace) {
  if (Array.isArray(workspace)) {
    if (workspace.length === 0) {
      throw new MissingWorkspaceInputError();
    }
    return workspace.map((value) => String(value));
  }
  if (workspace === void 0) return [process.cwd()];
  return [String(workspace)];
}
__name(normalizeWorkspaceInputs, "normalizeWorkspaceInputs");
function isNestedWorkspace(parent, child) {
  return parent !== child && isWithinRoot(child, parent);
}
__name(isNestedWorkspace, "isNestedWorkspace");
function rejectDuplicateOrNestedWorkspaceInputs(workspaces) {
  if (workspaces.length <= 1) return;
  let canonicalWorkspaces;
  try {
    canonicalWorkspaces = workspaces.map(
      (workspace) => canonicalizeWorkspace(workspace)
    );
  } catch {
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const workspace of canonicalWorkspaces) {
    if (seen.has(workspace)) {
      throw new DuplicateWorkspaceInputError(workspace);
    }
    seen.add(workspace);
  }
  for (let i = 0; i < canonicalWorkspaces.length; i++) {
    for (let j = i + 1; j < canonicalWorkspaces.length; j++) {
      const first = canonicalWorkspaces[i];
      const second = canonicalWorkspaces[j];
      if (isNestedWorkspace(first, second)) {
        throw new NestedWorkspaceInputError(first, second);
      }
      if (isNestedWorkspace(second, first)) {
        throw new NestedWorkspaceInputError(second, first);
      }
    }
  }
}
__name(rejectDuplicateOrNestedWorkspaceInputs, "rejectDuplicateOrNestedWorkspaceInputs");
function resolveWorkspaceInputs(workspace) {
  const workspaces = normalizeWorkspaceInputs(workspace);
  rejectDuplicateOrNestedWorkspaceInputs(workspaces);
  return workspaces;
}
__name(resolveWorkspaceInputs, "resolveWorkspaceInputs");

// packages/cli/src/serve/workspace-registration-store.ts
var SCHEMA_VERSION = 1;
var MAX_SECONDARY_WORKSPACES = MAX_CONFIGURED_REGISTERED_WORKSPACES - 1;
var MAX_STORE_BYTES = 8 * 1024 * 1024;
var MAX_WORKSPACE_DISPLAY_NAME_LENGTH = 256;
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
var WorkspaceDisplayNameValidationError = class extends Error {
  static {
    __name(this, "WorkspaceDisplayNameValidationError");
  }
  constructor(message) {
    super(message);
    this.name = "WorkspaceDisplayNameValidationError";
  }
};
function containsDisplayNameControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
__name(containsDisplayNameControlCharacter, "containsDisplayNameControlCharacter");
function normalizeWorkspaceDisplayName(value) {
  if (typeof value !== "string") {
    throw new WorkspaceDisplayNameValidationError(
      "Workspace display name must be a string"
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_WORKSPACE_DISPLAY_NAME_LENGTH) {
    throw new WorkspaceDisplayNameValidationError(
      `Workspace display name exceeds ${MAX_WORKSPACE_DISPLAY_NAME_LENGTH} characters`
    );
  }
  if (containsDisplayNameControlCharacter(trimmed)) {
    throw new WorkspaceDisplayNameValidationError(
      "Workspace display name contains control characters"
    );
  }
  return trimmed.length === 0 ? void 0 : trimmed;
}
__name(normalizeWorkspaceDisplayName, "normalizeWorkspaceDisplayName");
var WorkspaceRegistrationStoreError = class extends Error {
  static {
    __name(this, "WorkspaceRegistrationStoreError");
  }
  constructor(message) {
    super(message);
    this.name = "WorkspaceRegistrationStoreError";
  }
};
var WorkspaceRegistrationStoreLimitError = class extends WorkspaceRegistrationStoreError {
  static {
    __name(this, "WorkspaceRegistrationStoreLimitError");
  }
};
var WorkspaceRegistrationStoreTooLargeError = class extends WorkspaceRegistrationStoreError {
  static {
    __name(this, "WorkspaceRegistrationStoreTooLargeError");
  }
};
var WorkspaceRegistrationStoreCommittedError = class extends WorkspaceRegistrationStoreError {
  static {
    __name(this, "WorkspaceRegistrationStoreCommittedError");
  }
};
function normalizedScopePath(primaryWorkspace) {
  return os.platform() === "win32" ? primaryWorkspace.toLowerCase() : primaryWorkspace;
}
__name(normalizedScopePath, "normalizedScopePath");
function workspaceRegistrationScopeHash(primaryWorkspace) {
  return createHash("sha256").update(normalizedScopePath(primaryWorkspace)).digest("hex");
}
__name(workspaceRegistrationScopeHash, "workspaceRegistrationScopeHash");
function workspaceRegistrationId(workspace) {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}
__name(workspaceRegistrationId, "workspaceRegistrationId");
function getWorkspaceRegistrationStorePath(primaryWorkspace, qwenHome = getGlobalQwenDirLite()) {
  return path.join(
    qwenHome,
    "daemon",
    "workspaces",
    `${workspaceRegistrationScopeHash(primaryWorkspace)}.json`
  );
}
__name(getWorkspaceRegistrationStorePath, "getWorkspaceRegistrationStorePath");
function emptySnapshot(primaryWorkspace) {
  return {
    schemaVersion: SCHEMA_VERSION,
    primaryWorkspace,
    workspaces: []
  };
}
__name(emptySnapshot, "emptySnapshot");
function validateWorkspacePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new WorkspaceRegistrationStoreError(
      `${label} must be an absolute path`
    );
  }
  if (value.includes("\0") || value.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new WorkspaceRegistrationStoreError(`${label} is invalid`);
  }
  return value;
}
__name(validateWorkspacePath, "validateWorkspacePath");
function validateStoredDisplayName(value, label) {
  let displayName;
  try {
    displayName = normalizeWorkspaceDisplayName(value);
  } catch (err) {
    throw new WorkspaceRegistrationStoreError(
      `${label} is invalid: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (displayName === void 0) {
    throw new WorkspaceRegistrationStoreError(`${label} must not be empty`);
  }
  return displayName;
}
__name(validateStoredDisplayName, "validateStoredDisplayName");
function setSnapshotDisplayName(snapshot, registrationId, displayName) {
  if (displayName === void 0) {
    if (!snapshot.displayNames || !Object.hasOwn(snapshot.displayNames, registrationId)) {
      return false;
    }
    delete snapshot.displayNames[registrationId];
    if (Object.keys(snapshot.displayNames).length === 0) {
      delete snapshot.displayNames;
    }
    return true;
  }
  if (snapshot.displayNames?.[registrationId] === displayName) return false;
  snapshot.displayNames ??= {};
  snapshot.displayNames[registrationId] = displayName;
  return true;
}
__name(setSnapshotDisplayName, "setSnapshotDisplayName");
function parseSnapshot(raw, primaryWorkspace) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkspaceRegistrationStoreError(
      "Workspace registration store contains malformed JSON"
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceRegistrationStoreError(
      "Workspace registration store root must be an object"
    );
  }
  const record = value;
  if (record["schemaVersion"] !== SCHEMA_VERSION) {
    throw new WorkspaceRegistrationStoreError(
      `Unsupported workspace registration schema ${String(record["schemaVersion"])}`
    );
  }
  const storedPrimary = validateWorkspacePath(
    record["primaryWorkspace"],
    "primaryWorkspace"
  );
  if (normalizedScopePath(storedPrimary) !== normalizedScopePath(primaryWorkspace)) {
    throw new WorkspaceRegistrationStoreError(
      "Workspace registration store primary does not match this daemon"
    );
  }
  if (!Array.isArray(record["workspaces"])) {
    throw new WorkspaceRegistrationStoreError(
      "Workspace registration store workspaces must be an array"
    );
  }
  if (record["workspaces"].length > MAX_SECONDARY_WORKSPACES) {
    throw new WorkspaceRegistrationStoreError(
      `Workspace registration store exceeds ${MAX_SECONDARY_WORKSPACES} entries`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const workspaces = record["workspaces"].map((entry, index) => {
    const workspace = validateWorkspacePath(entry, `workspaces[${index}]`);
    const normalizedWorkspace = normalizedScopePath(workspace);
    if (normalizedWorkspace === normalizedScopePath(primaryWorkspace)) {
      throw new WorkspaceRegistrationStoreError(
        "Primary workspace cannot be stored as a secondary registration"
      );
    }
    if (seen.has(normalizedWorkspace)) {
      throw new WorkspaceRegistrationStoreError(
        "Workspace registration store contains duplicate paths"
      );
    }
    seen.add(normalizedWorkspace);
    return workspace;
  });
  const rawDisplayNames = record["displayNames"];
  let displayNames;
  if (rawDisplayNames !== void 0) {
    if (typeof rawDisplayNames !== "object" || rawDisplayNames === null || Array.isArray(rawDisplayNames)) {
      throw new WorkspaceRegistrationStoreError(
        "Workspace registration store displayNames must be an object"
      );
    }
    const registrationIds = new Set(workspaces.map(workspaceRegistrationId));
    for (const [registrationId, value2] of Object.entries(rawDisplayNames)) {
      if (!registrationIds.has(registrationId)) {
        throw new WorkspaceRegistrationStoreError(
          `Workspace registration store displayNames contains unknown registration id ${JSON.stringify(registrationId)}`
        );
      }
      displayNames ??= {};
      displayNames[registrationId] = validateStoredDisplayName(
        value2,
        `displayNames[${JSON.stringify(registrationId)}]`
      );
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    primaryWorkspace,
    workspaces,
    ...displayNames ? { displayNames } : {}
  };
}
__name(parseSnapshot, "parseSnapshot");
var updateChains = /* @__PURE__ */ new Map();
async function withInProcessLock(filePath, work) {
  const previous = updateChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => void 0).finally(() => {
    if (updateChains.get(filePath) === settled) updateChains.delete(filePath);
  });
  updateChains.set(filePath, settled);
  return next;
}
__name(withInProcessLock, "withInProcessLock");
function compromisedLockError() {
  return new WorkspaceRegistrationStoreError(
    "Workspace registration store lock was compromised"
  );
}
__name(compromisedLockError, "compromisedLockError");
async function acquireFileLock(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 448 });
  let compromised = false;
  const release = await import_proper_lockfile.default.lock(filePath, {
    ...LOCK_OPTIONS,
    onCompromised: /* @__PURE__ */ __name(() => {
      compromised = true;
    }, "onCompromised")
  });
  return {
    assertOwned: /* @__PURE__ */ __name(() => {
      if (compromised) throw compromisedLockError();
    }, "assertOwned"),
    release: /* @__PURE__ */ __name(async () => {
      try {
        await release();
      } catch (err) {
        if (!compromised) throw err;
      }
      if (compromised) throw compromisedLockError();
    }, "release")
  };
}
__name(acquireFileLock, "acquireFileLock");
var WorkspaceRegistrationStore = class {
  constructor(primaryWorkspace, qwenHome) {
    this.primaryWorkspace = primaryWorkspace;
    validateWorkspacePath(primaryWorkspace, "primaryWorkspace");
    this.filePath = getWorkspaceRegistrationStorePath(
      primaryWorkspace,
      qwenHome
    );
  }
  static {
    __name(this, "WorkspaceRegistrationStore");
  }
  filePath;
  /** Returns an unlocked point-in-time snapshot; mutations re-read under lock. */
  async read() {
    try {
      const entry = await fs.lstat(this.filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new WorkspaceRegistrationStoreError(
          "Workspace registration store must be a regular file"
        );
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        return emptySnapshot(this.primaryWorkspace);
      }
      throw err;
    }
    let file;
    try {
      file = await openNoFollow(this.filePath);
    } catch (err) {
      if (err.code === "ENOENT") {
        return emptySnapshot(this.primaryWorkspace);
      }
      if (isUnverifiableIdentityError(err)) {
        throw new WorkspaceRegistrationStoreError(
          "Workspace registration store identity could not be verified"
        );
      }
      if (err.code === "ELOOP") {
        throw new WorkspaceRegistrationStoreError(
          "Workspace registration store must be a regular file"
        );
      }
      throw err;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new WorkspaceRegistrationStoreError(
          "Workspace registration store must be a regular file"
        );
      }
      if (stat.size > MAX_STORE_BYTES) {
        throw new WorkspaceRegistrationStoreTooLargeError(
          `Workspace registration store exceeds ${MAX_STORE_BYTES} bytes`
        );
      }
      let buffer = Buffer.alloc(
        Math.max(1, Math.min(stat.size + 1, MAX_STORE_BYTES + 1))
      );
      let totalBytesRead = 0;
      for (; ; ) {
        if (totalBytesRead === buffer.length) {
          if (totalBytesRead > MAX_STORE_BYTES) break;
          const grown = Buffer.alloc(
            Math.min(
              MAX_STORE_BYTES + 1,
              Math.max(buffer.length * 2, totalBytesRead + 1)
            )
          );
          buffer.copy(grown, 0, 0, totalBytesRead);
          buffer = grown;
        }
        const { bytesRead } = await file.read(
          buffer,
          totalBytesRead,
          buffer.length - totalBytesRead,
          totalBytesRead
        );
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      if (totalBytesRead > MAX_STORE_BYTES) {
        throw new WorkspaceRegistrationStoreTooLargeError(
          `Workspace registration store exceeds ${MAX_STORE_BYTES} bytes`
        );
      }
      return parseSnapshot(
        buffer.toString("utf8", 0, totalBytesRead),
        this.primaryWorkspace
      );
    } finally {
      await file.close();
    }
  }
  async add(workspace, displayName, maxRegisteredWorkspaces = MAX_REGISTERED_WORKSPACES) {
    const maxSecondaries = resolveMaxRegisteredWorkspaces(maxRegisteredWorkspaces, {}) - 1;
    validateWorkspacePath(workspace, "workspace");
    const normalizedDisplayName = displayName === void 0 ? void 0 : normalizeWorkspaceDisplayName(displayName);
    if (normalizedScopePath(workspace) === normalizedScopePath(this.primaryWorkspace)) {
      throw new WorkspaceRegistrationStoreError(
        "Primary workspace cannot be stored as a secondary registration"
      );
    }
    return this.update((snapshot) => {
      const normalizedWorkspace = normalizedScopePath(workspace);
      if (snapshot.workspaces.some(
        (stored) => normalizedScopePath(stored) === normalizedWorkspace
      )) {
        return false;
      }
      if (snapshot.workspaces.length >= maxSecondaries) {
        throw new WorkspaceRegistrationStoreLimitError(
          `Workspace registration store limit of ${maxSecondaries} reached`
        );
      }
      snapshot.workspaces.push(workspace);
      if (normalizedDisplayName !== void 0) {
        snapshot.displayNames ??= {};
        snapshot.displayNames[workspaceRegistrationId(workspace)] = normalizedDisplayName;
      }
      return true;
    });
  }
  async removeById(id) {
    return await this.removeByIds([id]) > 0;
  }
  async setDisplayNameByIds(ids, displayName) {
    const normalizedDisplayName = displayName === void 0 ? void 0 : normalizeWorkspaceDisplayName(displayName);
    const requested = new Set(ids);
    if (requested.size === 0) return 0;
    let matched = 0;
    await this.update((snapshot) => {
      let changed = false;
      for (const workspace of snapshot.workspaces) {
        const registrationId = workspaceRegistrationId(workspace);
        if (!requested.has(registrationId)) continue;
        matched++;
        changed = setSnapshotDisplayName(
          snapshot,
          registrationId,
          normalizedDisplayName
        ) || changed;
      }
      return changed;
    });
    return matched;
  }
  async removeByIds(ids) {
    const requested = new Set(ids);
    if (requested.size === 0) return 0;
    let removed = 0;
    await this.update((snapshot) => {
      const removedIds = /* @__PURE__ */ new Set();
      const retained = snapshot.workspaces.filter((workspace) => {
        const registrationId = workspaceRegistrationId(workspace);
        if (!requested.has(registrationId)) return true;
        removed++;
        removedIds.add(registrationId);
        return false;
      });
      if (removed === 0) return false;
      snapshot.workspaces.splice(0, snapshot.workspaces.length, ...retained);
      for (const registrationId of removedIds) {
        setSnapshotDisplayName(snapshot, registrationId, void 0);
      }
      return true;
    });
    return removed;
  }
  async update(mutate) {
    const { atomicWriteFile } = await import("./deferred-core-runtime-2IG4SLGP.js");
    return withInProcessLock(this.filePath, async () => {
      const lock = await acquireFileLock(this.filePath);
      let committed = false;
      let changed = false;
      let workError;
      try {
        const snapshot = await this.read();
        lock.assertOwned();
        changed = mutate(snapshot);
        if (changed) {
          const serialized = `${JSON.stringify(snapshot, null, 2)}
`;
          if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
            throw new WorkspaceRegistrationStoreTooLargeError(
              `Workspace registration store exceeds ${MAX_STORE_BYTES} bytes`
            );
          }
          lock.assertOwned();
          await atomicWriteFile(this.filePath, serialized, {
            mode: 384,
            forceMode: true,
            noFollow: true
          });
          committed = true;
        }
      } catch (err) {
        workError = err;
      }
      let releaseError;
      try {
        await lock.release();
      } catch (err) {
        releaseError = committed ? new WorkspaceRegistrationStoreCommittedError(
          `Workspace registration update committed but lock release failed: ${err instanceof Error ? err.message : String(err)}`
        ) : err;
      }
      if (workError instanceof Error && releaseError !== void 0 && workError.cause === void 0) {
        workError.cause = releaseError;
      }
      if (workError !== void 0) throw workError;
      if (releaseError !== void 0) throw releaseError;
      return changed;
    });
  }
};

export {
  MAX_REGISTERED_WORKSPACES,
  resolveMaxRegisteredWorkspaces,
  resolveWorkspaceInputs,
  MAX_WORKSPACE_DISPLAY_NAME_LENGTH,
  WorkspaceDisplayNameValidationError,
  normalizeWorkspaceDisplayName,
  WorkspaceRegistrationStoreError,
  WorkspaceRegistrationStoreLimitError,
  WorkspaceRegistrationStoreTooLargeError,
  WorkspaceRegistrationStoreCommittedError,
  workspaceRegistrationScopeHash,
  workspaceRegistrationId,
  getWorkspaceRegistrationStorePath,
  WorkspaceRegistrationStore
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
