/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getProjectHash,
  QWEN_DIR,
  sanitizeCwd,
  isTempDirPath,
} from '../utils/paths.js';
import { FatalConfigError } from '../utils/errors.js';

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

function isResolvedPathWithinDirectory(childPath: string, parentPath: string) {
  const relativePath = path.relative(parentPath, childPath);
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
   * gone. Written once (its mtime is the grace anchor — never rewrite),
   * deleted only together with the entry itself.
   */
  private static readonly ORPHAN_MARKER_FILE = '.qwen-orphan-since';

  /**
   * Removes orphaned project snapshot directories under
   * `<runtime>/projects/` (issue #7906). An entry is orphaned when none
   * of the working directories recorded in its artifacts (chat logs,
   * runtime sidecars, archived transcripts) still exists outside OS
   * temp roots. Entries owned by a still-running session (runtime
   * sidecar with a live pid) are never touched, as are entries with
   * recent file activity — sidecar-less sessions (headless, ACP, SDK,
   * `qwen serve`) stay protected that way — and `currentProjectId`.
   * Every other record-bearing entry is marked first and only removed
   * once the marker has aged past the grace window, so a transiently
   * absent mount gets its chance to come back and a live-but-idle
   * temp-rooted session is never removed on a single sweep. Entries
   * without any readable records are only removed when completely empty
   * and older than one day.
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
        // Sidecars only exist for interactive sessions: a running
        // sidecar-less session (headless/ACP/SDK/serve) is protected by
        // its ongoing appends instead.
        const newest = Storage.newestFileMtimeMs(entryPath);
        if (newest > 0 && now - newest <= Storage.ORPHAN_STALE_AGE_MS) {
          Storage.removeOrphanMarker(entryPath);
          continue;
        }
        const cwds = Storage.collectRecordedCwds(entryPath);
        if (cwds.length > 0) {
          // `/cd` relocation keeps the old cwd on line 1 and moves the
          // file, so a single sampled cwd is not conclusive: a single
          // existing non-temp cwd vetoes removal.
          if (cwds.some((cwd) => fs.existsSync(cwd) && !isTempDirPath(cwd))) {
            Storage.removeOrphanMarker(entryPath);
            continue;
          }
          // No live non-temp cwd — a crashed temp session, a deleted
          // worktree, or a real project transiently absent (ejected
          // media, mount down). One sweep must not decide any of these:
          // mark first, remove only once the marker itself is older
          // than the grace window. An immediate remove here would also
          // hit live-but-idle (>24 h) temp-rooted sessions, whose
          // sidecar aged past trust and whose appends stopped.
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
        // empty and stale, so a concurrently starting session is never
        // hit mid-write.
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
    if (onBeforeRemove) {
      try {
        await onBeforeRemove(entryPath);
      } catch {
        // Salvage failures must never block removal.
      }
    }
    // The salvage await reads every transcript of the doomed entry,
    // widening the check-then-delete window: a cwd may reappear (media
    // plugged back in) and a new session may start writing into this
    // very entry during that time. Re-run the cheap gates before the
    // irreversible step and bail out if the entry is protected again.
    if (cwds?.some((cwd) => fs.existsSync(cwd) && !isTempDirPath(cwd))) {
      Storage.removeOrphanMarker(entryPath);
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
   * sidecars contribute `work_dir`. Subdirectories (`chats/archive/`)
   * are scanned too. Scanning stops once a cwd is found that still
   * exists outside temp roots: such a cwd vetoes removal for every
   * caller, and transcripts can be large.
   */
  static collectRecordedCwds(entryPath: string): string[] {
    const cwds = new Set<string>();
    Storage.scanDirForCwds(path.join(entryPath, 'chats'), cwds, 0);
    return [...cwds];
  }

  /**
   * A cwd that still exists outside temp roots vetoes removal on every
   * caller's predicate, so it can end the scan early.
   */
  private static isVetoCwd(cwd: string): boolean {
    return fs.existsSync(cwd) && !isTempDirPath(cwd);
  }

  private static scanDirForCwds(
    dir: string,
    cwds: Set<string>,
    depth: number,
  ): boolean {
    if (depth > 2) return false;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const dirent of dirents) {
      const entryPath = path.join(dir, dirent.name);
      let vetoed = false;
      if (dirent.isDirectory()) {
        vetoed = Storage.scanDirForCwds(entryPath, cwds, depth + 1);
      } else if (dirent.name.endsWith('.jsonl')) {
        vetoed = Storage.scanFileForCwds(entryPath, cwds);
      } else if (dirent.name.endsWith('.runtime.json')) {
        const cwd = Storage.readJsonStringField(entryPath, 'work_dir');
        if (cwd) {
          cwds.add(cwd);
          vetoed = Storage.isVetoCwd(cwd);
        }
      }
      if (vetoed) return true;
    }
    return false;
  }

  /** Streams a transcript and records every line's cwd. */
  private static scanFileForCwds(filePath: string, cwds: Set<string>): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const decoder = new StringDecoder('utf8');
      const buf = Buffer.alloc(64 * 1024);
      let leftover = '';
      for (;;) {
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
        const text = leftover + decoder.write(buf.subarray(0, bytesRead));
        if (bytesRead === 0) {
          if (leftover && Storage.extractLineCwds(leftover, cwds)) {
            return true;
          }
          return false;
        }
        const lines = text.split('\n');
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (line && Storage.extractLineCwds(line, cwds)) return true;
        }
      }
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore.
        }
      }
    }
  }

  /**
   * Records every `cwd` value on the line without parsing the record's
   * (potentially huge) message payload. Records serialize `cwd` near
   * the start, and a pattern scan also recovers cwds from oversized,
   * `}{`-glued, or torn records. A false match inside message content
   * only adds an extra cwd, which errs on the keep side.
   */
  private static extractLineCwds(line: string, cwds: Set<string>): boolean {
    let pos = 0;
    for (;;) {
      const at = line.indexOf('"cwd"', pos);
      if (at === -1) return false;
      pos = at + '"cwd"'.length;
      let i = pos;
      while (i < line.length && line[i] === ' ') i++;
      if (line[i] !== ':') continue;
      i++;
      while (i < line.length && line[i] === ' ') i++;
      if (line[i] !== '"') continue;
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2;
          continue;
        }
        if (line[end] === '"') break;
        end++;
      }
      if (end >= line.length) return false;
      try {
        const value = JSON.parse(line.slice(i, end + 1)) as string;
        if (value) {
          cwds.add(value);
          if (Storage.isVetoCwd(value)) return true;
        }
      } catch {
        // Malformed escape sequence — not a real cwd value.
      }
    }
  }

  private static readJsonStringField(
    filePath: string,
    field: string,
  ): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >;
      const value = parsed[field];
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * True when the entry holds a runtime sidecar whose pid is still alive
   * — i.e. a session is running from this entry right now.
   */
  private static hasLiveSession(entryPath: string): boolean {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(entryPath, 'chats'), {
        withFileTypes: true,
      });
    } catch {
      return false;
    }
    for (const dirent of dirents) {
      if (!dirent.name.endsWith('.runtime.json')) continue;
      const sidecarPath = path.join(entryPath, 'chats', dirent.name);
      try {
        // Once the kernel has had a full grace window to recycle the
        // pid, a matching pid is more likely an unrelated reused one
        // than the original session — stop trusting it.
        if (
          Date.now() - fs.statSync(sidecarPath).mtimeMs >
          Storage.ORPHAN_STALE_AGE_MS
        ) {
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as {
          pid?: unknown;
        };
        if (
          typeof parsed.pid === 'number' &&
          Number.isInteger(parsed.pid) &&
          Storage.isPidAlive(parsed.pid)
        ) {
          return true;
        }
      } catch {
        // Unreadable sidecar — not proof of liveness.
      }
    }
    return false;
  }

  private static isPidAlive(pid: number): boolean {
    // Corrupted sidecars can carry 0/-1, and on POSIX kill(0,0) targets
    // the caller's own process group — never treat those as live.
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH/EPERM both mean "not our session": either the pid is gone,
      // or it belongs to another uid — in this per-user runtime tree
      // that cannot be the session that wrote the sidecar.
      return false;
    }
  }

  /**
   * True when the entry contains nothing but this session's own
   * artifacts. Entries are keyed by sanitized cwd, which collisions and
   * concurrent sessions can share, so whole-entry deletion at shutdown
   * must be gated on exclusive ownership. Any subdirectory (including
   * `chats/archive/`) is treated as foreign by design: the shutdown
   * path is the fast path, and such entries simply fall back to the
   * grace-gated startup sweep.
   */
  static containsOnlySessionArtifacts(
    projectDir: string,
    sessionId: string,
  ): boolean {
    let topEntries: fs.Dirent[];
    try {
      topEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      // Nothing on disk — nothing foreign either.
      return true;
    }
    for (const entry of topEntries) {
      if (entry.name !== 'chats' || !entry.isDirectory()) return false;
    }
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projectDir, 'chats'));
    } catch {
      return true;
    }
    return files.every((file) => file.startsWith(`${sessionId}.`));
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

  private static countFiles(dirPath: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const child = path.join(dirPath, entry.name);
      count += entry.isDirectory() ? Storage.countFiles(child) : 1;
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
   * Path to the runtime-status sidecar JSON for this session.
   *
   * Co-located with the per-session chat log under
   * `<projectDir>/chats/<sessionId>.runtime.json` so external observers
   * (terminal multiplexers, IDE integrations, status daemons) can scan
   * the same directory used for chat history to find live sessions.
   */
  getRuntimeStatusPath(sessionId: string): string {
    return path.join(
      this.getProjectDir(),
      'chats',
      `${sessionId}.runtime.json`,
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
