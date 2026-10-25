/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What `autofix_pr` keeps per session, in memory only: the watches whose
 * `prepare` this session ran through the tool, and the worktrees whose fix
 * agents `unattended` lets run their commands without asking. A file would
 * sit in reach of the code those agents run, and the state file does: none
 * of this is read back from it. Both end with the session — `/clear`,
 * `/resume` and `/new` drop them (`Config.startNewSession`) — and with the
 * process.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** A watch as the `prepare` this session ran reported it. */
export interface ConfirmedWatch {
  pr: number;
  /** `<owner>/<repo>`, as `prepare` was given it. */
  repo: string;
  /** The host `prepare` resolved, or null when it did not say. */
  host: string | null;
  /** The session's directory it was prepared from: one clone's watch. */
  targetDir: string;
  /** When `prepare` made the watch: a later one of the PR is another. */
  preparedAt: string | null;
  /** The worktree's canonical path. */
  worktree: string;
  /** What GitHub said when `prepare` asked, just now. */
  authorCanPush: boolean;
}

export interface UnattendedFixGrant {
  pr: number;
  /** The worktree's canonical path. */
  worktree: string;
  /** Whether the watch still allows it; asked at every launch. */
  check: (signal: AbortSignal) => Promise<boolean>;
}

const confirmed = new Map<string, Map<number, ConfirmedWatch>>();
const grants = new Map<string, Map<string, UnattendedFixGrant>>();

/** A worktree as grants are keyed: its real path, in the file system's case. */
export function canonicalWorktreePath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function recordConfirmedWatch(
  sessionId: string,
  watch: ConfirmedWatch,
): void {
  let bySession = confirmed.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    confirmed.set(sessionId, bySession);
  }
  bySession.set(watch.pr, watch);
}

export function confirmedWatch(
  sessionId: string,
  pr: number,
): ConfirmedWatch | undefined {
  return confirmed.get(sessionId)?.get(pr);
}

/** Forgets the PR's confirmed watch and ends its grant. */
export function forgetConfirmedWatch(sessionId: string, pr: number): void {
  const bySession = confirmed.get(sessionId);
  bySession?.delete(pr);
  if (bySession?.size === 0) confirmed.delete(sessionId);
  revokeUnattendedFixes(sessionId, pr);
}

export function grantUnattendedFixes(
  sessionId: string,
  grant: UnattendedFixGrant,
): void {
  let bySession = grants.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    grants.set(sessionId, bySession);
  }
  // One grant per PR: a recreated worktree replaces the old one.
  for (const [worktree, existing] of bySession) {
    if (existing.pr === grant.pr) bySession.delete(worktree);
  }
  bySession.set(grant.worktree, grant);
}

export function revokeUnattendedFixes(sessionId: string, pr: number): void {
  const bySession = grants.get(sessionId);
  if (!bySession) return;
  for (const [worktree, grant] of bySession) {
    if (grant.pr === pr) bySession.delete(worktree);
  }
  if (bySession.size === 0) grants.delete(sessionId);
}

/**
 * Whether an agent this session launches in `workingDir` runs its commands
 * without asking: a grant for that worktree whose watch, checked now, still
 * allows it. A failed check ends the grant.
 */
export async function hasUnattendedFixGrant(
  sessionId: string,
  workingDir: string,
  signal: AbortSignal,
): Promise<boolean> {
  const grant = grants.get(sessionId)?.get(canonicalWorktreePath(workingDir));
  if (!grant) return false;
  let allowed = false;
  try {
    allowed = await grant.check(signal);
  } catch {
    allowed = false;
  }
  if (!allowed && !signal.aborted) revokeUnattendedFixes(sessionId, grant.pr);
  return allowed;
}

/** Whether the session granted the worktree's fixes, unchecked. */
export function unattendedFixGranted(
  sessionId: string,
  worktree: string,
): boolean {
  return grants.get(sessionId)?.has(canonicalWorktreePath(worktree)) === true;
}

// The Configs of agents a grant runs in YOLO mode: an agent one of them
// starts takes the session's own mode, not theirs.
const grantedConfigs = new WeakSet<object>();

export function markUnattendedFixConfig(config: object): void {
  grantedConfigs.add(config);
}

/** Also a Config derived from one of them, as a rebuilt registry binds to. */
export function isUnattendedFixConfig(config: object): boolean {
  for (let c: object | null = config; c; c = Object.getPrototypeOf(c)) {
    if (grantedConfigs.has(c)) return true;
  }
  return false;
}

/** Drops everything a session confirmed and granted. */
export function forgetAutofixPrSession(sessionId: string): void {
  confirmed.delete(sessionId);
  grants.delete(sessionId);
}

/** Test-only: forgets every session. */
export function resetUnattendedFixGrantsForTests(): void {
  confirmed.clear();
  grants.clear();
}
