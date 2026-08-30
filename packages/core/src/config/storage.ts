/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getProjectHash,
  QWEN_DIR,
  sanitizeCwd,
  isTempDirPath,
} from '../utils/paths.js';
import { FatalConfigError } from '../utils/errors.js';
import { hasActiveRuntimeStatusClaimSync } from '../utils/runtimeStatus.js';

export { QWEN_DIR } from '../utils/paths.js';
export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';
export const OAUTH_FILE = 'oauth_creds.json';
export const SKILL_PROVIDER_CONFIG_DIRS = ['.qwen', '.agents'];
const TMP_DIR_NAME = 'tmp';
const BIN_DIR_NAME = 'bin';
const PROJECT_DIR_NAME = 'projects';
const IDE_DIR_NAME = 'ide';
const PLANS_DIR_NAME = 'plans';
const DEBUG_DIR_NAME = 'debug';
const ARENA_DIR_NAME = 'arena';

// Win32 and darwin default volumes equate names differing only in case,
// and realpath preserves the spelling it was given — so the same physical
// path can reach a comparison under two spellings. Fold case there, or a
// case-variant spelling slips past the containment guard.
function platformFoldsCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function isResolvedPathWithinDirectory(childPath: string, parentPath: string) {
  const child = platformFoldsCase() ? childPath.toLowerCase() : childPath;
  const parent = platformFoldsCase() ? parentPath.toLowerCase() : parentPath;
  const relativePath = path.relative(parent, child);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

export class Storage {
  private readonly targetDir: string;
  private readonly runtimeBaseDir: string;

  /**
   * Custom runtime output base directory set via settings.
   * When null, falls back to getGlobalQwenDir().
   */
  private static runtimeBaseDir: string | null = null;
  private static readonly runtimeBaseDirContext = new AsyncLocalStorage<{
    dir: string | null;
    pinned: boolean;
  }>();

  constructor(
    targetDir: string,
    runtimeBaseDir: string = Storage.getRuntimeBaseDir(),
  ) {
    this.targetDir = targetDir;
    this.runtimeBaseDir = path.resolve(runtimeBaseDir);
  }

  /**
   * Expands tilde and resolves relative paths to absolute.
   */
  private static resolvePath(dir: string, cwd?: string): string {
    let resolved = dir;
    if (
      resolved === '~' ||
      resolved.startsWith('~/') ||
      resolved.startsWith('~\\')
    ) {
      const relativeSegments =
        resolved === '~'
          ? []
          : resolved
              .slice(2)
              .split(/[/\\]+/)
              .filter(Boolean);
      resolved = path.join(os.homedir(), ...relativeSegments);
    }
    if (!path.isAbsolute(resolved)) {
      resolved = cwd ? path.resolve(cwd, resolved) : path.resolve(resolved);
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
  static sanitizePlanSessionId(sessionId: string): string {
    const safeName = path
      .basename(sessionId.replace(/\\/g, '/'))
      .replace(/^\.+/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"|?*\x00-\x1F]/g, '_');
    return safeName || '_';
  }

  private static resolveRuntimeBaseDir(
    dir: string | null | undefined,
    cwd?: string,
  ): string | null {
    if (!dir) {
      return null;
    }
    return Storage.resolvePath(dir, cwd);
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
  static setRuntimeBaseDir(dir: string | null | undefined, cwd?: string): void {
    Storage.runtimeBaseDir = Storage.resolveRuntimeBaseDir(dir, cwd);
  }

  /**
   * Runs function execution in an async context with a specific runtime output dir.
   * This is used to isolate runtime output paths between concurrent sessions.
   */
  static runWithRuntimeBaseDir<T>(
    dir: string | null | undefined,
    cwd: string | undefined,
    fn: () => T,
  ): T {
    if (Storage.runtimeBaseDirContext.getStore()?.pinned) {
      return fn();
    }
    const resolved = Storage.resolveRuntimeBaseDir(dir, cwd);
    return Storage.runtimeBaseDirContext.run(
      { dir: resolved, pinned: false },
      fn,
    );
  }

  static runWithResolvedRuntimeBaseDir<T>(dir: string, fn: () => T): T {
    // A managed workspace runtime owns this root for its full lifetime.
    // Unlike the configurable context above, later process-env reloads must
    // not redirect storage created inside this context.
    return Storage.runtimeBaseDirContext.run(
      { dir: path.resolve(dir), pinned: true },
      fn,
    );
  }

  static hasRuntimeBaseDirContext(): boolean {
    return Storage.runtimeBaseDirContext.getStore() !== undefined;
  }

  /**
   * Returns the base directory for all runtime output (temp files, debug logs,
   * session data, todos, insights, etc.).
   *
   * Priority: pinned runtime context > QWEN_RUNTIME_DIR env var > configurable context > setRuntimeBaseDir() value > getGlobalQwenDir()
   * @returns Absolute path to the runtime output base directory
   */
  static getRuntimeBaseDir(): string {
    const contextualDir = Storage.runtimeBaseDirContext.getStore();
    if (contextualDir?.pinned) {
      return contextualDir.dir ?? Storage.getGlobalQwenDir();
    }
    const envDir = process.env['QWEN_RUNTIME_DIR'];
    if (envDir) {
      return (
        Storage.resolveRuntimeBaseDir(envDir) ?? Storage.getGlobalQwenDir()
      );
    }

    if (contextualDir !== undefined) {
      return contextualDir.dir ?? Storage.getGlobalQwenDir();
    }
    if (Storage.runtimeBaseDir) {
      return Storage.runtimeBaseDir;
    }
    return Storage.getGlobalQwenDir();
  }

  static getGlobalQwenDir(): string {
    const envDir = process.env['QWEN_HOME'];
    if (envDir) {
      return Storage.resolvePath(envDir);
    }
    const homeDir = os.homedir();
    if (!homeDir) {
      return path.join(os.tmpdir(), '.qwen');
    }
    return path.join(homeDir, QWEN_DIR);
  }

  static getMcpOAuthTokensPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'mcp-oauth-tokens.json');
  }

  static getGlobalSettingsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'settings.json');
  }

  static getInstallationIdPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'installation_id');
  }

  static getGoogleAccountsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), GOOGLE_ACCOUNTS_FILENAME);
  }

  static getUserCommandsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'commands');
  }

  static getGlobalMemoryFilePath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'memory.md');
  }

  static getGlobalTempDir(): string {
    return path.join(Storage.getRuntimeBaseDir(), TMP_DIR_NAME);
  }

  static getGlobalDebugDir(): string {
    return path.join(Storage.getRuntimeBaseDir(), DEBUG_DIR_NAME);
  }

  static getDebugLogPath(sessionId: string): string {
    return path.join(Storage.getGlobalDebugDir(), `${sessionId}.txt`);
  }

  static getGlobalIdeDir(): string {
    // Pinned to the global Qwen dir so the VS Code companion (which only
    // sees env vars, not settings-based runtimeOutputDir) finds the same
    // lock-file location as the CLI.
    return path.join(Storage.getGlobalQwenDir(), IDE_DIR_NAME);
  }

  /**
   * Resolves pathToResolve by realpathing its deepest existing ancestor and
   * appending the not-yet-created remainder.
   */
  private static resolvePathThroughExistingAncestor(
    pathToResolve: string,
  ): string {
    let candidate = pathToResolve;
    while (true) {
      try {
        const realCandidate = fs.realpathSync(candidate);
        const remainder = path.relative(candidate, pathToResolve);
        return path.join(realCandidate, remainder);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
        const parent = path.dirname(candidate);
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
  private static isPathWithinDirectory(
    childPath: string,
    parentPath: string,
  ): boolean {
    const realParent = Storage.resolvePathThroughExistingAncestor(parentPath);
    const realChild = Storage.resolvePathThroughExistingAncestor(childPath);

    return isResolvedPathWithinDirectory(realChild, realParent);
  }

  static assertPathWithinDirectory(
    childPath: string,
    parentPath: string,
    errorMessage: string,
  ): void {
    if (!Storage.isPathWithinDirectory(childPath, parentPath)) {
      throw new FatalConfigError(errorMessage);
    }
  }

  static getPlansDir(
    projectRoot?: string | null,
    plansDirectory?: string | null,
  ): string {
    const configuredPlansDirectory = plansDirectory?.trim();
    if (configuredPlansDirectory) {
      if (!projectRoot) {
        throw new FatalConfigError(
          'projectRoot is required when plansDirectory is configured.',
        );
      }

      const resolvedProjectRoot = path.resolve(projectRoot);
      const resolvedPlansDirectory = Storage.resolvePath(
        configuredPlansDirectory,
        resolvedProjectRoot,
      );

      Storage.assertPathWithinDirectory(
        resolvedPlansDirectory,
        resolvedProjectRoot,
        `plansDirectory must resolve within the project root.`,
      );

      return resolvedPlansDirectory;
    }

    return path.join(Storage.getGlobalQwenDir(), PLANS_DIR_NAME);
  }

  static getPlanFilePath(
    sessionId: string,
    projectRoot?: string | null,
    plansDirectory?: string | null,
  ): string {
    // Kept for tests and SDK callers that still use Storage helpers directly.
    return path.join(
      Storage.getPlansDir(projectRoot, plansDirectory),
      `${Storage.sanitizePlanSessionId(sessionId)}.md`,
    );
  }

  static getGlobalBinDir(): string {
    return path.join(Storage.getGlobalQwenDir(), BIN_DIR_NAME);
  }

  static getGlobalArenaDir(): string {
    return path.join(Storage.getGlobalQwenDir(), ARENA_DIR_NAME);
  }

  /**
   * Create or adopt the outside-repo landing for /audit reports and sidecars
   * when the audited repository's ignore state cannot keep them out of
   * version control. Per-user and per-project, honoring the QWEN_HOME
   * override; 0700 on POSIX so the quoted (possibly exploitable) module
   * content stays private to the user.
   */
  static ensureAuditFallbackDir(projectRoot: string): string {
    // Resolve symlinks before hashing so the fallback root is stable across
    // spellings of the same directory (macOS `/var` → `/private/var`):
    // plan-files, guard-check, and the SKILL relocation must all agree on
    // one root, or the relocation-containment check spuriously fails.
    let resolved = projectRoot;
    try {
      resolved = fs.realpathSync(projectRoot);
    } catch {
      // Unresolvable (e.g. not yet created): hash the raw path.
    }
    if (platformFoldsCase()) {
      // Case-variant spellings of one physical root must share one leaf.
      resolved = resolved.toLowerCase();
    }
    const baseDir = Storage.getGlobalQwenDir();
    const dir = path.join(baseDir, 'audits', getProjectHash(resolved));
    // The landing exists to keep artifacts OUT of version control, so refuse
    // before creating anything when QWEN_HOME resolves inside the audited
    // repository.
    Storage.assertAuditLandingIsOutsideRepo(dir, resolved);
    // Everything below validates a landing this process may have ADOPTED
    // rather than created. The path is fully predictable — the project hash
    // is a pure function of the root — and 0700 does not exclude the user's
    // own other processes, so "it exists already" is not evidence that this
    // tool made it. The landing is where relocation puts artifacts precisely
    // BECAUSE they must stay private, so adoption is validated, not assumed.
    //
    // Validation walks EVERY component this method creates, not just the
    // leaf. `mkdirSync(…, { recursive: true })` follows symlinks in every
    // component above the final one, and `lstat` refuses to follow only the
    // final one — so a leaf-only check cannot see a redirected parent. With
    // `audits` planted as a symlink (one `ln -s`, no race: `~/.qwen` exists
    // long before `audits` does), the leaf is created inside the planter's
    // directory, reports as a perfectly real directory, and every artifact
    // written "into the landing" lands wherever the link points. Binding
    // writes to "this root" later cannot help if the root itself moved.
    //
    // QWEN_HOME itself is deliberately NOT validated here: it is the user's
    // own configured location, not a path this method invents. It is created
    // recursively when missing — matching every other writer under it — and
    // only `audits` and the project leaf below are validated components.
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      // A dangling symlink, symlink loop, or symlink-to-file as the tail
      // fails resolution here, before any adoption check can own the state;
      // classify it like every other refusal this method owns.
      throw new FatalConfigError(
        `audit: the QWEN_HOME base ${baseDir} could not be created as a ` +
          `directory (${(err as Error).message}) — remove what stands at ` +
          `that path and re-run.`,
      );
    }
    // Re-check now that the base exists: the check above resolves through
    // the deepest EXISTING ancestor, so a not-yet-existing QWEN_HOME passed
    // it, and a same-UID process can plant that tail as a symlink into the
    // audited repository between the check and this mkdir — which
    // mkdirSync(recursive) then follows.
    Storage.assertAuditLandingIsOutsideRepo(dir, resolved);
    const auditsDir = Storage.adoptDirectory(
      path.join(baseDir, 'audits'),
      'the audit artifact directory',
    );
    Storage.adoptDirectory(dir, 'the fallback landing');
    Storage.assertAuditLandingIsClean(dir);
    // Every check above ran BEFORE the component it guards existed, so a
    // same-UID swap landing in a window between checks passes the check that
    // already ran. Re-validate with everything in place: re-adoption
    // lstat-refuses a swapped `audits` or leaf, the content re-check refuses
    // a child planted after the first snapshot, and the containment re-check
    // catches a swapped ancestor the lstats cannot see — failing closed when
    // the swap makes resolution itself impossible. The re-walk narrows the
    // race but cannot close the tail of a path-returning API: the artifact
    // writes must themselves stay contained in the returned root.
    Storage.adoptDirectory(auditsDir, 'the audit artifact directory');
    Storage.adoptDirectory(dir, 'the fallback landing');
    Storage.assertAuditLandingIsClean(dir);
    Storage.assertAuditLandingIsOutsideRepo(dir, resolved, true);
    // The content and containment re-checks above FOLLOW the guarded
    // components, so a swap landing inside either passes every lstat that
    // already ran; re-adoption runs again after them to refuse that case.
    Storage.adoptDirectory(auditsDir, 'the audit artifact directory');
    Storage.adoptDirectory(dir, 'the fallback landing');
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
  private static adoptDirectory(dir: string, what: string): string {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      // EEXIST is the adoption case the checks below exist for. Anything
      // else (a missing parent, a permission error) surfaces as itself.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      throw new FatalConfigError(
        `audit: ${what} ${dir} is not a directory (it may be a symlink ` +
          `planted ahead of the run) — remove it and re-run.`,
      );
    }
    // mkdirSync's mode applies only to directories it CREATES, so a
    // pre-existing component keeps whatever mode it was given. Normalize the
    // FULL mode, not just group/other: a missing owner-read bit (e.g. 0300)
    // is just as planted — listing needs r while creating entries needs only
    // w+x, so it would blind the content check below while writes still
    // succeed. Windows reports a mode that carries no POSIX bits and chmod
    // there is a no-op, so a pre-existing component keeps whatever DACL it
    // had — Node exposes no portable ACL enforcement.
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
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
  private static assertAuditLandingIsClean(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Fail closed: an unlistable landing cannot be validated, and
      // unreadable does NOT imply unwritable — listing needs r while
      // creating entries needs only w+x.
      throw new FatalConfigError(
        `audit: the fallback landing ${dir} could not be listed for ` +
          `validation (${(err as Error).message}) — remove it and re-run.`,
      );
    }
    for (const entry of entries) {
      // The dirent type is a snapshot from the readdir above, and the
      // landing is reused across runs with predictable entry names: a
      // same-UID process can swap what a typed dirent names between the
      // snapshot and this loop reaching it. Lstat every entry fresh and
      // drive every arm — type AND nlink — from that one stat.
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(dir, entry.name));
      } catch {
        continue; // vanished between readdir and lstat
      }
      if (stat.isSymbolicLink()) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a symlink ` +
            `(${entry.name}) — artifacts written under it would land outside ` +
            `the landing. Remove it and re-run.`,
        );
      }
      if (stat.isDirectory()) {
        // Artifacts nest BELOW the leaf, so a directory child is validated
        // like the leaf itself — a planted real subdirectory holding a
        // symlinked file is the same escape.
        Storage.assertAuditLandingIsClean(path.join(dir, entry.name));
        // The recursion re-read this path with follow semantics, so a swap
        // for a symlink-to-directory during the walk validated the target.
        let childStat: fs.Stats;
        try {
          childStat = fs.lstatSync(path.join(dir, entry.name));
        } catch {
          continue; // vanished during the walk — nothing left to validate
        }
        if (!childStat.isDirectory()) {
          throw new FatalConfigError(
            `audit: the fallback landing ${dir} contains a symlink ` +
              `(${entry.name}) — artifacts written under it would land ` +
              `outside the landing. Remove it and re-run.`,
          );
        }
        continue;
      }
      if (!stat.isFile()) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a special file ` +
            `(${entry.name}) — a write to it would block or be captured by ` +
            `whoever holds the other end. Remove it and re-run.`,
        );
      }
      // A hardlink twin proves another name for the same inode exists
      // somewhere this check can never see.
      if (stat.nlink > 1) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} contains a hardlinked file ` +
            `(${entry.name}) — a write to it would also write through its ` +
            `twin. Remove it and re-run.`,
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
  private static assertAuditLandingIsOutsideRepo(
    dir: string,
    resolvedProjectRoot: string,
    finalCheck = false,
  ): void {
    let contained = false;
    try {
      contained = Storage.isPathWithinDirectory(dir, resolvedProjectRoot);
    } catch (err) {
      if (finalCheck) {
        throw new FatalConfigError(
          `audit: the fallback landing ${dir} could not be validated as ` +
            `outside the audited project root (${(err as Error).message}) — ` +
            `remove it and re-run.`,
        );
      }
      // Unresolvable: the adoption checks own this state (see above).
    }
    if (contained) {
      throw new FatalConfigError(
        `audit: the fallback landing ${dir} resolves inside the audited ` +
          `project root — point QWEN_HOME outside the repository and re-run.`,
      );
    }
  }

  getQwenDir(): string {
    return path.join(this.targetDir, QWEN_DIR);
  }

  getRuntimeBaseDir(): string {
    return this.runtimeBaseDir;
  }

  getProjectDir(): string {
    const projectId = sanitizeCwd(this.getProjectRoot());
    const projectsDir = path.join(this.runtimeBaseDir, PROJECT_DIR_NAME);
    return path.join(projectsDir, projectId);
  }

  getProjectTempDir(): string {
    const hash = getProjectHash(this.getProjectRoot());
    const tempDir = path.join(this.runtimeBaseDir, TMP_DIR_NAME);
    const targetDir = path.join(tempDir, hash);
    return targetDir;
  }

  getToolResultsDir(): string {
    return path.join(this.getProjectTempDir(), 'tool-results');
  }

  ensureProjectTempDirExists(): void {
    fs.mkdirSync(this.getProjectTempDir(), { recursive: true });
  }

  /**
   * Staleness threshold applied to every sweep gate: the newest-file
   * freshness check, the orphan marker's grace window, and the
   * empty-directory age check.
   *
   * Freshness protects running sessions, including sidecar-less ones
   * (headless, ACP, SDK, `qwen serve` — only the interactive TUI writes
   * runtime sidecars): a live session keeps appending, so the newest
   * file mtime inside its entry stays fresh.
   *
   * The marker gives transiently absent working directories (ejected
   * removable media, network mounts not up at boot) a grace window
   * measured from when their absence was FIRST observed — an entry's
   * own mtime cannot serve here because appends inside `chats/` never
   * advance it.
   */
  private static readonly ORPHAN_STALE_AGE_MS = 24 * 60 * 60 * 1000;

  /**
   * Marker file recording when an entry's non-temp cwds were first seen
   * gone. Its mtime is the grace anchor; a resume claim renews the grace
   * episode before reading the transcript.
   */
  private static readonly ORPHAN_MARKER_FILE = '.qwen-orphan-since';

  /** Refreshes an orphan marker before reading a marked project entry. */
  async runWithProjectDirReadClaim<T>(operation: () => Promise<T>): Promise<T> {
    const entryPath = this.getProjectDir();
    const markerPath = path.join(entryPath, Storage.ORPHAN_MARKER_FILE);
    let marked: boolean;
    try {
      marked =
        fs.statSync(entryPath).isDirectory() && fs.existsSync(markerPath);
    } catch {
      return operation();
    }
    if (!marked) {
      return operation();
    }
    try {
      if (fs.statSync(entryPath).isDirectory() && fs.existsSync(markerPath)) {
        const now = new Date();
        fs.utimesSync(markerPath, now, now);
      }
    } catch {
      // Renewal is best-effort: a failed utimes (ENOENT when the sweep
      // races us, EROFS/EACCES on a degraded mount, EIO/ENOSPC) must not
      // abort the read — the same filesystem error would block the
      // sweep's rmSync equally, so the claim-less read is safe.
    }
    return operation();
  }

  /**
   * Per-transcript scan budget. Oversized files mark the evidence
   * incomplete, which vetoes deletion (keep-only).
   */
  private static readonly CWD_SCAN_MAX_FILE_BYTES = 8 * 1024 * 1024;

  /**
   * Removes orphaned project snapshot directories under
   * `<runtime>/projects/` (issue #7906). Record-bearing entries are
   * deletion candidates only when every recorded cwd is a trusted OS temp
   * path that no longer exists. Non-temp paths, existing temp paths,
   * foreign path namespaces, live runtime sidecars, recent file activity,
   * `currentProjectId`, and incomplete evidence all fail closed.
   *
   * Candidates are marked first and removed only after the marker grace
   * window. Entries without any readable records are only removed when
   * completely empty (marker aside) and older than one day.
   *
   * `onBeforeRemove` runs before each deletion so callers can salvage
   * derived state (e.g. usage summaries) from the transcripts; its
   * failures never block removal. Per-entry failures are collected in
   * `errors`, removed entry names in `removed`.
   */
  static async cleanOrphanProjectDirs(
    currentProjectId: string,
    onBeforeRemove?: (entryPath: string) => Promise<void>,
  ): Promise<{
    removed: string[];
    errors: Array<{ entry: string; error: unknown }>;
  }> {
    const result = {
      removed: [] as string[],
      errors: [] as Array<{ entry: string; error: unknown }>,
    };
    const projectsDir = path.join(
      Storage.getRuntimeBaseDir(),
      PROJECT_DIR_NAME,
    );
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir);
    } catch {
      return result;
    }
    const now = Date.now();
    for (const entry of entries) {
      // Yield between entries: scanning a stale candidate streams its
      // transcripts synchronously and must not hog the freshly started
      // session's event loop.
      await new Promise((resolve) => setImmediate(resolve));
      const entryPath = path.join(projectsDir, entry);
      if (entry === currentProjectId) {
        // The active session's own entry: also clear any marker an
        // earlier absence episode left behind, so a later disappearance
        // gets a full grace window again.
        Storage.removeOrphanMarker(entryPath);
        continue;
      }
      try {
        // A still-running session owns this entry even if its cwd was
        // deleted underneath it (worktree teardown mid-session); its
        // runtime sidecar carries a live pid.
        if (Storage.hasLiveSession(entryPath)) {
          Storage.removeOrphanMarker(entryPath);
          continue;
        }
        // Sidecars are best-effort liveness evidence. A running
        // sidecar-less session is protected by its ongoing appends instead.
        const newest = Storage.newestFileMtimeMs(entryPath);
        if (newest > 0 && now - newest <= Storage.ORPHAN_STALE_AGE_MS) {
          Storage.removeOrphanMarker(entryPath);
          continue;
        }
        const { cwds, incomplete, keepOnly } =
          Storage.collectRecordedCwds(entryPath);
        if (keepOnly || cwds.some((cwd) => !Storage.isRemovableTempCwd(cwd))) {
          Storage.removeOrphanMarker(entryPath);
          continue;
        }
        if (incomplete) {
          continue;
        }
        if (cwds.length > 0) {
          // Only disappeared temp-root sessions are in scope for #7906.
          // Non-temp paths may be absent because of another host, OS path
          // namespace, or temporarily unavailable mount, so they fail closed.
          if (Storage.orphanMarkerExpired(entryPath, now)) {
            await Storage.removeEntry(
              entryPath,
              entry,
              onBeforeRemove,
              result,
              cwds,
            );
          } else {
            Storage.ensureOrphanMarker(entryPath);
          }
          continue;
        }
        // No readable records: only remove if the entry is completely
        // empty (marker aside) and stale, so a concurrently starting
        // session is never hit mid-write.
        const stat = fs.statSync(entryPath);
        if (
          stat.isDirectory() &&
          now - stat.mtimeMs > Storage.ORPHAN_STALE_AGE_MS &&
          Storage.countFiles(entryPath) === 0
        ) {
          await Storage.removeEntry(entryPath, entry, onBeforeRemove, result);
        }
      } catch (error) {
        result.errors.push({ entry, error });
      }
    }
    return result;
  }

  private static async removeEntry(
    entryPath: string,
    entry: string,
    onBeforeRemove: ((entryPath: string) => Promise<void>) | undefined,
    result: {
      removed: string[];
      errors: Array<{ entry: string; error: unknown }>;
    },
    cwds?: string[],
  ): Promise<void> {
    // Final liveness gate, ahead of salvage: the entry gate distrusts a
    // sidecar older than the staleness window (pid-recycle risk), but
    // an idle session writes nothing — sidecar and appends age together
    // — so a live-but-idle session can reach this point. Re-check
    // without that window: a recycled pid only fails keep-only, like
    // every other gate. Salvaging first would double-count a session
    // still accruing usage.
    if (Storage.hasLiveSession(entryPath, false)) {
      Storage.removeOrphanMarker(entryPath);
      return;
    }
    if (onBeforeRemove) {
      try {
        await onBeforeRemove(entryPath);
      } catch {
        // Salvage failures must never block removal.
      }
    }
    // The salvage await widens the check-then-delete window. Re-run every
    // cheap gate before rmSync.
    if (cwds) {
      const markerPath = path.join(entryPath, Storage.ORPHAN_MARKER_FILE);
      if (!fs.existsSync(markerPath)) {
        return;
      }
      if (
        Date.now() - fs.statSync(markerPath).mtimeMs <=
        Storage.ORPHAN_STALE_AGE_MS
      ) {
        return;
      }
      if (cwds.some((cwd) => !Storage.isRemovableTempCwd(cwd))) {
        Storage.removeOrphanMarker(entryPath);
        return;
      }
    }
    if (Storage.hasLiveSession(entryPath, false)) {
      return;
    }
    const newest = Storage.newestFileMtimeMs(entryPath);
    if (newest > 0 && Date.now() - newest <= Storage.ORPHAN_STALE_AGE_MS) {
      Storage.removeOrphanMarker(entryPath);
      return;
    }
    fs.rmSync(entryPath, { recursive: true, force: true });
    result.removed.push(entry);
  }

  /** Newest mtime among the entry's files (depth ≤ 2); 0 when none. */
  private static newestFileMtimeMs(dirPath: string, depth = 0): number {
    if (depth > 2) return 0;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    let newest = 0;
    for (const dirent of dirents) {
      // The marker is sweep bookkeeping, not session activity — it must
      // not keep the entry fresh.
      if (depth === 0 && dirent.name === Storage.ORPHAN_MARKER_FILE) continue;
      const child = path.join(dirPath, dirent.name);
      try {
        newest = Math.max(
          newest,
          dirent.isDirectory()
            ? Storage.newestFileMtimeMs(child, depth + 1)
            : fs.statSync(child).mtimeMs,
        );
      } catch {
        // Entry vanished mid-sweep.
      }
    }
    return newest;
  }

  /** True once a previously written marker has aged past the grace. */
  private static orphanMarkerExpired(entryPath: string, now: number) {
    try {
      return (
        now -
          fs.statSync(path.join(entryPath, Storage.ORPHAN_MARKER_FILE))
            .mtimeMs >
        Storage.ORPHAN_STALE_AGE_MS
      );
    } catch {
      return false;
    }
  }

  /** Writes the disappearance marker once; rewrites would reset the grace. */
  private static ensureOrphanMarker(entryPath: string): void {
    const markerPath = path.join(entryPath, Storage.ORPHAN_MARKER_FILE);
    try {
      fs.statSync(markerPath);
    } catch {
      try {
        fs.writeFileSync(markerPath, String(Date.now()));
      } catch {
        // Best effort: the next sweep retries.
      }
    }
  }

  private static removeOrphanMarker(entryPath: string): void {
    try {
      fs.rmSync(path.join(entryPath, Storage.ORPHAN_MARKER_FILE), {
        force: true,
      });
    } catch {
      // Nothing to clear.
    }
  }

  /**
   * Collects every working directory recorded in an entry's artifacts.
   * Chat logs contribute the cwd of every record they hold (`/cd` hops
   * leave earlier cwds on earlier lines and move the file); runtime
   * sidecars contribute `work_dir`; worktree sidecars contribute
   * `worktreePath` (a sidecar-only entry — a worktree session killed
   * before its first record — must reach the marker flow, not the
   * empty-entry branch it can never satisfy); subagent transcripts
   * contribute the cwd they were launched from, so an entry reduced to
   * subagent residue (`/cd` moves only the session files) keeps its
   * veto protection for a live project. Subdirectories
   * (`chats/archive/`) are scanned too. Scanning stops once a cwd is
   * found that still exists outside temp roots: such a cwd vetoes
   * removal for every caller, and transcripts can be large.
   *
   * `incomplete` reports a scan whose evidence may be partial — an
   * artifact that failed to parse, failed to read, or exceeded the
   * per-file byte budget. Callers must treat incomplete evidence as
   * vetoing deletion.
   */
  static collectRecordedCwds(entryPath: string): {
    cwds: string[];
    incomplete: boolean;
    keepOnly: boolean;
  } {
    const cwds = new Set<string>();
    const state = { incomplete: false, keepOnly: false };
    Storage.scanDirForCwds(path.join(entryPath, 'chats'), cwds, 0, state);
    Storage.scanDirForCwds(path.join(entryPath, 'subagents'), cwds, 0, state);
    return {
      cwds: [...cwds],
      incomplete: state.incomplete,
      keepOnly: state.keepOnly,
    };
  }

  /**
   * Deletion is authorized only for the issue #7906 shape: a recorded cwd
   * that was under a trusted OS temp root and no longer exists.
   */
  private static isRemovableTempCwd(cwd: string): boolean {
    return (
      !Storage.isUnevaluableCwd(cwd) &&
      isTempDirPath(cwd) &&
      !fs.existsSync(cwd)
    );
  }

  private static isUnevaluableCwd(cwd: string): boolean {
    if (/^[A-Za-z]:[\\/]/.test(cwd)) {
      return process.platform !== 'win32';
    }
    return process.platform === 'win32' && /^\/[A-Za-z](?:\/|$)/.test(cwd);
  }

  private static scanDirForCwds(
    dir: string,
    cwds: Set<string>,
    depth: number,
    state: { incomplete: boolean; keepOnly: boolean },
  ): boolean {
    if (depth > 2) return false;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Absent directory = no evidence; an existing-but-unreadable one
      // means the evidence set may be partial.
      if (fs.existsSync(dir)) state.incomplete = true;
      return false;
    }
    for (const dirent of dirents) {
      const entryPath = path.join(dir, dirent.name);
      let vetoed = false;
      if (dirent.name.endsWith('.jsonl')) {
        vetoed = Storage.scanFileForCwds(entryPath, cwds, state);
      } else if (dirent.name.endsWith('.runtime.json')) {
        const hostname = Storage.readJsonStringField(
          entryPath,
          'hostname',
          state,
        );
        if (hostname && hostname !== os.hostname()) {
          state.keepOnly = true;
          vetoed = true;
        }
        const cwd = Storage.readJsonStringField(entryPath, 'work_dir', state);
        if (cwd) {
          cwds.add(cwd);
          vetoed ||= !Storage.isRemovableTempCwd(cwd);
        }
      } else if (dirent.name.endsWith('.worktree.json')) {
        // `worktreePath`, not `originalCwd`: the repo root stays alive
        // after the worktree is removed and would veto cleanup forever.
        const cwd = Storage.readJsonStringField(
          entryPath,
          'worktreePath',
          state,
        );
        if (cwd) {
          cwds.add(cwd);
          vetoed = !Storage.isRemovableTempCwd(cwd);
        }
      } else if (
        dirent.isDirectory() ||
        Storage.isDirectoryLike(entryPath, state)
      ) {
        vetoed = Storage.scanDirForCwds(entryPath, cwds, depth + 1, state);
      }
      if (vetoed) return true;
    }
    return false;
  }

  private static isDirectoryLike(
    entryPath: string,
    state: { incomplete: boolean },
  ): boolean {
    try {
      return fs.statSync(entryPath).isDirectory();
    } catch {
      state.incomplete = true;
      return false;
    }
  }

  /** Reads a bounded transcript and records every line's cwd. */
  private static scanFileForCwds(
    filePath: string,
    cwds: Set<string>,
    state: { incomplete: boolean; keepOnly: boolean },
  ): boolean {
    try {
      if (fs.statSync(filePath).size > Storage.CWD_SCAN_MAX_FILE_BYTES) {
        state.incomplete = true;
        return false;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      if (text !== '' && !text.endsWith('\n')) {
        state.incomplete = true;
        return false;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        const cwd = record['cwd'];
        if (typeof cwd === 'string' && cwd) {
          cwds.add(cwd);
          if (!Storage.isRemovableTempCwd(cwd)) return true;
        }
      }
      return false;
    } catch {
      state.incomplete = true;
      return false;
    }
  }

  private static readJsonStringField(
    filePath: string,
    field: string,
    state: { incomplete: boolean; keepOnly: boolean },
  ): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >;
      const value = parsed[field];
      return typeof value === 'string' && value ? value : null;
    } catch {
      // A torn or unreadable sidecar (rewritten in place on runtime
      // status updates) loses its cwd evidence — fail closed, like an
      // unreadable transcript.
      state.incomplete = true;
      return null;
    }
  }

  /**
   * True when the entry holds a runtime sidecar whose pid is still alive
   * — i.e. a session is running from this entry right now. With
   * `distrustStaleSidecars` off, a sidecar's pid is trusted regardless
   * of its age: the sweep deletion gate uses that mode, where a false
   * "live" can only leak the entry, never delete a live session's records.
   */
  static hasLiveSession(
    entryPath: string,
    distrustStaleSidecars = true,
  ): boolean {
    return hasActiveRuntimeStatusClaimSync(
      path.join(entryPath, 'chats'),
      distrustStaleSidecars ? Storage.ORPHAN_STALE_AGE_MS : undefined,
    );
  }

  /** Every `*.jsonl` transcript under `<projectDir>/chats` (depth ≤ 2). */
  static listTranscriptPaths(projectDir: string): string[] {
    const out: string[] = [];
    Storage.collectTranscriptPaths(path.join(projectDir, 'chats'), out, 0);
    return out;
  }

  private static collectTranscriptPaths(
    dir: string,
    out: string[],
    depth: number,
  ): void {
    if (depth > 2) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        Storage.collectTranscriptPaths(child, out, depth + 1);
      } else if (dirent.name.endsWith('.jsonl')) {
        out.push(child);
      }
    }
  }

  /**
   * Counts content that must keep an entry alive. The orphan marker is
   * sweep bookkeeping, not session content. Everything else — including
   * qwen-owned residue such as workflow snapshots and journals — is
   * content: residue carries no cwd the source project could be
   * recognized by, so it cannot prove its own project is gone, and
   * deleting it on absence of evidence would risk `/workflows` history
   * of a live project (fail closed).
   */
  private static countFiles(dirPath: string, depth = 0): number {
    let count = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (depth === 0 && entry.name === Storage.ORPHAN_MARKER_FILE) {
        continue;
      }
      const child = path.join(dirPath, entry.name);
      count += entry.isDirectory() ? Storage.countFiles(child, depth + 1) : 1;
    }
    return count;
  }

  static getOAuthCredsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), OAUTH_FILE);
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getWorkspaceSettingsPath(): string {
    return path.join(this.getQwenDir(), 'settings.json');
  }

  getProjectCommandsDir(): string {
    return path.join(this.getQwenDir(), 'commands');
  }

  /**
   * Project-level saved-workflow scripts directory: `<targetDir>/.qwen/workflows`.
   * Saved workflow scripts (`<name>.js`) here are surfaced as slash commands
   * and resolvable by `workflow('<name>')` from inside a running workflow.
   */
  getProjectWorkflowsDir(): string {
    return path.join(this.getQwenDir(), 'workflows');
  }

  /**
   * User-level saved-workflow scripts directory: `~/.qwen/workflows`. User
   * scope is lower-precedence than project scope when the same `<name>.js`
   * exists in both.
   */
  static getUserWorkflowsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'workflows');
  }

  /**
   * Per-run workflow artifact directory: `<projectDir>/workflows`. Holds
   * completed-run snapshot JSON files (`<runId>.json`) for the `/workflows`
   * recent list, and per-run resume journals (`<runId>/journal.jsonl`).
   */
  getWorkflowRunsDir(): string {
    return path.join(this.getProjectDir(), 'workflows');
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
  getGeneratedWorkflowsDir(): string {
    return path.join(this.getWorkflowRunsDir(), 'generated');
  }

  /**
   * Path to the persisted snapshot of a completed workflow run.
   */
  getWorkflowRunSnapshotPath(runId: string): string {
    return path.join(this.getWorkflowRunsDir(), `${runId}.json`);
  }

  /**
   * Path to the resume journal for an in-progress / resumable workflow run.
   */
  getWorkflowRunJournalPath(runId: string): string {
    return path.join(this.getWorkflowRunsDir(), runId, 'journal.jsonl');
  }

  /**
   * Path to this process's runtime-status sidecar JSON for this session.
   *
   * Co-located with the per-session chat log under
   * `<projectDir>/chats/<sessionId>.<pid>.runtime.json` so external observers
   * (terminal multiplexers, IDE integrations, status daemons) can scan
   * the same directory used for chat history to find live sessions.
   */
  getRuntimeStatusPath(sessionId: string): string {
    return this.getRuntimeStatusPathForPid(sessionId, process.pid);
  }

  getRuntimeStatusPathForPid(sessionId: string, pid: number): string {
    return path.join(
      this.getProjectDir(),
      'chats',
      `${sessionId}.${pid}.runtime.json`,
    );
  }

  getProjectTempCheckpointsDir(): string {
    return path.join(this.getProjectTempDir(), 'checkpoints');
  }

  getExtensionsDir(): string {
    return path.join(this.getQwenDir(), 'extensions');
  }

  getExtensionsConfigPath(): string {
    return path.join(this.getExtensionsDir(), 'qwen-extension.json');
  }

  getUserSkillsDirs(): string[] {
    const homeDir = os.homedir() || os.tmpdir();
    return SKILL_PROVIDER_CONFIG_DIRS.map((dir) =>
      dir === QWEN_DIR
        ? path.join(Storage.getGlobalQwenDir(), 'skills')
        : path.join(homeDir, dir, 'skills'),
    );
  }

  /**
   * Returns the user-level extensions directory (~/.qwen/extensions/).
   * Extensions installed at user scope are stored here, as opposed to
   * project-level extensions which live in <project>/.qwen/extensions/.
   */
  static getUserExtensionsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'extensions');
  }

  getHistoryFilePath(): string {
    return path.join(this.getProjectTempDir(), 'shell_history');
  }
}
