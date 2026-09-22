// Force strict mode and setup for ESM
"use strict";
import {
  FatalConfigError,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  createContextKey,
  init_esm,
  isSpanContextValid,
  trace
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/paths.ts
init_esbuild_shims();
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as crypto from "node:crypto";
var QWEN_DIR = ".qwen";
var isDirectoryCache = /* @__PURE__ */ new Map();
var VALIDATE_PATH_CACHE_MAX = 1024;
var SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~,]/;
var PATH_ARG_KEYS = [
  "file_path",
  "path",
  "filePath",
  "notebook_path"
];
var UNESCAPE_REGEX = (() => {
  const inner = SHELL_SPECIAL_CHARS.source.slice(1, -1);
  return new RegExp(`\\\\([${inner}])`, "g");
})();
function tildeifyPath(filePath, homeOverride) {
  const rawHomeDir = homeOverride ?? os.homedir();
  if (!rawHomeDir) {
    return filePath;
  }
  const homeDir = path.normalize(rawHomeDir);
  const normalizedPath = path.normalize(filePath);
  if (normalizedPath === homeDir) {
    return "~";
  }
  if (normalizedPath.startsWith(`${homeDir}${path.sep}`)) {
    return normalizedPath.replace(homeDir, "~");
  }
  return filePath;
}
__name(tildeifyPath, "tildeifyPath");
function expandTilde(p) {
  if (!p) {
    return "";
  }
  if (p === "~") {
    return os.homedir();
  }
  if (p === "~/" || p === "~\\") {
    return os.homedir() + path.sep;
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.substring(2));
  }
  if (p.startsWith("~\\")) {
    const rest = p.substring(2);
    const hasTrailingSep = rest.endsWith("/") || rest.endsWith("\\");
    const expandedPath = path.join(
      os.homedir(),
      ...rest.split(/[/\\]+/).filter(Boolean)
    );
    return hasTrailingSep ? expandedPath + path.sep : expandedPath;
  }
  return p;
}
__name(expandTilde, "expandTilde");
function expandHomeDir(p) {
  if (!p) {
    return "";
  }
  const userProfilePrefix = "%userprofile%";
  const lowerPath = p.toLowerCase();
  if (lowerPath === userProfilePrefix) {
    return path.normalize(os.homedir());
  }
  if (lowerPath === `${userProfilePrefix}/` || lowerPath === `${userProfilePrefix}\\`) {
    return path.normalize(os.homedir() + path.sep);
  }
  if (lowerPath.startsWith(`${userProfilePrefix}/`) || lowerPath.startsWith(`${userProfilePrefix}\\`)) {
    const rest = p.substring(userProfilePrefix.length + 1);
    const hasTrailingSep = rest.endsWith("/") || rest.endsWith("\\");
    const expandedPath = path.join(
      os.homedir(),
      ...rest.split(/[/\\]+/).filter(Boolean)
    );
    return path.normalize(
      hasTrailingSep ? expandedPath + path.sep : expandedPath
    );
  }
  if (lowerPath.startsWith(userProfilePrefix)) {
    return path.normalize(os.homedir() + p.substring(userProfilePrefix.length));
  }
  return path.normalize(expandTilde(p));
}
__name(expandHomeDir, "expandHomeDir");
function shortenPath(filePath, maxLen = 80) {
  if (filePath.length <= maxLen) {
    return filePath;
  }
  const separator = path.sep;
  const ellipsis = "...";
  if (maxLen < 10) {
    return filePath.substring(0, maxLen - 3) + ellipsis;
  }
  const parsedPath = path.parse(filePath);
  const root = parsedPath.root;
  const relativePath = filePath.substring(root.length);
  const segments = relativePath.split(separator).filter((s) => s !== "");
  if (segments.length === 0) {
    return root.length <= maxLen ? root : root.substring(0, maxLen - 3) + ellipsis;
  }
  if (segments.length === 1) {
    const full = root + segments[0];
    if (full.length <= maxLen) {
      return full;
    }
    const keepLen = Math.floor((maxLen - 3) / 2);
    const start = full.substring(0, keepLen);
    const end = full.substring(full.length - keepLen);
    return `${start}${ellipsis}${end}`;
  }
  const startPart = root + segments[0];
  const endSegments = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    const segment = segments[i];
    const endPart = [segment, ...endSegments].join(separator);
    const needsEllipsis = i > 1;
    let candidateResult;
    if (needsEllipsis) {
      candidateResult = startPart + separator + ellipsis + separator + endPart;
    } else {
      candidateResult = startPart + separator + endPart;
    }
    if (candidateResult.length <= maxLen) {
      endSegments.unshift(segment);
      if (i === 1) {
        return candidateResult;
      }
    } else {
      break;
    }
  }
  if (endSegments.length === 0) {
    const keepLen = Math.floor((maxLen - 3) / 2);
    const start = filePath.substring(0, keepLen);
    const end = filePath.substring(filePath.length - keepLen);
    return `${start}${ellipsis}${end}`;
  }
  return startPart + separator + ellipsis + separator + endSegments.join(separator);
}
__name(shortenPath, "shortenPath");
function makeRelative(targetPath, rootDirectory) {
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedRootDirectory = path.resolve(rootDirectory);
  if (!isSubpath(resolvedRootDirectory, resolvedTargetPath)) {
    return resolvedTargetPath;
  }
  const relativePath = path.relative(resolvedRootDirectory, resolvedTargetPath);
  return relativePath || ".";
}
__name(makeRelative, "makeRelative");
function formatDisplayPath(filePath, rootDirectory, maxLen = 80) {
  const resolved = resolvePath(rootDirectory, filePath);
  const relative2 = makeRelative(resolved, rootDirectory);
  const display = path.isAbsolute(relative2) ? tildeifyPath(relative2) : relative2;
  return shortenPath(display, maxLen);
}
__name(formatDisplayPath, "formatDisplayPath");
function escapePath(filePath) {
  let result = "";
  for (let i = 0; i < filePath.length; i++) {
    const char = filePath[i];
    let backslashCount = 0;
    for (let j = i - 1; j >= 0 && filePath[j] === "\\"; j--) {
      backslashCount++;
    }
    const isAlreadyEscaped = backslashCount % 2 === 1;
    if (!isAlreadyEscaped && SHELL_SPECIAL_CHARS.test(char)) {
      result += "\\" + char;
    } else {
      result += char;
    }
  }
  return result;
}
__name(escapePath, "escapePath");
function unescapeShellSpecials(value) {
  return value.replace(UNESCAPE_REGEX, "$1");
}
__name(unescapeShellSpecials, "unescapeShellSpecials");
function unescapePath(filePath) {
  if (os.platform() === "win32") {
    return filePath;
  }
  return unescapeShellSpecials(filePath);
}
__name(unescapePath, "unescapePath");
function getProjectHash(projectRoot) {
  const normalizedPath = os.platform() === "win32" ? projectRoot.toLowerCase() : projectRoot;
  return crypto.createHash("sha256").update(normalizedPath).digest("hex");
}
__name(getProjectHash, "getProjectHash");
function sanitizeCwd(cwd) {
  const normalizedCwd = os.platform() === "win32" ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, "-");
}
__name(sanitizeCwd, "sanitizeCwd");
function isSubpath(parentPath, childPath) {
  const isWindows = os.platform() === "win32";
  const pathModule = isWindows ? path.win32 : path;
  const relative2 = pathModule.relative(parentPath, childPath);
  return !relative2.startsWith(`..${pathModule.sep}`) && relative2 !== ".." && !pathModule.isAbsolute(relative2);
}
__name(isSubpath, "isSubpath");
function isSubpaths(parentPath, childPath) {
  return parentPath.some((p) => isSubpath(p, childPath));
}
__name(isSubpaths, "isSubpaths");
function resolveLeafSymlink(inputPath) {
  const maxHops = 40;
  let current = path.resolve(inputPath);
  for (let i = 0; i < maxHops; i++) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) {
      return current;
    }
    const target = fs.readlinkSync(current);
    if (path.isAbsolute(target)) {
      current = target;
    } else {
      let parent;
      try {
        parent = fs.realpathSync(path.dirname(current));
      } catch {
        parent = path.dirname(current);
      }
      current = path.resolve(parent, target);
    }
  }
  return current;
}
__name(resolveLeafSymlink, "resolveLeafSymlink");
function realpathNearestExisting(inputPath) {
  const resolved = resolveLeafSymlink(inputPath);
  const missingSegments = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync(current), ...missingSegments);
  } catch {
    return resolved;
  }
}
__name(realpathNearestExisting, "realpathNearestExisting");
async function resolveLeafSymlinkAsync(inputPath) {
  const maxHops = 40;
  let current = path.resolve(inputPath);
  for (let i = 0; i < maxHops; i++) {
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) {
      return current;
    }
    const target = await fs.promises.readlink(current);
    if (path.isAbsolute(target)) {
      current = target;
    } else {
      let parent;
      try {
        parent = await fs.promises.realpath(path.dirname(current));
      } catch {
        parent = path.dirname(current);
      }
      current = path.resolve(parent, target);
    }
  }
  return current;
}
__name(resolveLeafSymlinkAsync, "resolveLeafSymlinkAsync");
async function realpathNearestExistingAsync(inputPath) {
  const resolved = await resolveLeafSymlinkAsync(inputPath);
  const missingSegments = [];
  let current = resolved;
  for (; ; ) {
    let exists = true;
    try {
      await fs.promises.access(current);
    } catch {
      exists = false;
    }
    if (exists) break;
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(await fs.promises.realpath(current), ...missingSegments);
  } catch {
    return resolved;
  }
}
__name(realpathNearestExistingAsync, "realpathNearestExistingAsync");
function resolvePath(baseDir = process.cwd(), relativePath) {
  const expandedPath = expandTilde(relativePath);
  if (path.isAbsolute(expandedPath)) {
    return expandedPath;
  } else {
    return path.resolve(baseDir, expandedPath);
  }
}
__name(resolvePath, "resolvePath");
function validatePath(config, resolvedPath, options = {}) {
  const { allowFiles = false, allowExternalPaths = false } = options;
  const workspaceContext = config.getWorkspaceContext();
  const isWithinWorkspace = workspaceContext.isPathWithinWorkspace(resolvedPath);
  if (!allowExternalPaths && !isWithinWorkspace) {
    throw new Error("Path is not within workspace");
  }
  if (allowExternalPaths && !isWithinWorkspace) {
    return;
  }
  let isDirectory = isDirectoryCache.get(resolvedPath);
  if (isDirectory === void 0) {
    try {
      isDirectory = fs.statSync(resolvedPath).isDirectory();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Path does not exist: ${resolvedPath}`);
      }
      throw error;
    }
    if (isDirectoryCache.size >= VALIDATE_PATH_CACHE_MAX) {
      const oldest = isDirectoryCache.keys().next().value;
      if (oldest !== void 0) isDirectoryCache.delete(oldest);
    }
    isDirectoryCache.set(resolvedPath, isDirectory);
  }
  if (!allowFiles && !isDirectory) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }
}
__name(validatePath, "validatePath");
function resolveAndValidatePath(config, relativePath, options = {}) {
  const targetDir = config.getTargetDir();
  if (!relativePath) {
    return targetDir;
  }
  const resolvedPath = resolvePath(targetDir, relativePath);
  validatePath(config, resolvedPath, options);
  return resolvedPath;
}
__name(resolveAndValidatePath, "resolveAndValidatePath");

// packages/core/src/config/storage.ts
init_esbuild_shims();
import * as path2 from "node:path";
import * as os2 from "node:os";
import * as fs2 from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
var GOOGLE_ACCOUNTS_FILENAME = "google_accounts.json";
var OAUTH_FILE = "oauth_creds.json";
var SKILL_PROVIDER_CONFIG_DIRS = [".qwen", ".agents"];
var TMP_DIR_NAME = "tmp";
var BIN_DIR_NAME = "bin";
var PROJECT_DIR_NAME = "projects";
var IDE_DIR_NAME = "ide";
var PLANS_DIR_NAME = "plans";
var DEBUG_DIR_NAME = "debug";
var ARENA_DIR_NAME = "arena";
function platformFoldsCase() {
  return process.platform === "win32" || process.platform === "darwin";
}
__name(platformFoldsCase, "platformFoldsCase");
function isResolvedPathWithinDirectory(childPath, parentPath) {
  const child = platformFoldsCase() ? childPath.toLowerCase() : childPath;
  const parent = platformFoldsCase() ? parentPath.toLowerCase() : parentPath;
  const relativePath = path2.relative(parent, child);
  return relativePath === "" || !relativePath.startsWith(`..${path2.sep}`) && relativePath !== ".." && !path2.isAbsolute(relativePath);
}
__name(isResolvedPathWithinDirectory, "isResolvedPathWithinDirectory");
var Storage = class _Storage {
  static {
    __name(this, "Storage");
  }
  targetDir;
  runtimeBaseDir;
  /**
   * Custom runtime output base directory set via settings.
   * When null, falls back to getGlobalQwenDir().
   */
  static runtimeBaseDir = null;
  static runtimeBaseDirContext = new AsyncLocalStorage();
  constructor(targetDir, runtimeBaseDir = _Storage.getRuntimeBaseDir()) {
    this.targetDir = targetDir;
    this.runtimeBaseDir = path2.resolve(runtimeBaseDir);
  }
  /**
   * Expands tilde and resolves relative paths to absolute.
   */
  static resolvePath(dir, cwd) {
    let resolved = dir;
    if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
      const relativeSegments = resolved === "~" ? [] : resolved.slice(2).split(/[/\\]+/).filter(Boolean);
      resolved = path2.join(os2.homedir(), ...relativeSegments);
    }
    if (!path2.isAbsolute(resolved)) {
      resolved = cwd ? path2.resolve(cwd, resolved) : path2.resolve(resolved);
    }
    return resolved;
  }
  /**
   * Sanitizes a session id for use as a plan filename.
   *
   * Plan files are keyed by session id, but the raw id is public SDK input.
   * Strip directory separators and Windows-invalid filename characters so a
   * hostile value cannot escape the plans directory.
   */
  static sanitizePlanSessionId(sessionId) {
    const safeName = path2.basename(sessionId.replace(/\\/g, "/")).replace(/^\.+/g, "_").replace(/[<>:"|?*\x00-\x1F]/g, "_");
    return safeName || "_";
  }
  static resolveRuntimeBaseDir(dir, cwd) {
    if (!dir) {
      return null;
    }
    return _Storage.resolvePath(dir, cwd);
  }
  /**
   * Sets the custom runtime output base directory.
   * Handles tilde (~) expansion and resolves relative paths to absolute.
   * Pass null/undefined/empty string to reset to default (getGlobalQwenDir()).
   * @param dir - The directory path, or null/undefined to reset
   * @param cwd - Base directory for resolving relative paths (defaults to process.cwd()).
   *              Pass the project root so that relative values like ".qwen" resolve
   *              per-project, enabling a single global config to work across all projects.
   */
  static setRuntimeBaseDir(dir, cwd) {
    _Storage.runtimeBaseDir = _Storage.resolveRuntimeBaseDir(dir, cwd);
  }
  /**
   * Runs function execution in an async context with a specific runtime output dir.
   * This is used to isolate runtime output paths between concurrent sessions.
   */
  static runWithRuntimeBaseDir(dir, cwd, fn) {
    if (_Storage.runtimeBaseDirContext.getStore()?.pinned) {
      return fn();
    }
    const resolved = _Storage.resolveRuntimeBaseDir(dir, cwd);
    return _Storage.runtimeBaseDirContext.run(
      { dir: resolved, pinned: false },
      fn
    );
  }
  static runWithResolvedRuntimeBaseDir(dir, fn) {
    return _Storage.runtimeBaseDirContext.run(
      { dir: path2.resolve(dir), pinned: true },
      fn
    );
  }
  static hasRuntimeBaseDirContext() {
    return _Storage.runtimeBaseDirContext.getStore() !== void 0;
  }
  /**
   * Returns the base directory for all runtime output (temp files, debug logs,
   * session data, todos, insights, etc.).
   *
   * Priority: pinned runtime context > QWEN_RUNTIME_DIR env var > configurable context > setRuntimeBaseDir() value > getGlobalQwenDir()
   * @returns Absolute path to the runtime output base directory
   */
  static getRuntimeBaseDir() {
    const contextualDir = _Storage.runtimeBaseDirContext.getStore();
    if (contextualDir?.pinned) {
      return contextualDir.dir ?? _Storage.getGlobalQwenDir();
    }
    const envDir = process.env["QWEN_RUNTIME_DIR"];
    if (envDir) {
      return _Storage.resolveRuntimeBaseDir(envDir) ?? _Storage.getGlobalQwenDir();
    }
    if (contextualDir !== void 0) {
      return contextualDir.dir ?? _Storage.getGlobalQwenDir();
    }
    if (_Storage.runtimeBaseDir) {
      return _Storage.runtimeBaseDir;
    }
    return _Storage.getGlobalQwenDir();
  }
  static getGlobalQwenDir() {
    const envDir = process.env["QWEN_HOME"];
    if (envDir) {
      return _Storage.resolvePath(envDir);
    }
    const homeDir = os2.homedir();
    if (!homeDir) {
      return path2.join(os2.tmpdir(), ".qwen");
    }
    return path2.join(homeDir, QWEN_DIR);
  }
  static getMcpOAuthTokensPath() {
    return path2.join(_Storage.getGlobalQwenDir(), "mcp-oauth-tokens.json");
  }
  static getGlobalSettingsPath() {
    return path2.join(_Storage.getGlobalQwenDir(), "settings.json");
  }
  static getInstallationIdPath() {
    return path2.join(_Storage.getGlobalQwenDir(), "installation_id");
  }
  static getGoogleAccountsPath() {
    return path2.join(_Storage.getGlobalQwenDir(), GOOGLE_ACCOUNTS_FILENAME);
  }
  static getUserCommandsDir() {
    return path2.join(_Storage.getGlobalQwenDir(), "commands");
  }
  static getGlobalMemoryFilePath() {
    return path2.join(_Storage.getGlobalQwenDir(), "memory.md");
  }
  static getGlobalTempDir() {
    return path2.join(_Storage.getRuntimeBaseDir(), TMP_DIR_NAME);
  }
  static getGlobalDebugDir() {
    return path2.join(_Storage.getRuntimeBaseDir(), DEBUG_DIR_NAME);
  }
  static getDebugLogPath(sessionId) {
    return path2.join(_Storage.getGlobalDebugDir(), `${sessionId}.txt`);
  }
  static getGlobalIdeDir() {
    return path2.join(_Storage.getGlobalQwenDir(), IDE_DIR_NAME);
  }
  /**
   * Resolves pathToResolve by realpathing its deepest existing ancestor and
   * appending the not-yet-created remainder.
   */
  static resolvePathThroughExistingAncestor(pathToResolve) {
    let candidate = pathToResolve;
    while (true) {
      try {
        const realCandidate = fs2.realpathSync(candidate);
        const remainder = path2.relative(candidate, pathToResolve);
        return path2.join(realCandidate, remainder);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
        const parent = path2.dirname(candidate);
        if (parent === candidate) {
          return pathToResolve;
        }
        candidate = parent;
      }
    }
  }
  /**
   * Checks whether {@link childPath} resides within {@link parentPath},
   * resolving symbolic links to prevent traversal bypass attacks.
   */
  static isPathWithinDirectory(childPath, parentPath) {
    const realParent = _Storage.resolvePathThroughExistingAncestor(parentPath);
    const realChild = _Storage.resolvePathThroughExistingAncestor(childPath);
    return isResolvedPathWithinDirectory(realChild, realParent);
  }
  static assertPathWithinDirectory(childPath, parentPath, errorMessage) {
    if (!_Storage.isPathWithinDirectory(childPath, parentPath)) {
      throw new FatalConfigError(errorMessage);
    }
  }
  static getPlansDir(projectRoot, plansDirectory) {
    const configuredPlansDirectory = plansDirectory?.trim();
    if (configuredPlansDirectory) {
      if (!projectRoot) {
        throw new FatalConfigError(
          "projectRoot is required when plansDirectory is configured."
        );
      }
      const resolvedProjectRoot = path2.resolve(projectRoot);
      const resolvedPlansDirectory = _Storage.resolvePath(
        configuredPlansDirectory,
        resolvedProjectRoot
      );
      _Storage.assertPathWithinDirectory(
        resolvedPlansDirectory,
        resolvedProjectRoot,
        `plansDirectory must resolve within the project root.`
      );
      return resolvedPlansDirectory;
    }
    return path2.join(_Storage.getGlobalQwenDir(), PLANS_DIR_NAME);
  }
  static getPlanFilePath(sessionId, projectRoot, plansDirectory) {
    return path2.join(
      _Storage.getPlansDir(projectRoot, plansDirectory),
      `${_Storage.sanitizePlanSessionId(sessionId)}.md`
    );
  }
  static getGlobalBinDir() {
    return path2.join(_Storage.getGlobalQwenDir(), BIN_DIR_NAME);
  }
  static getGlobalArenaDir() {
    return path2.join(_Storage.getGlobalQwenDir(), ARENA_DIR_NAME);
  }
  /**
   * Create or adopt the outside-repo landing for /audit reports and sidecars
   * when the audited repository's ignore state cannot keep them out of
   * version control. Per-user and per-project, honoring the QWEN_HOME
   * override; 0700 on POSIX so the quoted (possibly exploitable) module
   * content stays private to the user.
   */
  static ensureAuditFallbackDir(projectRoot) {
    let resolved = projectRoot;
    try {
      resolved = fs2.realpathSync(projectRoot);
    } catch {
    }
    if (platformFoldsCase()) {
      resolved = resolved.toLowerCase();
    }
    const baseDir = _Storage.getGlobalQwenDir();
    const dir = path2.join(baseDir, "audits", getProjectHash(resolved));
    _Storage.assertAuditLandingIsOutsideRepo(dir, resolved);
    try {
      fs2.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      throw new FatalConfigError(
        `audit: the QWEN_HOME base ${baseDir} could not be created as a directory (${err.message}) \u2014 remove what stands at that path and re-run.`
      );
    }
    _Storage.assertAuditLandingIsOutsideRepo(dir, resolved);
    const auditsDir = _Storage.adoptDirectory(
      path2.join(baseDir, "audits"),
      "the audit artifact directory"
    );
    _Storage.adoptDirectory(dir, "the fallback landing");
    _Storage.assertAuditLandingIsClean(dir);
    _Storage.adoptDirectory(auditsDir, "the audit artifact directory");
    _Storage.adoptDirectory(dir, "the fallback landing");
    _Storage.assertAuditLandingIsClean(dir);
    _Storage.assertAuditLandingIsOutsideRepo(dir, resolved, true);
    _Storage.adoptDirectory(auditsDir, "the audit artifact directory");
    _Storage.adoptDirectory(dir, "the fallback landing");
    return dir;
  }
  /**
   * Create one path component and return it only if what is there now is a
   * real directory (not a symlink). On POSIX a pre-existing component is
   * tightened to 0700; ownership itself is not checked.
   *
   * Non-recursive on purpose: `recursive: true` would silently walk (and
   * follow) anything already standing in the path. Creating exactly one
   * component at a time is what makes each component checkable.
   */
  static adoptDirectory(dir, what) {
    try {
      fs2.mkdirSync(dir, { mode: 448 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const stat = fs2.lstatSync(dir);
    if (!stat.isDirectory()) {
      throw new FatalConfigError(
        `audit: ${what} ${dir} is not a directory (it may be a symlink planted ahead of the run) \u2014 remove it and re-run.`
      );
    }
    if (process.platform !== "win32" && (stat.mode & 511) !== 448) {
      fs2.chmodSync(dir, 448);
    }
    return dir;
  }
  /**
   * Refuse a fallback landing whose CONTENTS would redirect writes out of it.
   *
   * Validating the leaf alone is not enough: artifacts land at paths BELOW it
   * (`audit-<ts>.sidecar/sidecar.json`, the dated report), and an
   * O_NOFOLLOW open only ever guards the final component. A planted symlink
   * child is therefore a complete escape — `mkdirSync` happily treats a
   * symlink-to-directory as the directory, and every artifact written
   * "inside" the landing lands wherever the link points, while the leaf
   * itself stays a perfectly valid directory that re-validation passes.
   * A hardlinked regular file is the same story for reads: an existing name
   * reopened with O_TRUNC writes into the planter's inode.
   *
   * Directory children are validated recursively: a planted real
   * subdirectory holding a symlinked file is the same escape. Entries that
   * are neither regular files nor directories (a FIFO, socket, or device)
   * are refused outright: opening one for the report would block, or stream
   * the content to whoever holds the other end.
   *
   * The landing is REUSED across runs (the report and its sidecar are the
   * durable artifacts), so this cannot refuse a non-empty landing — only
   * entries that are not what a previous run of this tool would have left.
   */
  static assertAuditLandingIsClean(dir) {
    let entries;
    try {
      entries = fs2.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new FatalConfigError(
        `audit: the fallback landing ${dir} could not be listed for validation (${err.message}) \u2014 remove it and re-run.`
      );
    }
    for (const entry of entries) {
      let stat;
      try {
        stat = fs2.lstatSync(path2.join(dir, entry.name));
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a symlink (${entry.name}) \u2014 artifacts written under it would land outside the landing. Remove it and re-run.`
        );
      }
      if (stat.isDirectory()) {
        _Storage.assertAuditLandingIsClean(path2.join(dir, entry.name));
        let childStat;
        try {
          childStat = fs2.lstatSync(path2.join(dir, entry.name));
        } catch {
          continue;
        }
        if (!childStat.isDirectory()) {
          throw new FatalConfigError(
            `audit: the fallback landing ${dir} contains a symlink (${entry.name}) \u2014 artifacts written under it would land outside the landing. Remove it and re-run.`
          );
        }
        continue;
      }
      if (!stat.isFile()) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a special file (${entry.name}) \u2014 a write to it would block or be captured by whoever holds the other end. Remove it and re-run.`
        );
      }
      if (stat.nlink > 1) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a hardlinked file (${entry.name}) \u2014 a write to it would also write through its twin. Remove it and re-run.`
        );
      }
    }
  }
  /**
   * Refuse a fallback landing that resolves inside the audited repository.
   * A resolution failure (a non-directory component, a symlink loop, an
   * unreadable ancestor) falls through at the pre-adoption sites: such a
   * path cannot resolve to a usable landing, and the adoption checks that
   * still run afterwards own that state with the actionable message. At the
   * final site nothing runs afterwards, so the same failure fails closed
   * instead of returning an unvalidated landing.
   */
  static assertAuditLandingIsOutsideRepo(dir, resolvedProjectRoot, finalCheck = false) {
    let contained = false;
    try {
      contained = _Storage.isPathWithinDirectory(dir, resolvedProjectRoot);
    } catch (err) {
      if (finalCheck) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} could not be validated as outside the audited project root (${err.message}) \u2014 remove it and re-run.`
        );
      }
    }
    if (contained) {
      throw new FatalConfigError(
        `audit: the fallback landing ${dir} resolves inside the audited project root \u2014 point QWEN_HOME outside the repository and re-run.`
      );
    }
  }
  getQwenDir() {
    return path2.join(this.targetDir, QWEN_DIR);
  }
  getRuntimeBaseDir() {
    return this.runtimeBaseDir;
  }
  getProjectDir() {
    const projectId = sanitizeCwd(this.getProjectRoot());
    const projectsDir = path2.join(this.runtimeBaseDir, PROJECT_DIR_NAME);
    return path2.join(projectsDir, projectId);
  }
  getProjectTempDir() {
    const hash = getProjectHash(this.getProjectRoot());
    const tempDir = path2.join(this.runtimeBaseDir, TMP_DIR_NAME);
    const targetDir = path2.join(tempDir, hash);
    return targetDir;
  }
  getToolResultsDir() {
    return path2.join(this.getProjectTempDir(), "tool-results");
  }
  ensureProjectTempDirExists() {
    fs2.mkdirSync(this.getProjectTempDir(), { recursive: true });
  }
  static getOAuthCredsPath() {
    return path2.join(_Storage.getGlobalQwenDir(), OAUTH_FILE);
  }
  getProjectRoot() {
    return this.targetDir;
  }
  getWorkspaceSettingsPath() {
    return path2.join(this.getQwenDir(), "settings.json");
  }
  getProjectCommandsDir() {
    return path2.join(this.getQwenDir(), "commands");
  }
  /**
   * Project-level saved-workflow scripts directory: `<targetDir>/.qwen/workflows`.
   * Saved workflow scripts (`<name>.js`) here are surfaced as slash commands
   * and resolvable by `workflow('<name>')` from inside a running workflow.
   */
  getProjectWorkflowsDir() {
    return path2.join(this.getQwenDir(), "workflows");
  }
  /**
   * User-level saved-workflow scripts directory: `~/.qwen/workflows`. User
   * scope is lower-precedence than project scope when the same `<name>.js`
   * exists in both.
   */
  static getUserWorkflowsDir() {
    return path2.join(_Storage.getGlobalQwenDir(), "workflows");
  }
  /**
   * Per-run workflow artifact directory: `<projectDir>/workflows`. Holds
   * completed-run snapshot JSON files (`<runId>.json`) for the `/workflows`
   * recent list, and per-run resume journals (`<runId>/journal.jsonl`).
   */
  getWorkflowRunsDir() {
    return path2.join(this.getProjectDir(), "workflows");
  }
  /**
   * Generated-workflow scripts directory: `<projectDir>/workflows/generated`.
   * A trusted root for `Workflow({scriptPath})` / `workflow({scriptPath})`
   * that is NOT a saved-workflow scope: scripts here are never listed as
   * `/<name>` slash commands and cannot be reached by `workflow('<name>')`.
   * It exists for tooling that emits a script for one run (a CLI subcommand
   * generating a fan-out for the model to dispatch) — such a script has no
   * business in the user's command namespace, and the runtime dir keeps it
   * out of the project tree. Layout below the root is the writer's; the
   * loader trusts the whole subtree. A subprocess reaches it as
   * `$QWEN_CODE_PROJECT_DIR/workflows/generated`.
   */
  getGeneratedWorkflowsDir() {
    return path2.join(this.getWorkflowRunsDir(), "generated");
  }
  /**
   * Where an inline `Workflow({script})` run persists its script:
   * `<generated>/inline/<runId>.js`. Inside the generated root because that
   * root is already a trusted `{scriptPath}` source and is never resolvable
   * by name, so the persisted copy is re-runnable (and editable before a
   * resume) without entering the user's command namespace. The `inline/`
   * subdirectory keeps model-authored scripts apart from the one-run scripts
   * other tooling emits into the same root.
   */
  getInlineWorkflowScriptPath(runId) {
    return path2.join(this.getGeneratedWorkflowsDir(), "inline", `${runId}.js`);
  }
  /**
   * Path to the persisted snapshot of a completed workflow run.
   */
  getWorkflowRunSnapshotPath(runId) {
    return path2.join(this.getWorkflowRunsDir(), `${runId}.json`);
  }
  /**
   * Path to the resume journal for an in-progress / resumable workflow run.
   */
  getWorkflowRunJournalPath(runId) {
    return path2.join(this.getWorkflowRunsDir(), runId, "journal.jsonl");
  }
  /**
   * Path to the runtime-status sidecar JSON for this session.
   *
   * Co-located with the per-session chat log under
   * `<projectDir>/chats/<sessionId>.runtime.json` so external observers
   * (terminal multiplexers, IDE integrations, status daemons) can scan
   * the same directory used for chat history to find live sessions.
   */
  getRuntimeStatusPath(sessionId) {
    return path2.join(
      this.getProjectDir(),
      "chats",
      `${sessionId}.runtime.json`
    );
  }
  getProjectTempCheckpointsDir() {
    return path2.join(this.getProjectTempDir(), "checkpoints");
  }
  getExtensionsDir() {
    return path2.join(this.getQwenDir(), "extensions");
  }
  getExtensionsConfigPath() {
    return path2.join(this.getExtensionsDir(), "qwen-extension.json");
  }
  getUserSkillsDirs() {
    const homeDir = os2.homedir() || os2.tmpdir();
    return SKILL_PROVIDER_CONFIG_DIRS.map(
      (dir) => dir === QWEN_DIR ? path2.join(_Storage.getGlobalQwenDir(), "skills") : path2.join(homeDir, dir, "skills")
    );
  }
  /**
   * Returns the user-level extensions directory (~/.qwen/extensions/).
   * Extensions installed at user scope are stored here, as opposed to
   * project-level extensions which live in <project>/.qwen/extensions/.
   */
  static getUserExtensionsDir() {
    return path2.join(_Storage.getGlobalQwenDir(), "extensions");
  }
  getHistoryFilePath() {
    return path2.join(this.getProjectTempDir(), "shell_history");
  }
};

// packages/core/src/telemetry/session-context.ts
init_esbuild_shims();
init_esm();
var sessionIdContextKey = createContextKey("qwen-code.telemetry.session-id");
var sessionRootContext;
var currentSessionId;
function setSessionContext(ctx, sessionId) {
  sessionRootContext = ctx;
  currentSessionId = sessionId;
}
__name(setSessionContext, "setSessionContext");
function getSessionContext() {
  return sessionRootContext;
}
__name(getSessionContext, "getSessionContext");
function getCurrentSessionId() {
  return currentSessionId;
}
__name(getCurrentSessionId, "getCurrentSessionId");
function setSessionIdOnContext(ctx, sessionId) {
  if (!sessionId) return ctx;
  return ctx.setValue(sessionIdContextKey, sessionId);
}
__name(setSessionIdOnContext, "setSessionIdOnContext");
function getSessionIdFromContext(ctx) {
  const sessionId = ctx.getValue(sessionIdContextKey);
  return typeof sessionId === "string" && sessionId ? sessionId : void 0;
}
__name(getSessionIdFromContext, "getSessionIdFromContext");

// packages/core/src/utils/sessionIdContext.ts
init_esbuild_shims();
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var sessionIdContext = new AsyncLocalStorage2();
var projectDirBySession = /* @__PURE__ */ new Map();
function registerSessionProjectDir(sessionId, projectDir) {
  if (sessionId && projectDir) projectDirBySession.set(sessionId, projectDir);
}
__name(registerSessionProjectDir, "registerSessionProjectDir");
function getSessionProjectDir(sessionId) {
  return projectDirBySession.get(sessionId);
}
__name(getSessionProjectDir, "getSessionProjectDir");
function unregisterSessionProjectDir(sessionId) {
  projectDirBySession.delete(sessionId);
}
__name(unregisterSessionProjectDir, "unregisterSessionProjectDir");
var modelBySession = /* @__PURE__ */ new Map();
var modelIdentityBySession = /* @__PURE__ */ new Map();
function registerSessionModel(sessionId, model, identity) {
  if (!sessionId || !model) return;
  modelBySession.set(sessionId, model);
  if (identity) modelIdentityBySession.set(sessionId, identity);
  else modelIdentityBySession.delete(sessionId);
}
__name(registerSessionModel, "registerSessionModel");
function getSessionModel(sessionId) {
  return modelBySession.get(sessionId);
}
__name(getSessionModel, "getSessionModel");
function getSessionModelIdentity(sessionId) {
  return modelIdentityBySession.get(sessionId);
}
__name(getSessionModelIdentity, "getSessionModelIdentity");
function unregisterSessionModel(sessionId) {
  modelBySession.delete(sessionId);
  modelIdentityBySession.delete(sessionId);
}
__name(unregisterSessionModel, "unregisterSessionModel");

// packages/core/src/utils/debugLogger.ts
init_esbuild_shims();
import { promises as fs4 } from "node:fs";
import path4 from "node:path";
import { AsyncLocalStorage as AsyncLocalStorage3 } from "node:async_hooks";
import util from "node:util";

// packages/core/src/utils/symlink.ts
init_esbuild_shims();
import { promises as fs3 } from "node:fs";
import path3 from "node:path";
async function updateSymlink(linkPath, targetPath, options) {
  const { fallbackCopy = true } = options ?? {};
  const linkDir = path3.dirname(linkPath);
  const relativeTarget = path3.relative(linkDir, targetPath);
  try {
    await fs3.unlink(linkPath);
  } catch {
  }
  try {
    await fs3.symlink(relativeTarget, linkPath);
    return;
  } catch {
  }
  if (fallbackCopy) {
    try {
      await fs3.copyFile(targetPath, linkPath);
    } catch {
    }
  }
}
__name(updateSymlink, "updateSymlink");

// packages/core/src/telemetry/trace-context.ts
init_esbuild_shims();
init_esm();
function extractTraceContext(span) {
  const ctx = span?.spanContext();
  if (ctx && isSpanContextValid(ctx)) {
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceFlags: ctx.traceFlags
    };
  }
  return null;
}
__name(extractTraceContext, "extractTraceContext");
function getActiveSpanTraceContext() {
  try {
    return extractTraceContext(trace.getActiveSpan());
  } catch {
    return null;
  }
}
__name(getActiveSpanTraceContext, "getActiveSpanTraceContext");
function getSessionRootTraceContext() {
  try {
    const sessionCtx = getSessionContext();
    return extractTraceContext(
      sessionCtx ? trace.getSpan(sessionCtx) : void 0
    );
  } catch {
    return null;
  }
}
__name(getSessionRootTraceContext, "getSessionRootTraceContext");
function getTraceContext() {
  return getActiveSpanTraceContext() ?? getSessionRootTraceContext();
}
__name(getTraceContext, "getTraceContext");
function formatTraceparent(ctx) {
  const flags = (ctx.traceFlags & 255).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}
__name(formatTraceparent, "formatTraceparent");
var shellTracePropagationEnabled = false;
function setShellTracePropagation(enabled) {
  shellTracePropagationEnabled = enabled;
}
__name(setShellTracePropagation, "setShellTracePropagation");
function isShellTracePropagationEnabled() {
  return shellTracePropagationEnabled;
}
__name(isShellTracePropagationEnabled, "isShellTracePropagationEnabled");

// packages/core/src/utils/debugLogger.ts
var ensureDebugDirPromise = null;
var ensuredDebugDirPath = null;
var hasWriteFailure = false;
var globalSession = null;
var lastAliasedKey = null;
var aliasGeneration = 0;
var aliasFailureStreak = 0;
var aliasChain = Promise.resolve();
var sessionContext = new AsyncLocalStorage3();
function isDebugLogFileEnabled() {
  const value = process.env["QWEN_DEBUG_LOG_FILE"];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return !["", "0", "false", "off", "no"].includes(normalized);
}
__name(isDebugLogFileEnabled, "isDebugLogFileEnabled");
function getActiveSession() {
  const contextSession = sessionContext.getStore();
  if (contextSession === false) return null;
  if (contextSession) return contextSession;
  const sessionId = sessionIdContext.getStore();
  if (sessionId) {
    return { getSessionId: /* @__PURE__ */ __name(() => sessionId, "getSessionId") };
  }
  return globalSession;
}
__name(getActiveSession, "getActiveSession");
function ensureDebugDirExists() {
  const debugDirPath = Storage.getGlobalDebugDir();
  if (!ensureDebugDirPromise || ensuredDebugDirPath !== debugDirPath) {
    ensuredDebugDirPath = debugDirPath;
    ensureDebugDirPromise = fs4.mkdir(debugDirPath, { recursive: true }).then(() => void 0).catch(() => {
      hasWriteFailure = true;
      ensureDebugDirPromise = null;
      ensuredDebugDirPath = null;
    });
  }
  return ensureDebugDirPromise ?? Promise.resolve();
}
__name(ensureDebugDirExists, "ensureDebugDirExists");
function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack ?? `${arg.name}: ${arg.message}`;
    }
    return arg;
  }).map((arg) => typeof arg === "string" ? arg : util.inspect(arg)).join(" ");
}
__name(formatArgs, "formatArgs");
function buildLogLine(level, message, tag, traceCtx) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const tagPart = tag ? ` [${tag}]` : "";
  const tracePart = traceCtx ? ` [trace_id=${traceCtx.traceId} span_id=${traceCtx.spanId}]` : "";
  return `${timestamp} [${level}]${tagPart}${tracePart} ${message}
`;
}
__name(buildLogLine, "buildLogLine");
function writeLog(session, level, tag, args) {
  if (!isDebugLogFileEnabled()) {
    return;
  }
  const sessionId = session.getSessionId();
  const logFilePath = Storage.getDebugLogPath(sessionId);
  const message = formatArgs(args);
  const traceCtx = getTraceContext();
  const line = buildLogLine(level, message, tag, traceCtx);
  updateLatestDebugLogAlias(sessionId);
  void ensureDebugDirExists().then(() => fs4.appendFile(logFilePath, line, "utf8")).catch(() => {
    hasWriteFailure = true;
  });
}
__name(writeLog, "writeLog");
function isDebugLoggingDegraded() {
  return hasWriteFailure;
}
__name(isDebugLoggingDegraded, "isDebugLoggingDegraded");
var DEBUG_LATEST_ALIAS = "latest";
var SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_CONSECUTIVE_ALIAS_FAILURES = 3;
async function doUpdateLatestDebugLogAlias(sessionId) {
  const aliasPath = path4.join(Storage.getGlobalDebugDir(), DEBUG_LATEST_ALIAS);
  const targetPath = Storage.getDebugLogPath(sessionId);
  await ensureDebugDirExists();
  await updateSymlink(aliasPath, targetPath, { fallbackCopy: false });
  try {
    const actualTarget = await fs4.readlink(aliasPath);
    return actualTarget === path4.relative(path4.dirname(aliasPath), targetPath);
  } catch {
    return false;
  }
}
__name(doUpdateLatestDebugLogAlias, "doUpdateLatestDebugLogAlias");
function updateLatestDebugLogAlias(sessionId) {
  if (!isDebugLogFileEnabled()) {
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return;
  }
  const key = path4.join(Storage.getGlobalDebugDir(), sessionId);
  if (key === lastAliasedKey) {
    return;
  }
  lastAliasedKey = key;
  const generation = ++aliasGeneration;
  aliasChain = aliasChain.then(async () => {
    let updated = false;
    try {
      updated = await doUpdateLatestDebugLogAlias(sessionId);
    } catch {
    }
    if (updated) {
      aliasFailureStreak = 0;
      return;
    }
    aliasFailureStreak += 1;
    if (aliasFailureStreak < MAX_CONSECUTIVE_ALIAS_FAILURES && aliasGeneration === generation) {
      lastAliasedKey = null;
    }
  });
}
__name(updateLatestDebugLogAlias, "updateLatestDebugLogAlias");
function setDebugLogSession(session) {
  globalSession = session ?? null;
  if (session) {
    updateLatestDebugLogAlias(session.getSessionId());
  }
}
__name(setDebugLogSession, "setDebugLogSession");
function runWithoutDebugLogSession(fn) {
  return sessionContext.run(false, fn);
}
__name(runWithoutDebugLogSession, "runWithoutDebugLogSession");
function createDebugLogger(tag) {
  return {
    isEnabled: /* @__PURE__ */ __name(() => getActiveSession() !== null, "isEnabled"),
    debug: /* @__PURE__ */ __name((...args) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, "DEBUG", tag, args);
    }, "debug"),
    info: /* @__PURE__ */ __name((...args) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, "INFO", tag, args);
    }, "info"),
    warn: /* @__PURE__ */ __name((...args) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, "WARN", tag, args);
    }, "warn"),
    error: /* @__PURE__ */ __name((...args) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, "ERROR", tag, args);
    }, "error")
  };
}
__name(createDebugLogger, "createDebugLogger");

export {
  QWEN_DIR,
  PATH_ARG_KEYS,
  tildeifyPath,
  expandHomeDir,
  shortenPath,
  makeRelative,
  formatDisplayPath,
  escapePath,
  unescapeShellSpecials,
  unescapePath,
  getProjectHash,
  sanitizeCwd,
  isSubpath,
  isSubpaths,
  realpathNearestExisting,
  realpathNearestExistingAsync,
  resolvePath,
  resolveAndValidatePath,
  SKILL_PROVIDER_CONFIG_DIRS,
  Storage,
  updateSymlink,
  setSessionContext,
  getCurrentSessionId,
  setSessionIdOnContext,
  getSessionIdFromContext,
  getActiveSpanTraceContext,
  getTraceContext,
  formatTraceparent,
  setShellTracePropagation,
  isShellTracePropagationEnabled,
  sessionIdContext,
  registerSessionProjectDir,
  getSessionProjectDir,
  unregisterSessionProjectDir,
  registerSessionModel,
  getSessionModel,
  getSessionModelIdentity,
  unregisterSessionModel,
  isDebugLogFileEnabled,
  isDebugLoggingDegraded,
  setDebugLogSession,
  runWithoutDebugLogSession,
  createDebugLogger
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
