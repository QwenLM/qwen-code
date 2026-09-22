// Force strict mode and setup for ESM
"use strict";
import {
  isCommandAvailable
} from "./chunk-QPTE6BKL.js";
import {
  NO_EXEC_CONFIG,
  NO_EXEC_CONFIG_SETTINGS
} from "./chunk-AUFTA63J.js";
import {
  fileExists,
  isWithinRoot
} from "./chunk-25FMWESU.js";
import {
  atomicWriteFile,
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  Storage,
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

// packages/core/src/utils/runtimeStatus.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var RUNTIME_STATUS_SCHEMA_VERSION = 1;
async function writeRuntimeStatus(filePath, fields) {
  const payload = {
    schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
    pid: fields.pid ?? process.pid,
    session_id: fields.sessionId,
    work_dir: fields.workDir,
    hostname: os.hostname(),
    started_at: Date.now() / 1e3,
    qwen_version: fields.qwenVersion ?? null
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, payload);
  return filePath;
}
__name(writeRuntimeStatus, "writeRuntimeStatus");
async function readRuntimeStatus(filePath, options = {}) {
  let raw;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal ? await fs.readFile(filePath, {
      encoding: "utf-8",
      signal: options.signal
    }) : await fs.readFile(filePath, "utf-8");
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
  options.signal?.throwIfAborted();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const obj = data;
  if (obj["schema_version"] !== RUNTIME_STATUS_SCHEMA_VERSION) {
    return null;
  }
  const schemaVersion = obj["schema_version"];
  const pid = obj["pid"];
  const sessionId = obj["session_id"];
  const workDir = obj["work_dir"];
  const hostname2 = obj["hostname"];
  const startedAt = obj["started_at"];
  const qwenVersion = obj["qwen_version"];
  if (!isFiniteInteger(schemaVersion)) return null;
  if (!isFiniteInteger(pid)) return null;
  if (typeof sessionId !== "string") return null;
  if (typeof workDir !== "string") return null;
  if (typeof hostname2 !== "string") return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return null;
  }
  if (qwenVersion !== null && typeof qwenVersion !== "string") return null;
  return {
    schemaVersion,
    pid,
    sessionId,
    workDir,
    hostname: hostname2,
    startedAt,
    qwenVersion
  };
}
__name(readRuntimeStatus, "readRuntimeStatus");
async function clearRuntimeStatus(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
  }
}
__name(clearRuntimeStatus, "clearRuntimeStatus");
function isFiniteInteger(v) {
  return typeof v === "number" && Number.isInteger(v);
}
__name(isFiniteInteger, "isFiniteInteger");

// packages/core/src/services/gitWorktreeService.ts
init_esbuild_shims();
import nodeFs from "node:fs";
import * as fs2 from "node:fs/promises";
import * as path2 from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

// packages/core/src/utils/load-simple-git.ts
init_esbuild_shims();
var simpleGitModulePromise;
function guardFsmonitor(factory) {
  const guarded = /* @__PURE__ */ __name((first, second) => {
    const baseDir = typeof first === "string" ? first : void 0;
    const options = typeof first === "string" ? second : first;
    const merged = {
      ...options,
      config: [...options?.config ?? [], ...NO_EXEC_CONFIG_SETTINGS],
      unsafe: { ...options?.unsafe, allowUnsafeFsMonitor: true }
    };
    return baseDir === void 0 ? factory(merged) : factory(baseDir, merged);
  }, "guarded");
  return guarded;
}
__name(guardFsmonitor, "guardFsmonitor");
function isSimpleGitModule(candidate) {
  return candidate !== void 0 && "simpleGit" in candidate && typeof candidate.simpleGit === "function" && "CheckRepoActions" in candidate && typeof candidate.CheckRepoActions === "object" && candidate.CheckRepoActions !== null;
}
__name(isSimpleGitModule, "isSimpleGitModule");
function loadSimpleGit() {
  simpleGitModulePromise ??= import("./esm-K5FARBNI.js").then((module) => {
    const imported = module;
    const candidate = isSimpleGitModule(imported) ? imported : "default" in imported ? imported.default : void 0;
    if (!isSimpleGitModule(candidate)) {
      throw new Error("simple-git module does not match the expected API");
    }
    return {
      CheckRepoActions: candidate.CheckRepoActions,
      simpleGit: guardFsmonitor(candidate.simpleGit)
    };
  });
  return simpleGitModulePromise;
}
__name(loadSimpleGit, "loadSimpleGit");

// packages/core/src/services/gitInit.ts
init_esbuild_shims();
async function initRepositoryWithMainBranch(git) {
  await git.init(false);
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
}
__name(initRepositoryWithMainBranch, "initRepositoryWithMainBranch");

// packages/core/src/services/gitWorktreeService.ts
var execFileAsync = promisify(execFile);
var debugLogger = createDebugLogger("GIT_WORKTREE_SERVICE");
var WORKTREE_BRANCH_PREFIX = "worktree-";
function worktreeBranchForSlug(slug) {
  return `${WORKTREE_BRANCH_PREFIX}${slug}`;
}
__name(worktreeBranchForSlug, "worktreeBranchForSlug");
var WORKTREE_SESSION_FILE = ".qwen-session";
var WORKTREE_SESSION_MARKER_MAX_BYTES = 512;
var NO_EXEC_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];
async function addWorktreeSessionMarkerExclude(worktreePath) {
  try {
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath);
    const commonDir = (await wtGit.revparse(["--git-common-dir"])).trim();
    const excludePath = path2.isAbsolute(commonDir) ? path2.join(commonDir, "info", "exclude") : path2.join(worktreePath, commonDir, "info", "exclude");
    await fs2.mkdir(path2.dirname(excludePath), { recursive: true });
    let existing = "";
    try {
      existing = await fs2.readFile(excludePath, "utf8");
    } catch {
    }
    const rules = [WORKTREE_SESSION_FILE, `${WORKTREE_SESSION_FILE}.*.tmp`];
    let next = existing;
    for (const rule of rules) {
      if (!next.split(/\r?\n/).includes(rule)) {
        const sep = next.length === 0 || next.endsWith("\n") ? "" : "\n";
        next = `${next}${sep}${rule}
`;
      }
    }
    if (next !== existing) {
      await fs2.writeFile(excludePath, next, "utf8");
    }
  } catch {
  }
}
__name(addWorktreeSessionMarkerExclude, "addWorktreeSessionMarkerExclude");
async function writeWorktreeSessionMarker(worktreePath, sessionId) {
  await fs2.writeFile(
    path2.join(worktreePath, WORKTREE_SESSION_FILE),
    sessionId,
    "utf8"
  );
  await addWorktreeSessionMarkerExclude(worktreePath);
}
__name(writeWorktreeSessionMarker, "writeWorktreeSessionMarker");
var WorktreeMarkerCommittedError = class extends Error {
  static {
    __name(this, "WorktreeMarkerCommittedError");
  }
  committedOwner;
  constructor(committedOwner, options) {
    super(
      `Worktree session marker committed for ${committedOwner}; the post-commit close failed`,
      options
    );
    this.name = "WorktreeMarkerCommittedError";
    this.committedOwner = committedOwner;
  }
};
async function createWorktreeSessionMarkerExclusive(worktreePath, sessionId) {
  assertValidWorktreeSessionMarkerOwner(sessionId);
  const markerPath = path2.join(worktreePath, WORKTREE_SESSION_FILE);
  const stagedPath = `${markerPath}.${randomBytes(6).toString("hex")}.tmp`;
  const flags = nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | (nodeFs.constants.O_NOFOLLOW ?? 0);
  const handle = await fs2.open(stagedPath, flags, 384);
  let stagedDev = 0;
  let stagedIno = 0;
  try {
    const before = await handle.stat();
    stagedDev = before.dev;
    stagedIno = before.ino;
    if (!before.isFile() || before.nlink !== 1 || before.ino === 0) {
      throw new Error("Worktree session marker has an unsafe identity");
    }
    await handle.writeFile(sessionId, "utf8");
    await handle.sync();
    const [after, pathStats] = await Promise.all([
      handle.stat(),
      fs2.lstat(stagedPath)
    ]);
    if (!after.isFile() || after.nlink !== 1 || after.size > WORKTREE_SESSION_MARKER_MAX_BYTES || after.dev !== before.dev || after.ino !== before.ino || pathStats.dev !== after.dev || pathStats.ino !== after.ino) {
      throw new Error("Worktree session marker identity changed");
    }
    await fs2.link(stagedPath, markerPath);
  } catch (error) {
    await handle.close().catch(() => {
    });
    if (stagedIno !== 0) {
      try {
        const current = await fs2.lstat(stagedPath);
        if (current.dev === stagedDev && current.ino === stagedIno) {
          await fs2.unlink(stagedPath);
        }
      } catch {
      }
    }
    throw error;
  }
  try {
    await fs2.unlink(stagedPath);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {
    });
    throw new WorktreeMarkerCommittedError(sessionId, { cause: error });
  }
  await addWorktreeSessionMarkerExclude(worktreePath);
}
__name(createWorktreeSessionMarkerExclusive, "createWorktreeSessionMarkerExclusive");
function assertValidWorktreeSessionMarkerOwner(sessionId) {
  if (sessionId.length === 0 || Buffer.byteLength(sessionId, "utf8") > WORKTREE_SESSION_MARKER_MAX_BYTES || sessionId.trim() !== sessionId) {
    throw new Error("Invalid worktree session marker owner");
  }
}
__name(assertValidWorktreeSessionMarkerOwner, "assertValidWorktreeSessionMarkerOwner");
async function readWorktreeSessionMarkerStrict(worktreePath) {
  const markerPath = path2.join(worktreePath, WORKTREE_SESSION_FILE);
  let handle;
  let observedMarker = false;
  try {
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
    const before = await fs2.lstat(markerPath);
    observedMarker = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { state: "invalid", reason: "unsafe marker file type" };
    }
    if (before.ino === 0 || before.size > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "unsafe marker size or identity" };
    }
    handle = await fs2.open(markerPath, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      return {
        state: "invalid",
        reason: "marker identity changed before read"
      };
    }
    const markerBuffer = Buffer.alloc(WORKTREE_SESSION_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < markerBuffer.length) {
      const chunk = await handle.read(
        markerBuffer,
        bytesRead,
        markerBuffer.length - bytesRead,
        bytesRead
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "unsafe marker size or identity" };
    }
    const raw = markerBuffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat();
    const pathStats = await fs2.lstat(markerPath);
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytesRead || after.size > WORKTREE_SESSION_MARKER_MAX_BYTES || after.dev !== opened.dev || after.ino !== opened.ino || !pathStats.isFile() || pathStats.nlink !== 1 || pathStats.dev !== after.dev || pathStats.ino !== after.ino) {
      return {
        state: "invalid",
        reason: "marker identity changed during read"
      };
    }
    const sessionId = raw.trim();
    if (sessionId.length === 0 || sessionId !== raw || Buffer.byteLength(sessionId, "utf8") > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "invalid marker owner" };
    }
    return {
      state: "valid",
      sessionId,
      uid: process.geteuid === void 0 ? null : after.uid,
      dev: after.dev,
      ino: after.ino
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return observedMarker ? { state: "invalid", reason: "marker disappeared during read" } : { state: "missing" };
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
__name(readWorktreeSessionMarkerStrict, "readWorktreeSessionMarkerStrict");
function readWorktreeSessionMarkerStrictSync(worktreePath) {
  const markerPath = path2.join(worktreePath, WORKTREE_SESSION_FILE);
  let fd;
  let observedMarker = false;
  try {
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
    const before = nodeFs.lstatSync(markerPath);
    observedMarker = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { state: "invalid", reason: "unsafe marker file type" };
    }
    if (before.ino === 0 || before.size > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "unsafe marker size or identity" };
    }
    fd = nodeFs.openSync(markerPath, flags);
    const opened = nodeFs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      return {
        state: "invalid",
        reason: "marker identity changed before read"
      };
    }
    const markerBuffer = Buffer.alloc(WORKTREE_SESSION_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < markerBuffer.length) {
      const chunk = nodeFs.readSync(
        fd,
        markerBuffer,
        bytesRead,
        markerBuffer.length - bytesRead,
        bytesRead
      );
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "unsafe marker size or identity" };
    }
    const raw = markerBuffer.subarray(0, bytesRead).toString("utf8");
    const after = nodeFs.fstatSync(fd);
    const pathStats = nodeFs.lstatSync(markerPath);
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytesRead || after.size > WORKTREE_SESSION_MARKER_MAX_BYTES || after.dev !== opened.dev || after.ino !== opened.ino || !pathStats.isFile() || pathStats.nlink !== 1 || pathStats.dev !== after.dev || pathStats.ino !== after.ino) {
      return {
        state: "invalid",
        reason: "marker identity changed during read"
      };
    }
    const sessionId = raw.trim();
    if (sessionId.length === 0 || sessionId !== raw || Buffer.byteLength(sessionId, "utf8") > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: "invalid", reason: "invalid marker owner" };
    }
    return {
      state: "valid",
      sessionId,
      uid: process.geteuid === void 0 ? null : after.uid,
      dev: after.dev,
      ino: after.ino
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return observedMarker ? { state: "invalid", reason: "marker disappeared during read" } : { state: "missing" };
    }
    return {
      state: "invalid",
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (fd !== void 0) {
      try {
        nodeFs.closeSync(fd);
      } catch {
      }
    }
  }
}
__name(readWorktreeSessionMarkerStrictSync, "readWorktreeSessionMarkerStrictSync");
async function transferWorktreeSessionMarkerOwner(worktreePath, expectedOwner, newOwner) {
  assertValidWorktreeSessionMarkerOwner(newOwner);
  if (expectedOwner !== null) {
    assertValidWorktreeSessionMarkerOwner(expectedOwner);
    if (expectedOwner === newOwner) {
      throw new Error("Worktree marker transfer needs a distinct new owner");
    }
  }
  const opening = await readWorktreeSessionMarkerStrict(worktreePath);
  if (opening.state === "invalid") {
    throw new Error(`Worktree marker is invalid: ${opening.reason}`);
  }
  if (opening.state === "missing") {
    if (expectedOwner !== null) {
      throw new Error("Worktree marker owner does not match the expectation");
    }
    await createWorktreeSessionMarkerExclusive(worktreePath, newOwner);
    return;
  }
  if (opening.sessionId !== expectedOwner) {
    throw new Error("Worktree marker owner does not match the expectation");
  }
  const euid = process.geteuid?.();
  if (euid !== void 0 && opening.uid !== null && opening.uid !== euid) {
    throw new Error("Worktree marker is owned by a different uid");
  }
  const markerPath = path2.join(worktreePath, WORKTREE_SESSION_FILE);
  await atomicWriteFile(markerPath, newOwner, {
    mode: 384,
    noFollow: true,
    assertCanCommit: /* @__PURE__ */ __name(() => {
      const current = readWorktreeSessionMarkerStrictSync(worktreePath);
      if (current.state !== "valid" || current.sessionId !== opening.sessionId || current.dev !== opening.dev || current.ino !== opening.ino || current.uid !== opening.uid) {
        throw new Error("Worktree marker changed during ownership transfer");
      }
    }, "assertCanCommit")
  });
  await addWorktreeSessionMarkerExclude(worktreePath);
}
__name(transferWorktreeSessionMarkerOwner, "transferWorktreeSessionMarkerOwner");
async function readWorktreeSessionMarker(worktreePath) {
  const markerPath = path2.join(worktreePath, WORKTREE_SESSION_FILE);
  try {
    const raw = await fs2.readFile(markerPath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if (error.code !== "ENOENT") {
      debugLogger.warn(
        `readWorktreeSessionMarker: cannot read ${markerPath}: ${error}`
      );
    }
    return null;
  }
}
__name(readWorktreeSessionMarker, "readWorktreeSessionMarker");
var BASELINE_COMMIT_MESSAGE = "baseline (dirty state overlay)";
var WORKTREES_DIR = "worktrees";
var AGENT_WORKTREE_PREFIX = "agent";
var AGENT_WORKTREE_HEX_LENGTH = 7;
var AGENT_WORKTREE_SLUG_PATTERN = new RegExp(
  `^${AGENT_WORKTREE_PREFIX}-[0-9a-f]{${AGENT_WORKTREE_HEX_LENGTH}}$`
);
function generateAgentWorktreeSlug() {
  const hex = randomBytes(Math.ceil(AGENT_WORKTREE_HEX_LENGTH / 2)).toString("hex").slice(0, AGENT_WORKTREE_HEX_LENGTH);
  return `${AGENT_WORKTREE_PREFIX}-${hex}`;
}
__name(generateAgentWorktreeSlug, "generateAgentWorktreeSlug");
function isWorktreeListPorcelainAttribute(line) {
  return line === "bare" || line === "detached" || line === "locked" || line === "prunable" || line.startsWith("HEAD ") || line.startsWith("branch ") || line.startsWith("locked ") || line.startsWith("prunable ");
}
__name(isWorktreeListPorcelainAttribute, "isWorktreeListPorcelainAttribute");
var GitWorktreeService = class _GitWorktreeService {
  static {
    __name(this, "GitWorktreeService");
  }
  sourceRepoPath;
  gitPromise;
  customBaseDir;
  constructor(sourceRepoPath, customBaseDir) {
    this.sourceRepoPath = path2.resolve(sourceRepoPath);
    this.customBaseDir = customBaseDir;
  }
  getGit() {
    this.gitPromise ??= loadSimpleGit().then(
      ({ simpleGit }) => simpleGit(this.sourceRepoPath)
    );
    return this.gitPromise;
  }
  /**
   * Gets the directory where worktrees are stored.
   * @param customDir - Optional custom base directory override
   */
  static getBaseDir(customDir) {
    if (customDir) {
      return path2.resolve(customDir);
    }
    return path2.join(Storage.getGlobalQwenDir(), WORKTREES_DIR);
  }
  /**
   * Gets the directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getSessionDir(sessionId, customBaseDir) {
    return path2.join(_GitWorktreeService.getBaseDir(customBaseDir), sessionId);
  }
  /**
   * Gets the worktrees directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getWorktreesDir(sessionId, customBaseDir) {
    return path2.join(
      _GitWorktreeService.getSessionDir(sessionId, customBaseDir),
      WORKTREES_DIR
    );
  }
  /**
   * Instance-level base dir, using the custom dir if provided at construction.
   */
  getBaseDirForInstance() {
    return _GitWorktreeService.getBaseDir(this.customBaseDir);
  }
  /**
   * Checks if git is available on the system.
   */
  async checkGitAvailable() {
    const { available } = isCommandAvailable("git");
    if (!available) {
      return {
        available: false,
        error: "Git is not installed. Please install Git."
      };
    }
    return { available: true };
  }
  /**
   * Resolves the absolute path of the enclosing git repository's top
   * directory. Used by callers that need to anchor general-purpose
   * worktrees at the *repo* root rather than the cwd they were invoked
   * from — otherwise running `qwen` from a monorepo subdirectory would
   * scatter `.qwen/worktrees/` under each subdirectory instead of
   * gathering them under the repo root.
   *
   * Returns the canonical top-level path on success, or `null` when the
   * cwd is not inside a git repo (caller should error).
   */
  async getRepoTopLevel() {
    try {
      const out = await (await this.getGit()).raw(["rev-parse", "--show-toplevel"]);
      const top = out.replace(/\n$/, "");
      return top.length > 0 ? top : null;
    } catch (error) {
      debugLogger.warn(
        `getRepoTopLevel failed at ${this.sourceRepoPath}: ${error}`
      );
      return null;
    }
  }
  /**
   * Returns the repository's primary working tree path, or `null` when it
   * cannot be determined. Unlike `getRepoTopLevel()` — which answers
   * "which worktree is this cwd in" and so names a linked worktree's OWN
   * root when run inside one — this always resolves the MAIN tree:
   * `git worktree list --porcelain` lists the primary working tree first
   * regardless of where in the repository it runs. Callers anchoring a
   * check at the repository itself (not the current worktree) use this.
   *
   * The porcelain format is newline-delimited, so a main-tree path that
   * itself contains a newline splits across lines and the first entry
   * truncates. The remainder then appears where a record attribute belongs
   * — it is not one, which detects most truncations. Not all: a remainder
   * that is itself attribute-shaped (`detached`, `HEAD …`, …) — or a path
   * ending right at a newline, whose blank remainder ends the record — still
   * parses. The parsed anchor is therefore round-trip-validated below:
   * `rev-parse --git-common-dir` run AT the anchor must agree with this
   * repository's own common dir, otherwise this method returns `null` and
   * callers fall back to `getRepoTopLevel()`, whose single-value
   * `--show-toplevel` answer keeps interior newlines intact. (`--porcelain
   * -z` would be immune but needs Git >= 2.36.) A truncated anchor is not
   * merely wrong: it can resolve inside a DIFFERENT repository whose
   * worktree registry the caller's gate would then consult.
   */
  async getMainWorktreePath() {
    try {
      const out = await (await this.getGit()).raw(["worktree", "list", "--porcelain"]);
      const lines = out.split("\n");
      const firstLine = lines[0] ?? "";
      if (!firstLine.startsWith("worktree ")) return null;
      for (const line of lines.slice(1)) {
        const attr = line.trim();
        if (attr === "") break;
        if (!isWorktreeListPorcelainAttribute(attr)) return null;
      }
      const mainPath = firstLine.slice("worktree ".length);
      if (mainPath.length === 0) return null;
      const realpathOr = /* @__PURE__ */ __name(async (p) => {
        try {
          return await fs2.realpath(p);
        } catch {
          return p;
        }
      }, "realpathOr");
      const { simpleGit } = await loadSimpleGit();
      const [ourRaw, anchorRaw] = await Promise.all([
        (await this.getGit()).raw(["rev-parse", "--git-common-dir"]),
        simpleGit(mainPath).raw(["rev-parse", "--git-common-dir"])
      ]);
      const ourCommonDir = await realpathOr(
        path2.resolve(this.sourceRepoPath, ourRaw.trim())
      );
      const anchorCommonDir = await realpathOr(
        path2.resolve(mainPath, anchorRaw.trim())
      );
      return ourCommonDir === anchorCommonDir ? mainPath : null;
    } catch (error) {
      debugLogger.warn(
        `getMainWorktreePath failed at ${this.sourceRepoPath}: ${error}`
      );
      return null;
    }
  }
  /**
   * Checks if the source path is a git repository.
   */
  async isGitRepository() {
    try {
      const [git, { CheckRepoActions }] = await Promise.all([
        this.getGit(),
        loadSimpleGit()
      ]);
      try {
        const isRoot = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (isRoot) {
          return true;
        }
      } catch {
      }
      try {
        return await git.checkIsRepo();
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }
  /**
   * Initializes the source directory as a git repository.
   * Returns true if initialization was performed, false if already a repo.
   */
  async initializeRepository() {
    const isRepo = await this.isGitRepository();
    if (isRepo) {
      return { initialized: false };
    }
    try {
      const git = await this.getGit();
      await initRepositoryWithMainBranch(git);
      await git.add(".");
      await git.commit("Initial commit", {
        "--allow-empty": null
      });
      return { initialized: true };
    } catch (error) {
      return {
        initialized: false,
        error: `Failed to initialize git repository: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }
  /**
   * Gets the current branch name.
   */
  async getCurrentBranch() {
    const branch = await (await this.getGit()).revparse(["--abbrev-ref", "HEAD"]);
    return branch.trim();
  }
  /**
   * Gets the current commit hash.
   */
  async getCurrentCommitHash() {
    const hash = await (await this.getGit()).revparse(["HEAD"]);
    return hash.trim();
  }
  /**
   * Resolves a git ref name to a 40-char commit SHA. Returns `null` when
   * the ref is unknown / unborn / not a commit.
   *
   * Used by Phase D-3 to lock in `FETCH_HEAD` immediately after
   * `fetchPullRequestRef` succeeds, so the SHA passed to
   * `git worktree add` is immutable against a concurrent `git fetch` from
   * another process sharing the same repo, AND so `WorktreeExitDialog`'s
   * `rev-list <originalHeadCommit>..HEAD` counts only THIS session's new
   * work rather than every commit in the fetched PR.
   */
  async resolveRef(ref) {
    try {
      const out = (await (await this.getGit()).raw(["rev-parse", "--verify", ref])).trim();
      return /^[0-9a-f]{40}$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }
  /**
   * Creates a single worktree.
   */
  async createWorktree(sessionId, name, baseBranch) {
    try {
      const worktreesDir = _GitWorktreeService.getWorktreesDir(
        sessionId,
        this.customBaseDir
      );
      await fs2.mkdir(worktreesDir, { recursive: true });
      const sanitizedName = this.sanitizeName(name);
      const worktreePath = path2.join(worktreesDir, sanitizedName);
      const exists = await this.pathExists(worktreePath);
      if (exists) {
        return {
          success: false,
          error: `Worktree already exists at ${worktreePath}`
        };
      }
      const base = baseBranch || await this.getCurrentBranch();
      const shortSession = sessionId.slice(0, 6);
      const branchName = `${base}-${shortSession}-${sanitizedName}`;
      await (await this.getGit()).raw(["worktree", "add", "-b", branchName, worktreePath, base]);
      const worktree = {
        id: `${sessionId}/${sanitizedName}`,
        name,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now()
      };
      return { success: true, worktree };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create worktree for "${name}": ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }
  /**
   * Sets up all worktrees for a session.
   * This is the main entry point for worktree creation.
   */
  async setupWorktrees(config) {
    const result = {
      success: false,
      sessionId: config.sessionId,
      worktrees: [],
      worktreesByName: {},
      errors: []
    };
    const sanitizedNames = /* @__PURE__ */ new Map();
    for (const name of config.worktreeNames) {
      const sanitized = this.sanitizeName(name);
      if (!sanitized) {
        result.errors.push({
          name,
          error: "Worktree name becomes empty after sanitization"
        });
        continue;
      }
      const existing = sanitizedNames.get(sanitized);
      if (existing) {
        result.errors.push({
          name,
          error: `Worktree name collides with "${existing}" after sanitization`
        });
        continue;
      }
      sanitizedNames.set(sanitized, name);
    }
    if (result.errors.length > 0) {
      return result;
    }
    const gitCheck = await this.checkGitAvailable();
    if (!gitCheck.available) {
      result.errors.push({ name: "system", error: gitCheck.error });
      return result;
    }
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      result.errors.push({
        name: "repository",
        error: "Source path is not a git repository."
      });
      return result;
    }
    const sessionDir = _GitWorktreeService.getSessionDir(
      config.sessionId,
      this.customBaseDir
    );
    await fs2.mkdir(sessionDir, { recursive: true });
    const configPath = path2.join(sessionDir, "config.json");
    const configFile = {
      sessionId: config.sessionId,
      sourceRepoPath: config.sourceRepoPath,
      worktreeNames: config.worktreeNames,
      baseBranch: config.baseBranch,
      createdAt: Date.now(),
      ...config.metadata
    };
    await fs2.writeFile(configPath, JSON.stringify(configFile, null, 2));
    let dirtyStateSnapshot = "";
    try {
      dirtyStateSnapshot = (await (await this.getGit()).stash(["create"])).trim();
    } catch {
    }
    let untrackedFiles = [];
    try {
      const raw = await (await this.getGit()).raw(["ls-files", "--others", "--exclude-standard"]);
      untrackedFiles = raw.trim().split("\n").filter(Boolean);
    } catch {
    }
    for (const name of config.worktreeNames) {
      const createResult = await this.createWorktree(
        config.sessionId,
        name,
        config.baseBranch
      );
      if (createResult.success && createResult.worktree) {
        result.worktrees.push(createResult.worktree);
        result.worktreesByName[name] = createResult.worktree;
      } else {
        result.errors.push({
          name,
          error: createResult.error || "Unknown error"
        });
      }
    }
    if (result.errors.length > 0) {
      try {
        await this.cleanupSession(config.sessionId);
      } catch (error) {
        result.errors.push({
          name: "cleanup",
          error: `Failed to cleanup after partial worktree creation: ${error instanceof Error ? error.message : "Unknown error"}`
        });
      }
      result.success = false;
      return result;
    }
    result.success = result.worktrees.length === config.worktreeNames.length;
    if (result.success) {
      for (const worktree of result.worktrees) {
        const { simpleGit } = await loadSimpleGit();
        const wtGit = simpleGit(worktree.path);
        if (dirtyStateSnapshot) {
          try {
            await wtGit.raw(["stash", "apply", dirtyStateSnapshot]);
          } catch {
          }
        }
        for (const relPath of untrackedFiles) {
          try {
            const src = path2.join(this.sourceRepoPath, relPath);
            const dst = path2.join(worktree.path, relPath);
            await fs2.mkdir(path2.dirname(dst), { recursive: true });
            await fs2.copyFile(src, dst);
          } catch {
          }
        }
        try {
          await wtGit.add(["--all"]);
          await wtGit.commit(BASELINE_COMMIT_MESSAGE, {
            "--allow-empty": null,
            "--no-verify": null
          });
        } catch {
        }
      }
    }
    return result;
  }
  /**
   * Lists all worktrees for a session.
   */
  async listWorktrees(sessionId) {
    const worktreesDir = _GitWorktreeService.getWorktreesDir(
      sessionId,
      this.customBaseDir
    );
    try {
      const entries = await fs2.readdir(worktreesDir, { withFileTypes: true });
      const worktrees = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const worktreePath = path2.join(worktreesDir, entry.name);
          let branchName = "";
          try {
            branchName = execSync("git rev-parse --abbrev-ref HEAD", {
              cwd: worktreePath,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"]
            }).trim();
          } catch {
          }
          let createdAt = Date.now();
          try {
            const stats = await fs2.stat(worktreePath);
            createdAt = stats.birthtimeMs;
          } catch {
          }
          worktrees.push({
            id: `${sessionId}/${entry.name}`,
            name: entry.name,
            path: worktreePath,
            branch: branchName,
            isActive: true,
            createdAt
          });
        }
      }
      return worktrees;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  /**
   * Removes a single worktree.
   */
  async removeWorktree(worktreePath) {
    let git;
    try {
      git = await this.getGit();
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove worktree: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
    try {
      await git.raw(["worktree", "remove", worktreePath, "--force"]);
      return { success: true };
    } catch (error) {
      try {
        await fs2.rm(worktreePath, { recursive: true, force: true });
        await git.raw(["worktree", "prune"]);
        return { success: true };
      } catch (_rmError) {
        return {
          success: false,
          error: `Failed to remove worktree: ${error instanceof Error ? error.message : "Unknown error"}`
        };
      }
    }
  }
  /**
   * Cleans up all worktrees and branches for a session.
   */
  async cleanupSession(sessionId) {
    const result = {
      success: true,
      removedWorktrees: [],
      removedBranches: [],
      errors: []
    };
    const worktrees = await this.listWorktrees(sessionId);
    const worktreeBranches = new Set(
      worktrees.map((w) => w.branch).filter(Boolean)
    );
    for (const worktree of worktrees) {
      const removeResult = await this.removeWorktree(worktree.path);
      if (removeResult.success) {
        result.removedWorktrees.push(worktree.name);
      } else {
        result.errors.push(
          removeResult.error || `Failed to remove ${worktree.name}`
        );
        result.success = false;
      }
    }
    const sessionDir = _GitWorktreeService.getSessionDir(
      sessionId,
      this.customBaseDir
    );
    try {
      await fs2.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(
        `Failed to remove session directory: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    try {
      const git = await this.getGit();
      for (const branchName of worktreeBranches) {
        try {
          await git.branch(["-D", branchName]);
          result.removedBranches.push(branchName);
        } catch {
        }
      }
      await git.raw(["worktree", "prune"]);
    } catch {
    }
    return result;
  }
  /**
   * Gets the diff between a worktree and its baseline state.
   * Prefers the baseline commit (which includes the dirty state overlay)
   * so the diff only shows the agent's changes. Falls back to the base branch
   * when no baseline commit exists.
   */
  async getWorktreeDiff(worktreePath, baseBranch) {
    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const base = await this.resolveBaseline(worktreeGit) ?? baseBranch ?? await this.getCurrentBranch();
      return await this.withStagedChanges(
        worktreeGit,
        () => worktreeGit.diff([...NO_EXEC_DIFF_FLAGS, "--binary", "--cached", base])
      );
    } catch (error) {
      return `Error getting diff: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  }
  /**
   * Applies raw changes from a worktree back to the target working directory.
   *
   * Diffs from the baseline commit (which already includes the user's
   * dirty state) so the patch only contains the agent's new changes.
   * Falls back to merge-base when no baseline commit exists.
   */
  async applyWorktreeChanges(worktreePath, targetPath) {
    const target = targetPath || this.sourceRepoPath;
    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const targetGit = simpleGit(target);
      let base = await this.resolveBaseline(worktreeGit);
      const hasBaseline = !!base;
      if (!base) {
        const targetHead = (await targetGit.revparse(["HEAD"])).trim();
        base = (await worktreeGit.raw(["merge-base", "HEAD", targetHead])).trim();
      }
      const patch = await this.withStagedChanges(
        worktreeGit,
        () => worktreeGit.diff([...NO_EXEC_DIFF_FLAGS, "--binary", "--cached", base])
      );
      if (!patch.trim()) {
        return { success: true };
      }
      const patchFile = path2.join(
        this.getBaseDirForInstance(),
        `.worktree-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
      );
      await fs2.mkdir(path2.dirname(patchFile), { recursive: true });
      await fs2.writeFile(patchFile, patch, "utf-8");
      try {
        const applyArgs = hasBaseline ? ["apply", "--whitespace=nowarn", patchFile] : ["apply", "--3way", "--whitespace=nowarn", patchFile];
        await targetGit.raw(applyArgs);
      } finally {
        await fs2.rm(patchFile, { force: true });
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to apply worktree changes: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }
  /**
   * Lists all sessions stored in the worktree base directory.
   */
  static async listSessions(customBaseDir) {
    const baseDir = _GitWorktreeService.getBaseDir(customBaseDir);
    const sessions = [];
    try {
      const entries = await fs2.readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path2.join(baseDir, entry.name, "config.json");
          try {
            const configContent = await fs2.readFile(configPath, "utf-8");
            const config = JSON.parse(configContent);
            const worktreesDir = path2.join(baseDir, entry.name, WORKTREES_DIR);
            let worktreeCount = 0;
            try {
              const worktreeEntries = await fs2.readdir(worktreesDir);
              worktreeCount = worktreeEntries.length;
            } catch {
            }
            sessions.push({
              sessionId: entry.name,
              createdAt: config.createdAt || Date.now(),
              sourceRepoPath: config.sourceRepoPath || "",
              worktreeCount
            });
          } catch {
          }
        }
      }
      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }
  /**
   * Finds the baseline commit in a worktree, if one exists.
   * Returns the commit SHA, or null if not found.
   */
  async resolveBaseline(worktreeGit) {
    try {
      const sha = (await worktreeGit.raw([
        "log",
        "--grep",
        BASELINE_COMMIT_MESSAGE,
        "--format=%H",
        "-1"
      ])).trim();
      return sha || null;
    } catch {
      return null;
    }
  }
  /** Stages all changes, runs a callback, then resets the index. */
  async withStagedChanges(git, fn) {
    await git.add(["--all"]);
    try {
      return await fn();
    } finally {
      try {
        await git.raw(["reset"]);
      } catch {
      }
    }
  }
  sanitizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }
  async pathExists(p) {
    try {
      await fs2.access(p);
      return true;
    } catch {
      return false;
    }
  }
  // ──────────────────────────────────────────────────────────────────────
  // User-facing worktree APIs (used by EnterWorktree / ExitWorktree tools
  // and AgentTool `isolation: 'worktree'`). These create worktrees under
  // `<projectRoot>/.qwen/worktrees/<slug>` rather than under the
  // session-scoped Arena baseDir.
  // ──────────────────────────────────────────────────────────────────────
  /**
   * Returns the directory holding all general-purpose worktrees for this
   * repo: `<projectRoot>/.qwen/worktrees`.
   */
  getUserWorktreesDir() {
    return path2.join(this.sourceRepoPath, ".qwen", WORKTREES_DIR);
  }
  /**
   * Returns the absolute worktree path for a given slug.
   */
  getUserWorktreePath(slug) {
    return path2.join(this.getUserWorktreesDir(), slug);
  }
  /**
   * Generates an auto-slug `{adj}-{noun}-{6hex}` for an unnamed worktree.
   *
   * Uses `randomInt` for the word-list indices (uniform by construction
   * via rejection sampling — `randomBytes[i] % len` would be biased
   * whenever `len` doesn't divide `2^8`, and CodeQL's
   * `js/biased-cryptographic-random` rule flags it even when it
   * happens to be exact). Uses `randomBytes` for the suffix because
   * hex encoding of raw bytes is unbiased. ~16M combinations × 8 adj
   * × 8 noun ≈ 1B distinct slugs.
   */
  static generateAutoSlug() {
    const ADJECTIVES = [
      "swift",
      "bright",
      "calm",
      "keen",
      "bold",
      "eager",
      "kind",
      "quick"
    ];
    const NOUNS = ["fox", "owl", "elm", "oak", "ray", "sky", "leaf", "pine"];
    const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
    const noun = NOUNS[randomInt(0, NOUNS.length)];
    const suffix = randomBytes(3).toString("hex");
    return `${adj}-${noun}-${suffix}`;
  }
  /**
   * Parses a PR reference from a string. Recognised forms:
   *
   * - `#123` — shorthand PR number
   * - `https://github.com/<owner>/<repo>/pull/123` — full GitHub URL
   *   (any host, any query string, any fragment)
   *
   * Returns the parsed PR number on match, `null` otherwise. The slug for
   * a PR worktree is derived by callers as `pr-<N>` and the branch as
   * `worktree-pr-<N>` (see `createUserWorktree`).
   *
   * Mirrors claude-code's `parsePRReference` (utils/worktree.ts:633) so
   * cross-CLI muscle memory transfers.
   */
  static parsePRReference(input) {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    const urlMatch = trimmed.match(
      /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i
    );
    if (urlMatch?.[1]) {
      const n = parseInt(urlMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    const hashMatch = trimmed.match(/^#([1-9]\d*)$/);
    if (hashMatch?.[1]) {
      const n = parseInt(hashMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    return null;
  }
  /**
   * Identifies the registered worktree at `worktreePath` as a member of
   * THIS repository (`sourceRepoPath`). Returns the branch + HEAD commit
   * SHA on success, or `null` when the path is not a worktree of this
   * repo.
   *
   * Used by Phase D-1's re-attach path: when `--worktree foo` is passed
   * and `<repoRoot>/.qwen/worktrees/foo` already exists on disk, we
   * verify it really IS a Qwen-managed worktree of the current repo (not
   * a standalone `git init` someone dropped at that path) before
   * assuming it's safe to chdir into. Returning the HEAD SHA in the
   * same call avoids a second subprocess to recapture it after chdir.
   *
   * Implementation — a single `git rev-parse` returning four lines:
   * 1. `HEAD` → the worktree's HEAD commit SHA (must come BEFORE
   *    `--abbrev-ref` since the flag sticks for all subsequent refs).
   * 2. `--abbrev-ref HEAD` → the branch name. A detached HEAD produces
   *    `HEAD` here, which we treat as "no real branch" and return null
   *    — the caller's re-attach gate will then refuse, since the
   *    slug-derived branch couldn't possibly be `HEAD`.
   * 3. `--git-common-dir` → the common `.git` directory. For a real
   *    linked worktree of this repo that's `<sourceRepoPath>/.git`;
   *    for a sibling `git init` it resolves to `<worktreePath>/.git`.
   *    We compare against this repo's own common-dir to reject the
   *    latter.
   * 4. `--show-toplevel` → git's idea of the worktree top. For a real
   *    linked worktree this equals `worktreePath`; for a plain
   *    directory living UNDER the main repo (e.g. `mkdir
   *    <repo>/.qwen/worktrees/foo`) git walks up to the outer `.git`
   *    and returns the OUTER repo's root — which would otherwise pass
   *    the common-dir check and let us "re-attach" to a non-worktree
   *    directory. Compare paths to reject this.
   */
  async getRegisteredWorktreeBranch(worktreePath) {
    let resolvedWorktreePath;
    try {
      const stat2 = await fs2.stat(worktreePath);
      if (!stat2.isDirectory()) return null;
      resolvedWorktreePath = await fs2.realpath(worktreePath);
    } catch {
      return null;
    }
    let ourCommonDir;
    let headCommit;
    let branch;
    let probeCommonDir;
    let probeToplevel;
    try {
      const { simpleGit } = await loadSimpleGit();
      const probeGit = simpleGit(worktreePath);
      const [ourRaw, probeRaw] = await Promise.all([
        (await this.getGit()).raw(["rev-parse", "--git-common-dir"]),
        probeGit.raw([
          "rev-parse",
          "HEAD",
          "--abbrev-ref",
          "HEAD",
          "--git-common-dir",
          "--show-toplevel"
        ])
      ]);
      ourCommonDir = path2.resolve(this.sourceRepoPath, ourRaw.trim());
      const lines = probeRaw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length < 4) return null;
      headCommit = lines[0];
      branch = lines[1];
      probeCommonDir = path2.resolve(worktreePath, lines[2]);
      probeToplevel = path2.resolve(lines[3]);
    } catch (error) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: probe at ${worktreePath} failed: ${error}`
      );
      return null;
    }
    if (probeCommonDir !== ourCommonDir) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} belongs to a different repo (common-dir=${probeCommonDir}, expected ${ourCommonDir})`
      );
      return null;
    }
    if (probeToplevel !== resolvedWorktreePath) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} is not a registered worktree (toplevel=${probeToplevel}, expected ${resolvedWorktreePath})`
      );
      return null;
    }
    if (!branch || branch === "HEAD") return null;
    return { branch, headCommit };
  }
  /**
   * Returns true when `worktreePath` is a REGISTERED linked worktree of this
   * repository — i.e. git's own registry entry for it points back at exactly
   * this path — and it is not the repository's primary working tree.
   *
   * Two complementary checks, because neither alone suffices:
   *
   * 1. **Registry** (repo side): some `<commonDir>/worktrees/<name>/gitdir`
   *    must name this path. Everything read here belongs to the repository, so
   *    a candidate cannot forge it — fabricating `<target>/.git` and the git
   *    dir it points at (with its own `commondir`/`gitdir`) only controls
   *    candidate-side files, which are never consulted. This also rejects the
   *    primary working tree, which has no `worktrees/<name>` entry, along with
   *    other repositories' worktrees and a directory carrying a `.git` file
   *    *copied* from a real worktree (the entry names the original, not the
   *    copy).
   * 2. **Liveness** (inside the path): the path's own `--git-dir` must be that
   *    same entry. A registry record survives `rm -rf` of its directory (git
   *    tags it `prunable` and keeps it for gc.worktreePruneExpire, 3 months by
   *    default); if the path is then recreated as an ordinary directory, git
   *    resolves it into the MAIN checkout. The registry answers "is this path
   *    registered?"; only the probe answers "is it a worktree right now?".
   *
   * A `.git`-is-a-file heuristic would misfire here (the main tree also carries
   * a `.git` file under `git clone --separate-git-dir` and in submodules), and
   * reading the registry directly avoids parsing `git worktree list`, whose
   * porcelain form is newline-delimited — and so injectable by a worktree path
   * that itself contains a newline — unless `-z` is used, which needs
   * Git >= 2.36 and would break older git.
   *
   * Fail-closed: any git or I/O error returns false, so a caller that gates
   * isolation on this check rejects an unverifiable path rather than
   * silently pinning a sub-agent to a possibly-main tree.
   */
  async isRegisteredLinkedWorktree(worktreePath) {
    const realpathOr = /* @__PURE__ */ __name(async (p) => {
      try {
        return await fs2.realpath(p);
      } catch {
        return path2.resolve(p);
      }
    }, "realpathOr");
    try {
      const target = await fs2.realpath(worktreePath);
      const ourCommonDir = path2.resolve(
        this.sourceRepoPath,
        (await (await this.getGit()).raw(["rev-parse", "--git-common-dir"])).trim()
      );
      const worktreesDir = path2.join(ourCommonDir, "worktrees");
      let entryNames;
      try {
        entryNames = await fs2.readdir(worktreesDir);
      } catch {
        return false;
      }
      let entryGitDir = null;
      for (const name of entryNames) {
        const entry = path2.join(worktreesDir, name);
        let pointer;
        try {
          pointer = (await fs2.readFile(path2.join(entry, "gitdir"), "utf8")).trim();
        } catch {
          continue;
        }
        if (await realpathOr(path2.dirname(pointer)) === target) {
          entryGitDir = entry;
          break;
        }
      }
      if (!entryGitDir) return false;
      const { simpleGit } = await loadSimpleGit();
      const rawGitDir = (await simpleGit(target).raw(["rev-parse", "--git-dir"])).trim();
      const probeGitDir = await realpathOr(path2.resolve(target, rawGitDir));
      return probeGitDir === await realpathOr(entryGitDir);
    } catch (error) {
      debugLogger.debug(
        `isRegisteredLinkedWorktree: probe at ${worktreePath} failed: ${error}`
      );
      return false;
    }
  }
  /**
   * Fetches the GitHub PR ref `refs/pull/<N>/head` from the `origin` remote
   * so a subsequent `createUserWorktree(..., 'FETCH_HEAD')` call can branch
   * off the PR's tip (Phase D-3). Returns `{ success: true }` on success,
   * or `{ success: false, error }` with a user-facing reason on failure.
   *
   * Implementation notes:
   *
   * - Uses `git fetch origin pull/<N>/head` (no `gh` CLI dependency).
   * - Hard timeout of 30s by default — overridable for tests. A hung git
   *   process on a misconfigured corporate proxy would otherwise stall
   *   the entire startup sequence.
   * - Does NOT create a local branch — leaves the ref accessible only
   *   via `FETCH_HEAD`. Subsequent `git worktree add -b <branch> <wt>
   *   FETCH_HEAD` materialises the worktree branch off it.
   *
   * Error message taxonomy is friendly because this is the user's first
   * impression when their `--worktree=#<N>` fails:
   * - missing `origin` → tell them the remote is required + how to fix
   * - timeout → mention the configured timeout so they can blame the network
   * - generic failure → "PR may not exist or origin is unreachable"
   */
  async fetchPullRequestRef(prNumber, options) {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || prNumber > 1e9) {
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`
      };
    }
    const timeoutMs = options?.timeoutMs ?? 3e4;
    const prNumberStr = String(prNumber);
    if (!/^[1-9][0-9]*$/.test(prNumberStr)) {
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`
      };
    }
    const refspec = `pull/${prNumberStr}/head`;
    try {
      await execFileAsync(
        "git",
        ["fetch", "--end-of-options", "origin", refspec],
        {
          cwd: this.sourceRepoPath,
          timeout: timeoutMs,
          env: { ...process.env, LANG: "C", LC_ALL: "C" }
        }
      );
      return { success: true };
    } catch (error) {
      const err = error;
      const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr instanceof Buffer ? err.stderr.toString("utf8") : "";
      const lower = stderr.toLowerCase();
      if (err.signal === "SIGTERM") {
        return {
          success: false,
          error: `Failed to fetch PR #${prNumber}: timed out after ${Math.round(timeoutMs / 1e3)}s. Check network connectivity and any HTTP(S) proxy settings.`
        };
      }
      if (lower.includes("does not appear to be a git repository") || lower.includes("could not read from remote repository") || lower.includes("'origin' does not appear")) {
        return {
          success: false,
          error: `--worktree=#${prNumber} requires an "origin" remote that points at GitHub. Add one with \`git remote add origin <url>\` and retry.`
        };
      }
      if (lower.includes("no such ref") || lower.includes("couldn't find remote ref") || lower.includes("couldn't find remote ref pull/")) {
        return {
          success: false,
          error: `Failed to fetch PR #${prNumber}: the PR does not exist on origin, or origin is not a GitHub repository (only GitHub exposes refs/pull/<N>/head).`
        };
      }
      const firstLine = stderr.split("\n").find((l) => l.trim().length > 0);
      const detail = firstLine ? ` (${firstLine.trim()})` : "";
      debugLogger.warn(
        `fetchPullRequestRef: git fetch pull/${prNumber}/head failed: ${error}`
      );
      return {
        success: false,
        error: `Failed to fetch PR #${prNumber}: PR may not exist, or origin remote is unreachable${detail}.`
      };
    }
  }
  /**
   * Validates a worktree slug. Returns null on success, or an error message.
   *
   * Rules (mirrors claude-code's `validateWorktreeSlug`):
   * - Non-empty, ≤ 64 chars
   * - Only `[a-zA-Z0-9._-]` characters; no path separators
   * - No `..` or leading/trailing dots (would resolve outside the worktrees dir)
   * - Must not start with `agent-`: that prefix is reserved for the
   *   ephemeral worktrees `AgentTool isolation:'worktree'` produces.
   *   The startup sweep auto-removes anything matching
   *   {@link AGENT_WORKTREE_SLUG_PATTERN}, so a user-named
   *   `agent-1234567` would be silently deleted after 30 days along
   *   with any work it contained.
   */
  static validateUserWorktreeSlug(slug, options) {
    if (typeof slug !== "string" || slug.length === 0) {
      return "Worktree name must be a non-empty string.";
    }
    if (slug.length > 64) {
      return "Worktree name must be at most 64 characters.";
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      return "Worktree name may only contain letters, digits, dots, underscores, and hyphens.";
    }
    if (slug.includes("..") || slug.startsWith(".") || slug.startsWith("-")) {
      return 'Worktree name must not start with "." or "-" or contain "..".';
    }
    if (/^pr-[1-9]\d{0,8}$/.test(slug) && options?.allowPrBackedShape !== true) {
      return 'Worktree name must not look like "pr-<number>": that shape is reserved for PR-backed worktrees.';
    }
    if (slug.startsWith(`${AGENT_WORKTREE_PREFIX}-`)) {
      if (!AGENT_WORKTREE_SLUG_PATTERN.test(slug)) {
        return `Worktree name must not start with "${AGENT_WORKTREE_PREFIX}-": that prefix is reserved for ephemeral agent worktrees and is subject to automatic cleanup after 30 days.`;
      }
    }
    return null;
  }
  /**
   * Creates a general-purpose worktree at `<projectRoot>/.qwen/worktrees/<slug>`
   * with branch `worktree-<slug>`. Used by `EnterWorktreeTool` and
   * `AgentTool isolation:'worktree'`.
   *
   * Refuses to overwrite an existing branch: if `worktree-<slug>` already
   * exists (e.g., from a manual `git checkout -b worktree-foo` or a
   * teammate's push), the call fails with a clear error rather than
   * silently resetting the branch. The previous `-B` form would have
   * dropped any commits unique to that branch — see review #4073.
   */
  async createUserWorktree(slug, baseBranch, options) {
    const validationError = _GitWorktreeService.validateUserWorktreeSlug(
      slug,
      options?.prBacked === true ? { allowPrBackedShape: true } : void 0
    );
    if (validationError) {
      debugLogger.warn(
        `createUserWorktree: invalid slug ${slug}: ${validationError}`
      );
      return { success: false, error: validationError };
    }
    try {
      const worktreesDir = this.getUserWorktreesDir();
      await fs2.mkdir(worktreesDir, { recursive: true });
      const worktreePath = path2.join(worktreesDir, slug);
      if (await fileExists(worktreePath)) {
        const error = `Worktree already exists at ${worktreePath}`;
        debugLogger.warn(`createUserWorktree: ${error}`);
        return { success: false, error };
      }
      await this.ensureWorktreesGitignored();
      const base = baseBranch || await this.getCurrentBranch();
      const branchName = worktreeBranchForSlug(slug);
      const branchExists = await this.localBranchExists(branchName);
      if (branchExists) {
        const error = `Cannot create worktree "${slug}": branch ${branchName} already exists. Choose a different name, or delete the branch first (e.g. \`git branch -d ${branchName}\`).`;
        debugLogger.warn(`createUserWorktree: ${error}`);
        return { success: false, error };
      }
      await (await this.getGit()).raw(["worktree", "add", "-b", branchName, worktreePath, base]);
      await this.configureHooksPath(worktreePath).catch((error) => {
        debugLogger.warn(
          `createUserWorktree: failed to configure core.hooksPath for ${slug}: ${error}`
        );
      });
      const symlinkPaths = options?.symlinkDirectories ?? [];
      if (symlinkPaths.length > 0) {
        await this.symlinkConfiguredDirectories(
          worktreePath,
          symlinkPaths
        ).catch((error) => {
          debugLogger.warn(
            `createUserWorktree: symlinkConfiguredDirectories failed for ${slug}: ${error}`
          );
        });
      }
      const worktree = {
        id: slug,
        name: slug,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now()
      };
      return { success: true, worktree };
    } catch (error) {
      const message = `Failed to create worktree "${slug}": ${error instanceof Error ? error.message : "Unknown error"}`;
      debugLogger.warn(`createUserWorktree: ${message}`);
      return { success: false, error: message };
    }
  }
  /**
   * Configures `core.hooksPath` inside `worktreePath` to point at the main
   * repository's hooks directory. Prefers `.husky/` over `.git/hooks/` to
   * match the convention most JS projects use (husky's prepare script
   * configures `core.hooksPath=.husky` in the main repo).
   *
   * Skips the `git config` write subprocess when the value already
   * matches the desired one — common when this method runs against a
   * worktree that already inherits the same `core.hooksPath` from a
   * prior creation cycle. The probe read itself is still a subprocess
   * (claude-code's `parseGitConfigValue` reads the config file
   * directly to avoid even that, but the read runs once per worktree
   * creation so the extra ~14ms isn't worth the file-parsing complexity).
   */
  async configureHooksPath(worktreePath) {
    const huskyPath = path2.join(this.sourceRepoPath, ".husky");
    let hooksPath = null;
    try {
      await fs2.stat(huskyPath);
      hooksPath = huskyPath;
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        debugLogger.warn(
          `configureHooksPath: cannot stat ${huskyPath}: ${error}`
        );
      }
    }
    if (!hooksPath) {
      try {
        const commonDir = (await (await this.getGit()).raw(["rev-parse", "--git-common-dir"])).trim();
        const resolvedCommonDir = path2.isAbsolute(commonDir) ? commonDir : path2.resolve(this.sourceRepoPath, commonDir);
        const candidate = path2.join(resolvedCommonDir, "hooks");
        await fs2.stat(candidate);
        hooksPath = candidate;
      } catch (error) {
        if (!(isNodeError(error) && error.code === "ENOENT")) {
          debugLogger.warn(
            `configureHooksPath: cannot resolve git common hooks dir: ${error}`
          );
        }
      }
    }
    if (!hooksPath) return;
    const { simpleGit } = await loadSimpleGit();
    const worktreeGit = simpleGit(worktreePath, {
      unsafe: { allowUnsafeHooksPath: true }
    });
    let existing = "";
    try {
      existing = (await worktreeGit.raw(["config", "--local", "core.hooksPath"])).trim();
    } catch {
    }
    if (existing === "") {
      await worktreeGit.raw(["config", "core.hooksPath", hooksPath]);
    } else if (existing !== hooksPath) {
      debugLogger.debug(
        `configureHooksPath: preserving existing core.hooksPath=${existing} (Qwen would have set it to ${hooksPath})`
      );
    }
  }
  /**
   * Phase D-2 symlink loop. For each configured directory under the main
   * repository, creates a symbolic link from the new worktree to the
   * main-repo location (`<worktreePath>/<dir>` → `<repoRoot>/<dir>`).
   *
   * Fail-open semantics — the worktree IS already on disk and usable by
   * the time this runs, so a symlink failure must NOT abort the parent
   * `createUserWorktree` call. Per-entry failures are logged at debug or
   * warn level depending on cause:
   *
   * - **ENOENT on source** (the main repo does not have the directory):
   *   debug log, skip. Typical for users who configure `node_modules`
   *   but launch from a fresh clone where `npm install` hasn't run yet.
   * - **EEXIST on destination** (something already lives at the symlink
   *   target inside the worktree): debug log, skip. No overwrite; the
   *   existing content (whether file, dir, or stale link) wins.
   * - **Absolute path or path traversal in the configured value**:
   *   warn log, skip the entry. Configured values must stay relative to
   *   the repo root to prevent a setting from redirecting writes onto
   *   `/etc`, `~`, or anywhere outside the repo subtree.
   * - **Other I/O errors**: warn log, continue to the next entry.
   *
   * Mirrors claude-code's `symlinkDirectories` helper (utils/worktree.ts).
   */
  async symlinkConfiguredDirectories(worktreePath, configured) {
    let repoRootAbs;
    try {
      repoRootAbs = await fs2.realpath(this.sourceRepoPath);
    } catch {
      debugLogger.warn(
        `symlinkConfiguredDirectories: cannot realpath sourceRepoPath "${this.sourceRepoPath}", skipping all entries`
      );
      return;
    }
    const gitDirAbs = path2.join(repoRootAbs, ".git");
    const qwenDirAbs = path2.join(repoRootAbs, ".qwen");
    const realWorktreePath = await fs2.realpath(worktreePath).catch(() => worktreePath);
    for (const raw of configured) {
      if (typeof raw !== "string" || raw.length === 0) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: skipping non-string / empty entry: ${JSON.stringify(raw)}`
        );
        continue;
      }
      if (path2.isAbsolute(raw)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing absolute path "${raw}"`
        );
        continue;
      }
      if (raw.split(/[\\/]/).includes("..")) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 contains '..' segment`
        );
        continue;
      }
      const sourceAbs = path2.resolve(repoRootAbs, raw);
      if (sourceAbs === repoRootAbs) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing empty / repo-root path "${raw}"`
        );
        continue;
      }
      if (!isWithinRoot(sourceAbs, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 resolves outside repo root (${sourceAbs} vs ${repoRootAbs})`
        );
        continue;
      }
      if (isWithinRoot(sourceAbs, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing git-internal path "${raw}"`
        );
        continue;
      }
      if (isWithinRoot(sourceAbs, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 the .qwen tree is CLI-managed; symlinking any of it could create a worktrees-inside-worktrees loop or alias CLI metadata.`
        );
        continue;
      }
      let sourceStat = null;
      try {
        sourceStat = await fs2.stat(sourceAbs);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          debugLogger.debug(
            `symlinkConfiguredDirectories: source missing, skipping: ${sourceAbs}`
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: cannot stat ${sourceAbs}: ${error}`
          );
        }
        continue;
      }
      let realSource;
      try {
        realSource = await fs2.realpath(sourceAbs);
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath source "${sourceAbs}": ${error}`
        );
        continue;
      }
      if (!isWithinRoot(realSource, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 real source ${realSource} escapes repo root ${repoRootAbs}`
        );
        continue;
      }
      if (isWithinRoot(realSource, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 real source ${realSource} resolves inside .git`
        );
        continue;
      }
      if (isWithinRoot(realSource, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 real source ${realSource} resolves inside .qwen`
        );
        continue;
      }
      const destAbs = path2.join(worktreePath, raw);
      try {
        await fs2.mkdir(path2.dirname(destAbs), { recursive: true });
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot mkdir parent of ${destAbs}: ${error}`
        );
        continue;
      }
      let realDestParent;
      try {
        realDestParent = await fs2.realpath(path2.dirname(destAbs));
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath dest parent for "${raw}" (${path2.dirname(destAbs)}): ${error}`
        );
        continue;
      }
      if (!isWithinRoot(realDestParent, realWorktreePath)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" \u2014 dest parent ${realDestParent} escapes worktree root ${realWorktreePath} (committed-symlink chain)`
        );
        continue;
      }
      try {
        const symlinkType = sourceStat.isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file";
        await fs2.symlink(realSource, destAbs, symlinkType);
        debugLogger.debug(
          `symlinkConfiguredDirectories: linked ${destAbs} \u2192 ${realSource} (${symlinkType})`
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          debugLogger.debug(
            `symlinkConfiguredDirectories: destination exists, skipping: ${destAbs}`
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: failed to link ${destAbs} \u2192 ${realSource}: ${error}`
          );
        }
      }
    }
  }
  /**
   * Returns true if a local branch with the given name exists.
   *
   * Uses `for-each-ref` because `simple-git.raw` swallows the non-zero
   * exit of `show-ref --quiet` and always resolves with empty stdout —
   * so the previous `show-ref` form would always return `true` and
   * permanently block worktree creation. `for-each-ref` instead prints
   * the ref name when it exists and prints nothing when it does not,
   * always exiting 0, so we can decide on the output.
   *
   * Conservative on error: returns false so the caller's "not exists"
   * fast path attempts the create (which itself will fail loudly if the
   * branch exists for some reason this check missed).
   */
  async localBranchExists(branchName) {
    try {
      const out = await (await this.getGit()).raw([
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        `refs/heads/${branchName}`
      ]);
      return out.trim().length > 0;
    } catch (error) {
      debugLogger.warn(`localBranchExists failed for ${branchName}: ${error}`);
      return false;
    }
  }
  /**
   * Ensures `<projectRoot>/.qwen/.gitignore` ignores the worktrees
   * directory. Idempotent: writes only when the file is missing. If the
   * file exists (user may have curated it), this method is a no-op so
   * we never disturb intentional configuration.
   */
  async ensureWorktreesGitignored() {
    try {
      const qwenDir = path2.join(this.sourceRepoPath, ".qwen");
      await fs2.mkdir(qwenDir, { recursive: true });
      const gitignorePath = path2.join(qwenDir, ".gitignore");
      try {
        await fs2.writeFile(
          gitignorePath,
          `# Auto-generated by qwen-code.
${WORKTREES_DIR}/
`,
          { encoding: "utf8", flag: "wx" }
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          return;
        }
        throw error;
      }
    } catch (error) {
      debugLogger.warn(
        `ensureWorktreesGitignored failed (non-fatal): ${error}`
      );
    }
  }
  /**
   * Removes a user worktree, optionally deleting its branch.
   *
   * Branch deletion uses `-d` by default (refuses to drop branches that
   * have commits not merged into HEAD), so a worktree whose tree was
   * left "clean" because the agent committed its work doesn't lose
   * those commits when the cleanup helper sweeps it. Set
   * `forceDeleteBranch: true` to bypass — callers must have already
   * confirmed there is nothing of value on the branch.
   */
  async removeUserWorktree(slug, options = {}) {
    const worktreePath = this.getUserWorktreePath(slug);
    const branchName = worktreeBranchForSlug(slug);
    const removed = await this.removeWorktree(worktreePath);
    if (!removed.success) {
      return removed;
    }
    if (!options.deleteBranch) {
      return { success: true };
    }
    const git = await this.getGit();
    try {
      await git.branch(["-d", branchName]);
      return { success: true };
    } catch (error) {
      debugLogger.warn(
        `removeUserWorktree: safe branch delete failed for ${branchName}: ${error}`
      );
    }
    if (options.forceDeleteBranch) {
      try {
        await git.branch(["-D", branchName]);
        return { success: true };
      } catch (error) {
        debugLogger.warn(
          `removeUserWorktree: force branch delete failed for ${branchName}: ${error}`
        );
      }
    }
    return { success: true, branchPreserved: true };
  }
  /**
   * Reports whether the tip of a user worktree's branch is reachable
   * only from itself — i.e. the branch carries commits that no other
   * local branch or remote ref points at, so dropping the branch would
   * silently destroy them. Used by callers that want to decide whether
   * removing the worktree would lose work the subagent committed but
   * never merged or pushed.
   *
   * Fail-closed: returns `true` on any git error so the caller defaults
   * to preserving rather than destroying the worktree.
   */
  async hasUnmergedWorktreeCommits(slug) {
    const branchName = worktreeBranchForSlug(slug);
    try {
      const git = await this.getGit();
      const tipSha = (await git.revparse([branchName])).trim();
      if (!tipSha) return true;
      const refs = (await git.raw([
        "for-each-ref",
        "--contains",
        tipSha,
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes"
      ])).split("\n").map((s) => s.trim()).filter((s) => s.length > 0 && s !== `refs/heads/${branchName}`);
      return refs.length === 0;
    } catch (error) {
      debugLogger.warn(
        `hasUnmergedWorktreeCommits failed for slug ${slug}: ${error}`
      );
      return true;
    }
  }
  /**
   * Reports whether a worktree has uncommitted tracked changes (staged or
   * unstaged) or untracked files. Used by `ExitWorktreeTool` to refuse
   * `remove` when the user has work in progress.
   *
   * Fail-closed: returns `true` on any git error so the caller assumes the
   * worktree is dirty rather than risking data loss.
   */
  async hasWorktreeChanges(worktreePath) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          ...NO_EXEC_CONFIG,
          "--no-optional-locks",
          "status",
          "--porcelain",
          "--untracked-files=all"
        ],
        {
          cwd: worktreePath,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024
        }
      );
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }
  /**
   * Counts uncommitted file changes in a worktree. Returns null if the
   * worktree can't be inspected (which the caller should treat as "dirty").
   */
  async countWorktreeChanges(worktreePath) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          ...NO_EXEC_CONFIG,
          "--no-optional-locks",
          "status",
          "--porcelain",
          "--untracked-files=all"
        ],
        {
          cwd: worktreePath,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024
        }
      );
      let tracked = 0;
      let untracked = 0;
      for (const line of stdout.split("\n")) {
        if (line.length === 0) continue;
        if (line.startsWith("??")) {
          untracked += 1;
        } else {
          tracked += 1;
        }
      }
      return { tracked, untracked };
    } catch {
      return null;
    }
  }
};

export {
  writeRuntimeStatus,
  readRuntimeStatus,
  clearRuntimeStatus,
  loadSimpleGit,
  worktreeBranchForSlug,
  WORKTREE_SESSION_FILE,
  writeWorktreeSessionMarker,
  WorktreeMarkerCommittedError,
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  transferWorktreeSessionMarkerOwner,
  readWorktreeSessionMarker,
  AGENT_WORKTREE_SLUG_PATTERN,
  generateAgentWorktreeSlug,
  GitWorktreeService
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime status sidecar for an active interactive Qwen Code session.
 *
 * This module writes a small JSON file alongside the session's chat log
 * while an interactive session is alive. It exists so that **external**
 * tools (terminal multiplexers, tab managers, IDE integrations,
 * observability daemons) can answer the question:
 *
 *     "Which Qwen Code session is the running PID X serving?"
 *
 * The CLI does not embed the session id in `argv` for fresh
 * (non-resumed) sessions, and the OS process title can be truncated, so
 * a side-channel file that records the explicit
 * `(pid, session_id, work_dir, ...)` tuple is the most reliable
 * cross-platform signal.
 *
 * Lifecycle:
 * - Written on session start (clean launch or resume); the resume case
 *   atomically overwrites whatever the previous PID wrote.
 * - **Not** deleted on clean `/quit` or on crash. From an external
 *   observer's standpoint the recorded PID no longer exists in either
 *   case, so a liveness check is sufficient and an explicit cleanup
 *   adds nothing.
 * - `clearRuntimeStatus` exists for the narrow case where the same PID
 *   keeps running while no longer serving the recorded session
 *   (e.g. a hypothetical future mode-switch). Not currently invoked.
 *
 * The file is written via `atomicWriteJSON` (write-to-temp + rename,
 * with in-place fallback when ownership differs).
 * The schema is small and stable; external consumers should treat
 * unknown fields as forward-compatible additions.
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
