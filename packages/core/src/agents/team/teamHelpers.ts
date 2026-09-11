/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Team file CRUD, name sanitization, color management,
 * and cleanup utilities.
 *
 * All file operations target `~/.qwen/teams/{team-name}/config.json`.
 * Functions are pure where possible; side-effectful I/O functions are
 * clearly separated.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../../config/storage.js';
import { isNodeError } from '../../utils/errors.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isPidAlive } from '../../utils/process-liveness.js';
import type { TeamFile, TeamMember } from './types.js';
import {
  TEAMS_DIR,
  TEAM_CONFIG_FILENAME,
  TEAMMATE_COLORS,
  INBOXES_DIR,
  TASKS_DIR,
  LEADER_NAME,
} from './types.js';

// ─── Path helpers ───────────────────────────────────────────

/**
 * Absolute path to the teams root directory.
 * `~/.qwen/teams/`
 */
export function getTeamsRootDir(): string {
  return path.join(Storage.getGlobalQwenDir(), TEAMS_DIR);
}

/**
 * Absolute path to a specific team's directory.
 * `~/.qwen/teams/{teamName}/`
 */
export function getTeamDir(teamName: string): string {
  return path.join(getTeamsRootDir(), teamName);
}

/**
 * Absolute path to a team's config file.
 * `~/.qwen/teams/{teamName}/config.json`
 */
export function getTeamFilePath(teamName: string): string {
  return path.join(getTeamDir(teamName), TEAM_CONFIG_FILENAME);
}

/**
 * Absolute path to a team's inboxes directory.
 * `~/.qwen/teams/{teamName}/inboxes/`
 */
export function getInboxesDir(teamName: string): string {
  return path.join(getTeamDir(teamName), INBOXES_DIR);
}

/**
 * Absolute path to the tasks directory for a team.
 * `~/.qwen/tasks/{teamName}/`
 */
export function getTasksDir(teamName: string): string {
  return path.join(Storage.getGlobalQwenDir(), TASKS_DIR, teamName);
}

// ─── Name helpers ───────────────────────────────────────────

/**
 * Sanitize a team or agent name for use as a directory/file name.
 * Lowercases, replaces non-alphanumeric (except hyphens) with
 * hyphens, collapses consecutive hyphens, and trims leading/
 * trailing hyphens.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Format an agent ID from a name and team name.
 * Convention: "name@teamName".
 */
export function formatAgentId(name: string, teamName: string): string {
  return `${sanitizeName(name)}@${sanitizeName(teamName)}`;
}

/**
 * Validate and return a sanitized teammate name. Throws if the
 * name is empty, reserved, or collides with an existing member —
 * the caller (Agent tool) requires `name` to be explicit, so a
 * collision is a model error worth surfacing rather than auto-
 * suffixing silently into a teammate the model didn't ask for.
 */
export function generateUniqueTeammateName(
  baseName: string,
  existingMembers: readonly TeamMember[],
): string {
  const sanitized = sanitizeName(baseName);

  // Empty names are unaddressable (send_message treats blank "to"
  // as missing), and "leader" is reserved for the leader inbox in
  // TeamManager.sendMessage — a teammate with that name would be
  // shadowed and unreachable.
  if (!sanitized) {
    throw new Error(
      `Teammate name "${baseName}" sanitizes to an empty string. ` +
        `Choose a name with at least one alphanumeric character.`,
    );
  }
  if (sanitized === LEADER_NAME) {
    throw new Error(
      `"${LEADER_NAME}" is reserved for the team leader. ` +
        `Choose a different teammate name.`,
    );
  }

  const existingNames = new Set(existingMembers.map((m) => m.name));
  if (existingNames.has(sanitized)) {
    // Listing the existing names so the model can pick a non-
    // colliding one on the retry without another round-trip.
    const existingList = [...existingNames].join(', ') || '<none>';
    throw new Error(
      `A teammate named "${sanitized}" already exists in this team ` +
        `(existing: ${existingList}). Choose a different name.`,
    );
  }

  return sanitized;
}

// ─── Color management ───────────────────────────────────────

/**
 * Assign the next available color to a teammate.
 * Picks the first color from TEAMMATE_COLORS not already used
 * by an existing member. Wraps around if all colors are taken.
 */
export function assignTeammateColor(
  existingMembers: readonly TeamMember[],
): string {
  const usedColors = new Set(
    existingMembers
      .map((m) => m.color)
      .filter((c): c is string => c !== undefined),
  );

  for (const color of TEAMMATE_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }

  // All colors taken — wrap around based on member count.
  return TEAMMATE_COLORS[existingMembers.length % TEAMMATE_COLORS.length]!;
}

/**
 * Clear all teammate colors from a team file's members.
 * Returns a new members array (does not mutate).
 */
export function clearTeammateColors(
  members: readonly TeamMember[],
): TeamMember[] {
  return members.map((m) => {
    const { color: _, ...rest } = m;
    return rest as TeamMember;
  });
}

// ─── Member helpers ─────────────────────────────────────────

/**
 * Set a member's `isActive` flag.
 * Returns a new members array (does not mutate).
 */
export function setMemberActive(
  members: readonly TeamMember[],
  agentId: string,
  isActive: boolean,
): TeamMember[] {
  return members.map((m) => (m.agentId === agentId ? { ...m, isActive } : m));
}

/**
 * Find a member by agent ID.
 */
export function findMemberById(
  members: readonly TeamMember[],
  agentId: string,
): TeamMember | undefined {
  return members.find((m) => m.agentId === agentId);
}

/**
 * Find a member by name. Stored member names are already sanitized
 * (see {@link sanitizeName}), so the lookup name is sanitized too —
 * `"QA Tester"` matches the stored `"qa-tester"`.
 */
export function findMemberByName(
  members: readonly TeamMember[],
  name: string,
): TeamMember | undefined {
  const sanitized = sanitizeName(name);
  return members.find((m) => m.name === sanitized);
}

/**
 * Classify a teammate's free-text reply to a shutdown request.
 *
 * The leader asks the teammate to reply with `shutdown_approved` or
 * `shutdown_rejected: <reason>`. A compliant reply leads with the
 * token, so match only at the start (after leading whitespace) — never
 * anywhere in the body. That anchoring is what stops a teammate that
 * merely *mentions* the token mid-report (e.g. while reviewing
 * shutdown-related code) from being read as an approval and aborted,
 * while still accepting the verbose `shutdown_approved, work finished`
 * form that an exact-string match would miss.
 *
 * Returns the structured response type, or undefined when the reply is
 * not a shutdown response.
 */
export function classifyShutdownResponse(
  message: string,
): 'shutdown_approved' | 'shutdown_rejected' | undefined {
  const trimmed = message.trimStart();
  if (/^shutdown_approved\b/i.test(trimmed)) return 'shutdown_approved';
  if (/^shutdown_rejected\b/i.test(trimmed)) return 'shutdown_rejected';
  return undefined;
}

// ─── File I/O ───────────────────────────────────────────────

/**
 * Read a team file from disk.
 * Returns undefined if the file does not exist.
 */
export async function readTeamFile(
  teamName: string,
): Promise<TeamFile | undefined> {
  const filePath = getTeamFilePath(teamName);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as TeamFile;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Write a team file to disk. Creates parent directories if needed.
 *
 * Used for updates after the team exists. For initial creation,
 * prefer `createTeamFile` which refuses to clobber an existing
 * file (cross-session safety).
 */
export async function writeTeamFile(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const filePath = getTeamFilePath(teamName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, teamFile);
}

/**
 * Atomically create a team file. Throws ENOENT-equivalent
 * `EEXIST` if a different qwen-code session already owns the
 * team name — `team_create`'s in-process guard only checks the
 * current Config, so without this two sessions opening the same
 * team name would silently clobber each other's state.
 */
export async function createTeamFile(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const filePath = getTeamFilePath(teamName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(teamFile, null, 2) + '\n', {
    encoding: 'utf-8',
    flag: 'wx',
  });
}

/**
 * Reclaim a stale team so its name can be reused.
 *
 * Nothing deletes team dirs on normal session exit (only an explicit
 * `team_delete` does), so `team_create`'s `wx`-exclusive create would
 * otherwise wedge the name forever after a Ctrl+C, a completed
 * headless run, or a crash. A team is stale when its recorded
 * `leadPid` is no longer running — or IS this process (the caller can
 * only be creating a new team because it no longer has a manager for
 * the old one). Returns true after deleting the stale team's dirs.
 *
 * Conservative on ambiguity: an unreadable/corrupt team file or a
 * pre-`leadPid` file can't prove its owner is gone, so it is left
 * for manual recovery. Likewise when the config changes between the
 * staleness check and the delete — that change means another creator
 * already reclaimed the name and created a new live generation, which
 * a by-name delete would destroy (#10209).
 */
export async function tryReclaimStaleTeam(teamName: string): Promise<boolean> {
  const configPath = getTeamFilePath(teamName);
  let inspectedRaw: string;
  try {
    inspectedRaw = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // config.json vanished between the caller's EEXIST and this read —
      // a concurrent team_delete finished the job. The dirs may still
      // hold leftovers; clear them so the retried create starts clean.
      await deleteTeamDirs(teamName);
      return true;
    }
    return false;
  }
  let existing: TeamFile;
  try {
    const parsed: unknown = JSON.parse(inspectedRaw);
    // A config containing the literal `null` (or any other non-object
    // JSON value) parses successfully but proves nothing about the
    // owner — treat it like a corrupt file and leave the dirs for
    // manual recovery.
    if (parsed === null || typeof parsed !== 'object') {
      return false;
    }
    existing = parsed as TeamFile;
  } catch {
    return false;
  }
  if (typeof existing.leadPid !== 'number' || existing.leadPid <= 0) {
    return false;
  }
  if (existing.leadPid !== process.pid && isPidAlive(existing.leadPid)) {
    return false;
  }
  // Generation safety (#10209): the delete below targets the team NAME,
  // not the generation inspected above. Two concurrent creators can
  // read the same stale config and both pass the liveness check; if
  // one of them reclaims the name and creates a new team before this
  // delete runs, a by-name delete would destroy that newer live
  // generation. Only proceed when the on-disk config is still
  // byte-identical to the stale generation this reclaim inspected —
  // otherwise the name now belongs to a newer generation, and the
  // caller's retried create will fail with EEXIST against it.
  try {
    const currentRaw = await fs.readFile(configPath, 'utf-8');
    if (currentRaw !== inspectedRaw) {
      return false;
    }
  } catch {
    // The config vanished or became unreadable after the inspection —
    // ambiguous, and a by-name delete could hit a generation this
    // reclaim never inspected.
    return false;
  }
  await deleteTeamDirs(teamName);
  return true;
}

/**
 * Delete an entire team directory and its associated task
 * directory. Missing directories are silently ignored because
 * fs.rm is called with { force: true }.
 * Throws on real filesystem failures (EACCES, EIO, etc.).
 * When both removals fail, throws an AggregateError covering both.
 */
export async function deleteTeamDirs(teamName: string): Promise<void> {
  const teamDir = getTeamDir(teamName);
  const tasksDir = getTasksDir(teamName);

  const results = await Promise.allSettled([
    fs.rm(teamDir, { recursive: true, force: true }),
    fs.rm(tasksDir, { recursive: true, force: true }),
  ]);

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    // Fold member messages into the wrapper message: serializers that
    // only read `.stack`/`.message` (e.g. debugLogger) would otherwise
    // drop the per-directory errno/path detail of `.errors`.
    throw new AggregateError(
      errors,
      `Failed to delete team directories for "${teamName}": ${errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ')}`,
    );
  }
}

/**
 * List all team names (directory names under ~/.qwen/teams/).
 * Returns an empty array if the teams directory doesn't exist.
 */
export async function listTeamNames(): Promise<string[]> {
  const teamsRoot = getTeamsRootDir();
  try {
    const entries = await fs.readdir(teamsRoot, {
      withFileTypes: true,
    });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
