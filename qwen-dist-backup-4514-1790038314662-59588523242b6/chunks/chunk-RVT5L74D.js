// Force strict mode and setup for ESM
"use strict";
import {
  MEMORY_PROJECT_SCOPES
} from "./chunk-HD7O6WLV.js";
import {
  QWEN_DIR,
  Storage,
  realpathNearestExisting,
  resolvePath,
  sanitizeCwd
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/memory/paths.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var AUTO_MEMORY_DIRNAME = "memory";
var AUTO_MEMORY_INDEX_FILENAME = "MEMORY.md";
var AUTO_MEMORY_PINNED_DIRNAME = "pinned";
var AUTO_MEMORY_METADATA_FILENAME = "meta.json";
var AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = "extract-cursor.json";
var AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = "consolidation.lock";
var USER_AUTO_MEMORY_DIRNAME = "memories";
var TEAM_AUTO_MEMORY_DIRNAME = "team-memory";
function findGitRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
__name(findGitRoot, "findGitRoot");
function getMemoryBaseDir() {
  if (process.env["QWEN_CODE_MEMORY_BASE_DIR"]) {
    return resolvePath(void 0, process.env["QWEN_CODE_MEMORY_BASE_DIR"]);
  }
  return Storage.getRuntimeBaseDir();
}
__name(getMemoryBaseDir, "getMemoryBaseDir");
var _autoMemoryRootCache = /* @__PURE__ */ new Map();
var _teamAutoMemoryRootCache = /* @__PURE__ */ new Map();
var warnedUnknownMemoryProjectScope = false;
function resolveWorkspaceProjectScope() {
  const raw = process.env["QWEN_CODE_MEMORY_PROJECT_SCOPE"];
  if (raw === void 0) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "workspace") return true;
  if (normalized !== "" && !MEMORY_PROJECT_SCOPES.includes(normalized) && !warnedUnknownMemoryProjectScope) {
    warnedUnknownMemoryProjectScope = true;
    console.warn(
      `[qwen-code] Ignoring unrecognized QWEN_CODE_MEMORY_PROJECT_SCOPE="${raw}"; falling back to "git-root". Expected "git-root" or "workspace".`
    );
  }
  return false;
}
__name(resolveWorkspaceProjectScope, "resolveWorkspaceProjectScope");
function getAutoMemoryRoot(projectRoot) {
  const useLocalMemory = process.env["QWEN_CODE_MEMORY_LOCAL"] === "1";
  const useWorkspaceRoot = resolveWorkspaceProjectScope();
  const memoryBaseDir = useLocalMemory ? "" : getMemoryBaseDir();
  const cacheKey = `${useLocalMemory ? "local" : memoryBaseDir}\0${useWorkspaceRoot ? "workspace" : "git-root"}\0${projectRoot}`;
  const cached = _autoMemoryRootCache.get(cacheKey);
  if (cached !== void 0) return cached;
  let result;
  if (useLocalMemory) {
    result = path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME);
  } else {
    const projectKey = useWorkspaceRoot ? path.resolve(projectRoot) : findGitRoot(projectRoot) ?? path.resolve(projectRoot);
    result = path.join(
      memoryBaseDir,
      "projects",
      sanitizeCwd(projectKey),
      AUTO_MEMORY_DIRNAME
    );
  }
  _autoMemoryRootCache.set(cacheKey, result);
  return result;
}
__name(getAutoMemoryRoot, "getAutoMemoryRoot");
function getAutoMemoryTrustedAnchor(projectRoot) {
  return process.env["QWEN_CODE_MEMORY_LOCAL"] === "1" ? projectRoot : getMemoryBaseDir();
}
__name(getAutoMemoryTrustedAnchor, "getAutoMemoryTrustedAnchor");
function getAutoMemoryProjectStateDir(projectRoot) {
  return path.dirname(getAutoMemoryRoot(projectRoot));
}
__name(getAutoMemoryProjectStateDir, "getAutoMemoryProjectStateDir");
function isAutoMemPath(absolutePath, projectRoot) {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getAutoMemoryRoot(projectRoot));
  const rel = path.relative(memRoot, normalizedPath);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
__name(isAutoMemPath, "isAutoMemPath");
function getAutoMemoryIndexPath(projectRoot) {
  return path.join(getAutoMemoryRoot(projectRoot), AUTO_MEMORY_INDEX_FILENAME);
}
__name(getAutoMemoryIndexPath, "getAutoMemoryIndexPath");
function getAutoMemoryMetadataPath(projectRoot) {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_METADATA_FILENAME
  );
}
__name(getAutoMemoryMetadataPath, "getAutoMemoryMetadataPath");
function getAutoMemoryExtractCursorPath(projectRoot) {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_EXTRACT_CURSOR_FILENAME
  );
}
__name(getAutoMemoryExtractCursorPath, "getAutoMemoryExtractCursorPath");
function getAutoMemoryConsolidationLockPath(projectRoot) {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME
  );
}
__name(getAutoMemoryConsolidationLockPath, "getAutoMemoryConsolidationLockPath");
function getUserAutoMemoryRoot() {
  return path.join(getMemoryBaseDir(), USER_AUTO_MEMORY_DIRNAME);
}
__name(getUserAutoMemoryRoot, "getUserAutoMemoryRoot");
function getUserAutoMemoryIndexPath() {
  return path.join(getUserAutoMemoryRoot(), AUTO_MEMORY_INDEX_FILENAME);
}
__name(getUserAutoMemoryIndexPath, "getUserAutoMemoryIndexPath");
function isUserAutoMemPath(absolutePath) {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getUserAutoMemoryRoot());
  const rel = path.relative(memRoot, normalizedPath);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
__name(isUserAutoMemPath, "isUserAutoMemPath");
function getTeamAutoMemoryRoot(projectRoot) {
  const cached = _teamAutoMemoryRootCache.get(projectRoot);
  if (cached !== void 0) return cached;
  const root = findGitRoot(projectRoot) ?? path.resolve(projectRoot);
  const result = path.join(root, QWEN_DIR, TEAM_AUTO_MEMORY_DIRNAME);
  _teamAutoMemoryRootCache.set(projectRoot, result);
  return result;
}
__name(getTeamAutoMemoryRoot, "getTeamAutoMemoryRoot");
function getTeamAutoMemoryIndexPath(projectRoot) {
  return path.join(
    getTeamAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_INDEX_FILENAME
  );
}
__name(getTeamAutoMemoryIndexPath, "getTeamAutoMemoryIndexPath");
function isTeamAutoMemPath(absolutePath, projectRoot) {
  const normalizedPath = path.normalize(realpathNearestExisting(absolutePath));
  const memRoot = path.normalize(
    realpathNearestExisting(getTeamAutoMemoryRoot(projectRoot))
  );
  const rel = path.relative(memRoot, normalizedPath);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
__name(isTeamAutoMemPath, "isTeamAutoMemPath");
function isManagedMemoryPath(filePath, projectRoot, baseDir = projectRoot) {
  const absolutePath = path.resolve(baseDir, filePath);
  const resolvedPath = path.normalize(realpathNearestExisting(absolutePath));
  const roots = [
    getAutoMemoryRoot(projectRoot),
    getUserAutoMemoryRoot(),
    getTeamAutoMemoryRoot(projectRoot)
  ];
  return roots.some((root) => {
    const resolvedRoot = path.normalize(realpathNearestExisting(root));
    const rel = path.relative(resolvedRoot, resolvedPath);
    return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
__name(isManagedMemoryPath, "isManagedMemoryPath");
function isAnyAutoMemPath(absolutePath, projectRoot) {
  return isAutoMemPath(absolutePath, projectRoot) || isUserAutoMemPath(absolutePath);
}
__name(isAnyAutoMemPath, "isAnyAutoMemPath");

export {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_PINNED_DIRNAME,
  TEAM_AUTO_MEMORY_DIRNAME,
  getMemoryBaseDir,
  getAutoMemoryRoot,
  getAutoMemoryTrustedAnchor,
  getAutoMemoryProjectStateDir,
  isAutoMemPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryConsolidationLockPath,
  getUserAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  isUserAutoMemPath,
  getTeamAutoMemoryRoot,
  getTeamAutoMemoryIndexPath,
  isTeamAutoMemPath,
  isManagedMemoryPath,
  isAnyAutoMemPath
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
