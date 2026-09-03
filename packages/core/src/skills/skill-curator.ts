/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { QWEN_DIR } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import {
  getArchivedSkillsRoot,
  getProjectSkillsRoot,
  SKILL_FILE_NAME,
} from './skill-paths.js';
import type { SkillConfig } from './types.js';
import { SKILL_NAME_PATTERN, validateSkillName } from './types.js';

export const AUTO_SKILL_CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTO_SKILL_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTO_SKILL_ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const debugLogger = createDebugLogger('SKILL_CURATOR');

const AUTO_SKILL_PREFIX = 'auto-skill-';
const CURATOR_STATE_VERSION = 1;
const CURATOR_STATE_FILE = 'skill-curator.json';
const CURATOR_LOCK_FILE = 'skill-curator.lock';
// A real state file is a few KB even with hundreds of skills. Cap the read so
// a crafted oversized regular file cannot drive an unbounded JSON parse.
const MAX_STATE_FILE_BYTES = 1024 * 1024;
// A managed SKILL.md is a small frontmatter + body. Cap the read so a crafted
// or symlinked manifest (e.g. a git-mode-120000 link to /dev/zero) cannot drive
// an unbounded read; the ceiling is well above any real manifest.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

// O_NOFOLLOW refuses a symlink atomically at open (ELOOP) — closing the
// lstat→read TOCTOU window a bare readFile leaves open — and O_NONBLOCK keeps a
// FIFO from hanging the open (the fstat guard then rejects it as non-regular).
// Both constants are omitted on platforms that lack them (Windows), where they
// reduce to plain O_RDONLY. Resolved lazily rather than at module load so the
// node:fs constants are not touched at import time — tests that mock node:fs
// without a `constants` export install a proxy that throws on access.
function noFollowReadFlags(): number {
  return (
    (fsConstants.O_RDONLY ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0)
  );
}

/**
 * Read an entire regular file with O_NOFOLLOW and a size bound taken from an
 * fstat on the open descriptor. Unlike an `lstat` guard followed by a separate
 * `readFile`, this cannot be raced: a symlink swapped in after any earlier stat
 * is refused atomically at open, and the size is re-checked on the same fd that
 * is read, so a target such as /dev/zero cannot drive an unbounded read.
 */
async function readRegularFileNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; stat: import('node:fs').Stats }> {
  const handle = await fs.open(filePath, noFollowReadFlags());
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        `Auto-skill curator refuses unsafe path ${filePath} (not a regular file).`,
      );
    }
    if (stat.size > maxBytes) {
      throw new Error(`Auto-skill curator file too large at ${filePath}.`);
    }
    const content = await handle.readFile('utf8');
    return { content, stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

type AutoSkillState = 'active' | 'stale' | 'archived';

interface AutoSkillRecord {
  skillName: string;
  firstSeenAt: string;
  lastActivityAt: string;
  lastUsedAt?: string;
  useCount: number;
  state: AutoSkillState;
  pinned: boolean;
  archivedAt?: string;
}

interface AutoSkillCuratorState {
  version: 1;
  lastRunAt?: string;
  skills: Record<string, AutoSkillRecord>;
}

interface ManagedAutoSkill {
  directoryName: string;
  skillName: string;
  directoryPath: string;
  manifestPath: string;
  modifiedAt: string;
}

export interface AutoSkillCuratorEntry {
  directoryName: string;
  skillName: string;
  state: AutoSkillState;
  lastActivityAt: string;
  useCount: number;
  pinned: boolean;
}

export interface AutoSkillCuratorStatus {
  lastRunAt?: string;
  active: AutoSkillCuratorEntry[];
  stale: AutoSkillCuratorEntry[];
  archived: AutoSkillCuratorEntry[];
}

export interface AutoSkillCuratorRunResult {
  dryRun: boolean;
  checked: number;
  seeded: string[];
  markedStale: string[];
  reactivated: string[];
  archived: string[];
  skippedCollisions: string[];
  skippedErrors: string[];
}

export type AutoSkillCuratorAutomaticResult =
  | { status: 'seeded'; checked: number }
  | { status: 'not_due' }
  | { status: 'ran'; result: AutoSkillCuratorRunResult };

interface CuratorPaths {
  qwenRoot: string;
  skillsRoot: string;
  archiveRoot: string;
  statePath: string;
  lockPath: string;
}

const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 8,
    minTimeout: 25,
    maxTimeout: 500,
    factor: 2,
    randomize: true,
  },
  stale: 10_000,
  onCompromised: (err) => {
    debugLogger.warn('skill curator lock compromised:', err);
  },
};

function getCuratorPaths(projectRoot: string): CuratorPaths {
  const qwenRoot = path.join(projectRoot, QWEN_DIR);
  return {
    qwenRoot,
    skillsRoot: getProjectSkillsRoot(projectRoot),
    archiveRoot: getArchivedSkillsRoot(projectRoot),
    statePath: path.join(qwenRoot, CURATOR_STATE_FILE),
    lockPath: path.join(qwenRoot, CURATOR_LOCK_FILE),
  };
}

function emptyState(): AutoSkillCuratorState {
  return { version: CURATOR_STATE_VERSION, skills: Object.create(null) };
}

function isMissing(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireTimestamp(value: unknown, field: string): string {
  if (parseTimestamp(value) === undefined) {
    throw new Error(`Invalid auto-skill curator state: ${field} is invalid.`);
  }
  return value as string;
}

function parseState(raw: unknown, statePath: string): AutoSkillCuratorState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }
  const input = raw as Record<string, unknown>;
  if (input['version'] !== CURATOR_STATE_VERSION) {
    throw new Error(
      `Unsupported auto-skill curator state version at ${statePath}.`,
    );
  }
  const rawSkills = input['skills'];
  if (!rawSkills || typeof rawSkills !== 'object' || Array.isArray(rawSkills)) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }

  const skills = Object.create(null) as Record<string, AutoSkillRecord>;
  for (const [directoryName, value] of Object.entries(rawSkills)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`,
      );
    }
    const record = value as Record<string, unknown>;
    const state = record['state'];
    if (state !== 'active' && state !== 'stale' && state !== 'archived') {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`,
      );
    }
    const skillName = record['skillName'];
    const useCount = record['useCount'];
    const pinned = record['pinned'];
    if (
      typeof skillName !== 'string' ||
      !Number.isInteger(useCount) ||
      (useCount as number) < 0 ||
      (pinned !== undefined && typeof pinned !== 'boolean')
    ) {
      throw new Error(
        `Invalid auto-skill curator record for ${directoryName}.`,
      );
    }
    skills[directoryName] = {
      skillName,
      firstSeenAt: requireTimestamp(
        record['firstSeenAt'],
        `${directoryName}.firstSeenAt`,
      ),
      lastActivityAt: requireTimestamp(
        record['lastActivityAt'],
        `${directoryName}.lastActivityAt`,
      ),
      useCount: useCount as number,
      state,
      pinned: pinned ?? false,
      ...(record['lastUsedAt'] !== undefined
        ? {
            lastUsedAt: requireTimestamp(
              record['lastUsedAt'],
              `${directoryName}.lastUsedAt`,
            ),
          }
        : {}),
      ...(record['archivedAt'] !== undefined
        ? {
            archivedAt: requireTimestamp(
              record['archivedAt'],
              `${directoryName}.archivedAt`,
            ),
          }
        : {}),
    };
  }

  return {
    version: CURATOR_STATE_VERSION,
    skills,
    ...(input['lastRunAt'] !== undefined
      ? { lastRunAt: requireTimestamp(input['lastRunAt'], 'lastRunAt') }
      : {}),
  };
}

async function readState(statePath: string): Promise<AutoSkillCuratorState> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(statePath);
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw error;
  }
  // Mirror the noFollow/lstat guards every write already uses: a state file
  // that is a symlink (committable via git mode 120000, e.g. pointing at
  // /dev/zero or a path outside .qwen/) or a FIFO would otherwise be followed,
  // driving an unbounded read (OOM) or blocking the CLI boot indefinitely.
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Auto-skill curator refuses unsafe path ${statePath}.`);
  }
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
  }
  let content: string;
  try {
    // Read with O_NOFOLLOW rather than a bare readFile: the lstat above only
    // proves the path was safe at that instant, so a symlink (or a growing
    // file) swapped in before the read would otherwise be followed. The
    // O_NOFOLLOW open refuses that atomically and the fstat re-bounds the size.
    ({ content } = await readRegularFileNoFollow(
      statePath,
      MAX_STATE_FILE_BYTES,
    ));
  } catch (error) {
    if (isMissing(error)) return emptyState();
    // The file passed the lstat guard, but the read can still fail because it
    // raced into a symlink / non-regular file, grew past the cap, or hit a
    // transient I/O error such as EMFILE, EACCES, or EIO. Fail closed either
    // way, while retaining the original failure for diagnosis.
    throw new Error(`Auto-skill curator refuses unsafe path ${statePath}.`, {
      cause: error,
    });
  }
  try {
    return parseState(JSON.parse(content), statePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid auto-skill curator state at ${statePath}.`);
    }
    throw error;
  }
}

function parseAutoSkillName(content: string): string | undefined {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    content,
  );
  if (!match) return undefined;
  const frontmatter = parseYaml(match[1]);
  if (frontmatter['source'] !== 'auto-skill') return undefined;
  const name = frontmatter['name'];
  if (typeof name !== 'string') return undefined;
  try {
    validateSkillName(name);
  } catch {
    return undefined;
  }
  return name;
}

function isManagedDirectoryName(directoryName: string): boolean {
  return (
    directoryName.startsWith(AUTO_SKILL_PREFIX) &&
    path.basename(directoryName) === directoryName &&
    // Restrict to the skill-name charset (letters, digits, _ : . -). A managed
    // directory is always `auto-skill-<name>` where `<name>` passes
    // validateSkillName and the prefix chars are within the same set, so this
    // never rejects a legitimately generated directory. It does reject names
    // carrying ANSI/control bytes, whose `directoryName` is later printed
    // verbatim by the non-interactive `/curator` output (which, unlike the TUI,
    // does not run escapeAnsiCtrlCodes) — closing a terminal control-sequence
    // injection via a crafted directory committed to a cloned repo.
    SKILL_NAME_PATTERN.test(directoryName)
  );
}

async function readManagedSkill(
  root: string,
  directoryName: string,
): Promise<ManagedAutoSkill | undefined> {
  if (!isManagedDirectoryName(directoryName)) return undefined;
  const directoryPath = path.join(root, directoryName);
  const manifestPath = path.join(directoryPath, SKILL_FILE_NAME);
  try {
    const directoryStat = await fs.lstat(directoryPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return undefined;
    }
    // Read the manifest with O_NOFOLLOW instead of the previous
    // `Promise.all([lstat, readFile])`, where the readFile ran concurrently
    // with the lstat guard: a symlinked SKILL.md (git mode 120000, survives a
    // clone) pointing at /dev/zero would begin an unbounded read before the
    // lstat could reject it. The O_NOFOLLOW open refuses the symlink atomically
    // and the fstat bounds the read, so a crafted manifest cannot OOM the scan.
    const { content, stat: manifestStat } = await readRegularFileNoFollow(
      manifestPath,
      MAX_MANIFEST_BYTES,
    );
    const skillName = parseAutoSkillName(content);
    if (!skillName) return undefined;
    return {
      directoryName,
      skillName,
      directoryPath,
      manifestPath,
      modifiedAt: manifestStat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function scanManagedSkills(root: string): Promise<ManagedAutoSkill[]> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Auto-skill curator refuses unsafe path ${root}.`);
    }
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const skills = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && isManagedDirectoryName(entry.name),
      )
      .map((entry) => readManagedSkill(root, entry.name)),
  );
  return skills
    .filter((skill): skill is ManagedAutoSkill => skill !== undefined)
    .sort((a, b) => a.directoryName.localeCompare(b.directoryName));
}

async function ensureSafeQwenRoot(paths: CuratorPaths): Promise<void> {
  await fs.mkdir(paths.qwenRoot, { recursive: true });
  const stat = await fs.lstat(paths.qwenRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Auto-skill curator refuses unsafe path ${paths.qwenRoot}.`,
    );
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Auto-skill curator refuses unsafe path ${directory}.`);
  }
}

async function withCuratorLock<T>(
  projectRoot: string,
  operation: (paths: CuratorPaths) => Promise<T>,
): Promise<T> {
  const paths = getCuratorPaths(projectRoot);
  await ensureSafeQwenRoot(paths);
  // proper-lockfile acquires `${lockPath}.lock` with an atomic mkdir. Do not
  // create or validate `lockPath` itself: it is not the lock and would leave a
  // permanent placeholder file behind after every curator operation.
  const release = await lockfile.lock(paths.lockPath, LOCK_OPTIONS);
  try {
    return await operation(paths);
  } finally {
    try {
      await release();
    } catch {
      // The state mutation already completed; stale-lock cleanup is non-fatal.
    }
  }
}

function recordForSkill(
  state: AutoSkillCuratorState,
  skill: ManagedAutoSkill,
  firstSeenAt: string = skill.modifiedAt,
): AutoSkillRecord {
  const existing = state.skills[skill.directoryName];
  if (existing) {
    existing.skillName = skill.skillName;
    return existing;
  }
  const record: AutoSkillRecord = {
    skillName: skill.skillName,
    firstSeenAt,
    lastActivityAt: firstSeenAt,
    useCount: 0,
    state: 'active',
    pinned: false,
  };
  state.skills[skill.directoryName] = record;
  return record;
}

function lastActivityMs(
  skill: ManagedAutoSkill,
  record: AutoSkillRecord,
  nowMs: number,
): number {
  const mtimeMs = parseTimestamp(skill.modifiedAt) ?? 0;
  return Math.max(
    mtimeMs <= nowMs ? mtimeMs : 0,
    parseTimestamp(record.firstSeenAt) ?? 0,
    parseTimestamp(record.lastActivityAt) ?? 0,
    parseTimestamp(record.lastUsedAt) ?? 0,
  );
}

function entryFor(
  skill: ManagedAutoSkill,
  record: AutoSkillRecord,
  state: AutoSkillState,
  nowMs: number,
): AutoSkillCuratorEntry {
  return {
    directoryName: skill.directoryName,
    skillName: skill.skillName,
    state,
    lastActivityAt: new Date(
      lastActivityMs(skill, record, nowMs),
    ).toISOString(),
    useCount: record.useCount,
    pinned: record.pinned,
  };
}

async function rollbackMoves(
  moved: Array<{ source: string; destination: string }>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const move of [...moved].reverse()) {
    try {
      await fs.rename(move.destination, move.source);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function runLocked(
  paths: CuratorPaths,
  state: AutoSkillCuratorState,
  now: Date,
): Promise<AutoSkillCuratorRunResult> {
  const skills = await scanManagedSkills(paths.skillsRoot);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const result: AutoSkillCuratorRunResult = {
    dryRun: false,
    checked: skills.length,
    seeded: [],
    markedStale: [],
    reactivated: [],
    archived: [],
    skippedCollisions: [],
    skippedErrors: [],
  };
  const moved: Array<{ source: string; destination: string }> = [];

  try {
    for (const scanned of skills) {
      const existing = state.skills[scanned.directoryName];
      const record = recordForSkill(state, scanned, nowIso);
      if (!existing) {
        result.seeded.push(scanned.directoryName);
        continue;
      }
      if (record.pinned) continue;
      const inactivityMs = nowMs - lastActivityMs(scanned, record, nowMs);
      if (inactivityMs >= AUTO_SKILL_ARCHIVE_AFTER_MS) {
        const current = await readManagedSkill(
          paths.skillsRoot,
          scanned.directoryName,
        );
        if (!current) continue;
        const currentInactivityMs =
          nowMs - lastActivityMs(current, record, nowMs);
        if (currentInactivityMs < AUTO_SKILL_ARCHIVE_AFTER_MS) {
          if (currentInactivityMs >= AUTO_SKILL_STALE_AFTER_MS) {
            if (record.state !== 'stale') {
              record.state = 'stale';
              delete record.archivedAt;
              result.markedStale.push(scanned.directoryName);
            }
          } else if (record.state !== 'active') {
            record.state = 'active';
            delete record.archivedAt;
            result.reactivated.push(scanned.directoryName);
          }
          continue;
        }
        await ensureSafeDirectory(paths.archiveRoot);
        const destination = path.join(paths.archiveRoot, scanned.directoryName);
        try {
          await fs.lstat(destination);
          result.skippedCollisions.push(scanned.directoryName);
          continue;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        try {
          await fs.rename(current.directoryPath, destination);
        } catch {
          result.skippedErrors.push(scanned.directoryName);
          continue;
        }
        moved.push({ source: current.directoryPath, destination });
        record.state = 'archived';
        record.archivedAt = nowIso;
        result.archived.push(scanned.directoryName);
      } else if (inactivityMs >= AUTO_SKILL_STALE_AFTER_MS) {
        if (record.state !== 'stale') {
          record.state = 'stale';
          delete record.archivedAt;
          result.markedStale.push(scanned.directoryName);
        }
      } else if (record.state !== 'active') {
        record.state = 'active';
        delete record.archivedAt;
        result.reactivated.push(scanned.directoryName);
      }
    }
    // Prune records whose directory exists in neither root so the state
    // file does not grow without bound in long-lived projects. Check raw
    // directory presence (not eligibility) so an ineligible-but-present
    // directory keeps its record.
    const listDirs = async (root: string): Promise<Set<string>> => {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return new Set(
          entries.filter((e) => e.isDirectory()).map((e) => e.name),
        );
      } catch {
        return new Set();
      }
    };
    const [liveDirs, archiveDirs] = await Promise.all([
      listDirs(paths.skillsRoot),
      listDirs(paths.archiveRoot),
    ]);
    for (const dirName of Object.keys(state.skills)) {
      if (!liveDirs.has(dirName) && !archiveDirs.has(dirName)) {
        delete state.skills[dirName];
      }
    }
    state.lastRunAt = nowIso;
    await atomicWriteJSON(paths.statePath, state, {
      mode: 0o600,
      noFollow: true,
    });
    return result;
  } catch (error) {
    const rollbackErrors = await rollbackMoves(moved);
    if (rollbackErrors.length > 0) {
      throw new Error(`Rollback failed: ${rollbackErrors.join('; ')}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function previewRun(
  projectRoot: string,
  now: Date,
): Promise<AutoSkillCuratorRunResult> {
  const paths = getCuratorPaths(projectRoot);
  const [state, skills] = await Promise.all([
    readState(paths.statePath),
    scanManagedSkills(paths.skillsRoot),
  ]);
  const result: AutoSkillCuratorRunResult = {
    dryRun: true,
    checked: skills.length,
    seeded: [],
    markedStale: [],
    reactivated: [],
    archived: [],
    skippedCollisions: [],
    skippedErrors: [],
  };
  const nowMs = now.getTime();
  for (const skill of skills) {
    const existing = state.skills[skill.directoryName];
    if (!existing) {
      result.seeded.push(skill.directoryName);
      continue;
    }
    const record = recordForSkill(state, skill);
    if (record.pinned) continue;
    const inactivityMs = nowMs - lastActivityMs(skill, record, nowMs);
    if (inactivityMs >= AUTO_SKILL_ARCHIVE_AFTER_MS) {
      try {
        await fs.lstat(path.join(paths.archiveRoot, skill.directoryName));
        result.skippedCollisions.push(skill.directoryName);
      } catch (error) {
        if (!isMissing(error)) throw error;
        result.archived.push(skill.directoryName);
      }
    } else if (
      inactivityMs >= AUTO_SKILL_STALE_AFTER_MS &&
      record.state !== 'stale'
    ) {
      result.markedStale.push(skill.directoryName);
    } else if (
      inactivityMs < AUTO_SKILL_STALE_AFTER_MS &&
      record.state !== 'active'
    ) {
      result.reactivated.push(skill.directoryName);
    }
  }
  return result;
}

export async function runAutoSkillCurator(
  projectRoot: string,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<AutoSkillCuratorRunResult> {
  const now = options.now ?? new Date();
  if (options.dryRun) return previewRun(projectRoot, now);
  return withCuratorLock(projectRoot, async (paths) =>
    runLocked(paths, await readState(paths.statePath), now),
  );
}

export async function maybeRunAutoSkillCurator(
  projectRoot: string,
  now: Date = new Date(),
): Promise<AutoSkillCuratorAutomaticResult> {
  const paths = getCuratorPaths(projectRoot);
  // Fast path: readState is safe unlocked (atomic-rename writes prevent torn
  // reads), so most boots return not_due without paying for the lock.
  const unlocked = await readState(paths.statePath);
  if (unlocked.lastRunAt) {
    const lastRunMs = parseTimestamp(unlocked.lastRunAt)!;
    if (now.getTime() - lastRunMs < AUTO_SKILL_CURATOR_INTERVAL_MS) {
      return { status: 'not_due' };
    }
  }
  return withCuratorLock(projectRoot, async (lockedPaths) => {
    const state = await readState(lockedPaths.statePath);
    if (!state.lastRunAt) {
      const nowIso = now.toISOString();
      const skills = await scanManagedSkills(lockedPaths.skillsRoot);
      if (skills.length === 0 && Object.keys(state.skills).length === 0) {
        return { status: 'seeded', checked: 0 };
      }
      for (const skill of skills) {
        const existing = state.skills[skill.directoryName];
        state.skills[skill.directoryName] = {
          skillName: skill.skillName,
          // Preserve an existing baseline the way useCount/pinned/lastUsedAt are
          // preserved below: if recordAutoSkillUsage already created a record
          // before this first curator run, overwriting firstSeenAt/
          // lastActivityAt with `now` would reset the inactivity clock and delay
          // the stale transition. A brand-new skill still gets a fresh `now`
          // baseline (never the old manifest mtime), keeping first-sight grace.
          firstSeenAt: existing?.firstSeenAt ?? nowIso,
          lastActivityAt: existing?.lastActivityAt ?? nowIso,
          useCount: existing?.useCount ?? 0,
          state: 'active',
          pinned: existing?.pinned ?? false,
          ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        };
      }
      state.lastRunAt = nowIso;
      await atomicWriteJSON(lockedPaths.statePath, state, {
        mode: 0o600,
        noFollow: true,
      });
      return { status: 'seeded', checked: skills.length };
    }
    // Re-check under lock: another process may have run while we waited.
    const lastRunMs = parseTimestamp(state.lastRunAt)!;
    if (now.getTime() - lastRunMs < AUTO_SKILL_CURATOR_INTERVAL_MS) {
      return { status: 'not_due' };
    }
    return {
      status: 'ran',
      result: await runLocked(lockedPaths, state, now),
    };
  });
}

export async function recordAutoSkillUsage(
  projectRoot: string,
  skill: Pick<SkillConfig, 'filePath' | 'name' | 'level'>,
  now: Date = new Date(),
): Promise<boolean> {
  if (skill.level !== 'project') return false;
  const paths = getCuratorPaths(projectRoot);
  const resolvedManifestPath = path.resolve(skill.filePath);
  const directoryPath = path.dirname(resolvedManifestPath);
  if (path.dirname(directoryPath) !== path.resolve(paths.skillsRoot)) {
    return false;
  }
  const directoryName = path.basename(directoryPath);
  const candidate = await readManagedSkill(paths.skillsRoot, directoryName);
  if (!candidate || candidate.manifestPath !== resolvedManifestPath) {
    return false;
  }
  return withCuratorLock(projectRoot, async (lockedPaths) => {
    const managed = await readManagedSkill(
      lockedPaths.skillsRoot,
      directoryName,
    );
    if (!managed || managed.manifestPath !== resolvedManifestPath) {
      return false;
    }
    const state = await readState(lockedPaths.statePath);
    const nowIso = now.toISOString();
    const record = recordForSkill(state, managed, nowIso);
    record.lastActivityAt = nowIso;
    record.lastUsedAt = nowIso;
    record.useCount += 1;
    record.state = 'active';
    delete record.archivedAt;
    await atomicWriteJSON(lockedPaths.statePath, state, {
      mode: 0o600,
      noFollow: true,
    });
    return true;
  });
}

export async function setAutoSkillPinned(
  projectRoot: string,
  directoryName: string,
  pinned: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (!isManagedDirectoryName(directoryName)) {
    throw new Error(
      `Managed auto-skill not found: ${JSON.stringify(directoryName)}.`,
    );
  }
  await withCuratorLock(projectRoot, async (paths) => {
    const managed = await readManagedSkill(paths.skillsRoot, directoryName);
    if (!managed) {
      throw new Error(`Managed auto-skill not found: ${directoryName}.`);
    }
    const state = await readState(paths.statePath);
    const record = recordForSkill(state, managed, now.toISOString());
    record.pinned = pinned;
    await atomicWriteJSON(paths.statePath, state, {
      mode: 0o600,
      noFollow: true,
    });
  });
}

export async function getAutoSkillCuratorStatus(
  projectRoot: string,
  now: Date = new Date(),
): Promise<AutoSkillCuratorStatus> {
  const paths = getCuratorPaths(projectRoot);
  const [state, liveSkills, archivedSkills] = await Promise.all([
    readState(paths.statePath),
    scanManagedSkills(paths.skillsRoot),
    scanManagedSkills(paths.archiveRoot),
  ]);
  const status: AutoSkillCuratorStatus = {
    lastRunAt: state.lastRunAt,
    active: [],
    stale: [],
    archived: [],
  };
  const nowMs = now.getTime();
  for (const skill of liveSkills) {
    const record = recordForSkill(state, skill, now.toISOString());
    const inactivityMs = nowMs - lastActivityMs(skill, record, nowMs);
    const effectiveState: AutoSkillState = record.pinned
      ? record.state === 'stale'
        ? 'stale'
        : 'active'
      : inactivityMs >= AUTO_SKILL_STALE_AFTER_MS
        ? 'stale'
        : 'active';
    status[effectiveState].push(entryFor(skill, record, effectiveState, nowMs));
  }
  const liveNames = new Set(liveSkills.map((s) => s.directoryName));
  for (const skill of archivedSkills) {
    if (liveNames.has(skill.directoryName)) continue;
    const record = recordForSkill(state, skill);
    status.archived.push(entryFor(skill, record, 'archived', nowMs));
  }
  return status;
}

export async function restoreArchivedAutoSkill(
  projectRoot: string,
  directoryName: string,
  now: Date = new Date(),
): Promise<void> {
  await withCuratorLock(projectRoot, async (paths) => {
    if (!isManagedDirectoryName(directoryName)) {
      throw new Error(
        `Archived auto-skill not found: ${JSON.stringify(directoryName)}.`,
      );
    }
    const archiveRootStat = await fs.lstat(paths.archiveRoot).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!archiveRootStat) {
      throw new Error(`Archived auto-skill not found: ${directoryName}.`);
    }
    if (!archiveRootStat.isDirectory() || archiveRootStat.isSymbolicLink()) {
      throw new Error(
        `Auto-skill curator refuses unsafe path ${paths.archiveRoot}.`,
      );
    }
    const archived = await readManagedSkill(paths.archiveRoot, directoryName);
    if (!archived) {
      // readManagedSkill returns undefined both when the directory is absent
      // and when it exists but is not an eligible archived skill (e.g. a
      // hand-edited manifest that lost its frontmatter). Distinguish the two so
      // a plainly-present directory is not reported as missing.
      let directoryExists = true;
      try {
        await fs.lstat(path.join(paths.archiveRoot, directoryName));
      } catch (error) {
        if (!isMissing(error)) throw error;
        directoryExists = false;
      }
      throw new Error(
        directoryExists
          ? `Archived auto-skill ${directoryName} is not an eligible managed skill.`
          : `Archived auto-skill not found: ${directoryName}.`,
      );
    }
    const destination = path.join(paths.skillsRoot, directoryName);
    try {
      await fs.lstat(destination);
      throw new Error(
        `Cannot restore ${directoryName}: an active directory already exists.`,
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await ensureSafeDirectory(paths.skillsRoot);
    const state = await readState(paths.statePath);
    const record = recordForSkill(state, archived);
    record.state = 'active';
    record.lastActivityAt = now.toISOString();
    delete record.archivedAt;

    await fs.rename(archived.directoryPath, destination);
    try {
      await atomicWriteJSON(paths.statePath, state, {
        mode: 0o600,
        noFollow: true,
      });
    } catch (error) {
      try {
        await fs.rename(destination, archived.directoryPath);
      } catch (rollbackError) {
        throw new Error(
          `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}
