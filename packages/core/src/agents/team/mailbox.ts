/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview File-based mailbox for structured control messages.
 *
 * Each agent has an inbox file at
 * `~/.qwen/teams/{teamName}/inboxes/{agentName}.json`.
 *
 * Concurrency is handled in two layers: a per-inbox in-process
 * `Mutex` serializes writers within this process, and a
 * `proper-lockfile` file lock (10 retries, randomized 5–100ms
 * exponential backoff) guards against writers in other agent
 * processes. The in-process mutex is what keeps same-process
 * writers from stampeding the file lock — without it, slower
 * Windows fs syscalls let concurrent writers exhaust the lock
 * retry budget and throw `ELOCKED`.
 *
 * Phase 1 uses this for structured messages only (shutdown,
 * plan approval, task assignment). Plain text messages go through
 * `AgentInteractive.enqueueMessage()`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { Mutex } from 'async-mutex';
import { isNodeError } from '../../utils/errors.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { getInboxesDir } from './teamHelpers.js';

const debug = createDebugLogger('AGENTS_TEAM_MAILBOX');

// ─── Types ──────────────────────────────────────────────────

/** Structured message types for Phase 1. */
export type MailboxMessageType =
  | 'shutdown_request'
  | 'shutdown_approved'
  | 'shutdown_rejected'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'task_assignment';

/**
 * A single mailbox message.
 */
export interface MailboxMessage {
  /** Sender agent name. */
  from: string;
  /** Message text content. */
  text: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Whether the message has been read. */
  read: boolean;
  /** Structured message type. */
  type?: MailboxMessageType;
  /** Sender's assigned color for UI. */
  color?: string;
  /** 5–10 word preview for UI. */
  summary?: string;
}

// ─── Lock options ───────────────────────────────────────────

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    // Jitter the backoff so cross-process contenders don't retry in
    // lockstep (thundering herd) and starve each other out of the
    // retry budget.
    randomize: true,
  },
  stale: 5000,
  // Stale locks from crashed processes are expected in multi-agent
  // scenarios; log at debug level for traceability without noise.
  onCompromised: (err) => {
    debug.debug('mailbox lock compromised:', err?.message ?? err);
  },
};

// ─── In-process serialization ───────────────────────────────
//
// One `Mutex` per inbox path, keyed by absolute path. Distinct
// inboxes never block each other; concurrent operations on the same
// inbox queue in memory so only one of them ever reaches for the
// `proper-lockfile` file lock at a time. Entries are evicted on team
// teardown (`disposeInboxLocks`) so a long-running process doesn't
// accumulate a dead `Mutex` per inbox across team create/delete cycles.

const inboxLocks = new Map<string, Mutex>();

function getInboxLock(inboxPath: string): Mutex {
  let lock = inboxLocks.get(inboxPath);
  if (!lock) {
    lock = new Mutex();
    inboxLocks.set(inboxPath, lock);
  }
  return lock;
}

/**
 * Evict the in-process inbox locks for a team. The lock map keys on
 * absolute inbox path and would otherwise retain a `Mutex` for every
 * inbox the process ever touched — a slow leak across many team
 * create/delete cycles in a long-lived daemon. All of a team's inbox
 * paths sit directly under its inboxes dir, so match on the parent.
 *
 * Best-effort: a teammate's late `writeMessage` racing team teardown
 * can re-create an entry afterwards, but the next same-name
 * `team_create` resets inboxes and evicts it again.
 *
 * Returns the number of locks evicted.
 */
export function disposeInboxLocks(teamName: string): number {
  const dir = getInboxesDir(teamName);
  let evicted = 0;
  for (const key of inboxLocks.keys()) {
    if (path.dirname(key) === dir) {
      inboxLocks.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Run `fn` while holding both the in-process inbox mutex and the
 * cross-process file lock for `inboxPath`.
 *
 * The mutex serializes writers in this process so they don't stampede
 * the file lock (the cause of the Windows `ELOCKED` flakiness); the
 * file lock runs inside it to still guard against writers in other
 * agent processes.
 */
async function withInboxLock<T>(
  inboxPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return getInboxLock(inboxPath).runExclusive(async () => {
    const release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

// ─── Path helpers ───────────────────────────────────────────

/**
 * Absolute path to an agent's inbox file.
 */
export function getInboxPath(teamName: string, agentName: string): string {
  return path.join(getInboxesDir(teamName), `${agentName}.json`);
}

// ─── Core operations ────────────────────────────────────────

/**
 * Read all messages from an agent's inbox.
 * Returns an empty array if the inbox doesn't exist.
 *
 * Reads happen without a lock: writes go through a tmp-file +
 * `rename` (atomicWriteJSON), so a reader can race with a writer
 * but will always observe either the pre-write or post-write
 * file — never a partial one. This avoids paying lock-contention
 * cost on the hot 500ms leader poll.
 */
export async function readInbox(
  teamName: string,
  agentName: string,
): Promise<MailboxMessage[]> {
  const inboxPath = getInboxPath(teamName, agentName);
  try {
    const raw = await fs.readFile(inboxPath, 'utf-8');
    return JSON.parse(raw) as MailboxMessage[];
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * How long a `read: true` message stays in the inbox before
 * `writeMessage` compacts it out. Long enough that a
 * polling-window's worth of recent context is preserved for
 * debugging, short enough to keep the file bounded over a
 * long-running team session.
 */
const READ_RETENTION_MS = 5 * 60 * 1000;

/**
 * Write a message to an agent's inbox.
 * Creates the inbox file and parent directories if needed.
 * Uses file locking to prevent concurrent write corruption.
 *
 * Drops `read: true` entries older than `READ_RETENTION_MS` so
 * the file stays bounded under long-running teams. Unread
 * messages are never dropped — they're still owed to the
 * recipient.
 */
export async function writeMessage(
  teamName: string,
  toAgentName: string,
  message: MailboxMessage,
): Promise<void> {
  const inboxPath = getInboxPath(teamName, toAgentName);
  await ensureInboxFile(inboxPath);

  await withInboxLock(inboxPath, async () => {
    const messages = await readInboxRaw(inboxPath);
    const cutoff = Date.now() - READ_RETENTION_MS;
    const compacted = messages.filter((m) => {
      if (!m.read) return true;
      const ts = Date.parse(m.timestamp);
      return Number.isNaN(ts) || ts >= cutoff;
    });
    compacted.push(message);
    await atomicWriteJSON(inboxPath, compacted);
  });
}

/**
 * Read and remove all unread messages from an inbox,
 * optionally filtered by type. Marks matched messages as read.
 */
export async function consumeUnread(
  teamName: string,
  agentName: string,
  type?: MailboxMessageType,
): Promise<MailboxMessage[]> {
  const inboxPath = getInboxPath(teamName, agentName);
  await ensureInboxFile(inboxPath);

  return withInboxLock(inboxPath, async () => {
    const messages = await readInboxRaw(inboxPath);
    const predicate = (m: MailboxMessage) =>
      !m.read && (type === undefined || m.type === type);
    const matching = messages.filter(predicate);
    if (matching.length === 0) return [];

    const updated = messages.map((m) =>
      predicate(m) ? { ...m, read: true } : m,
    );
    await atomicWriteJSON(inboxPath, updated);
    return matching;
  });
}

/**
 * Clear an agent's entire inbox (delete the file).
 */
export async function clearInbox(
  teamName: string,
  agentName: string,
): Promise<void> {
  const inboxPath = getInboxPath(teamName, agentName);
  try {
    await fs.unlink(inboxPath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
  }
}

/**
 * Clear all inboxes for a team (delete the inboxes directory).
 */
export async function clearAllInboxes(teamName: string): Promise<void> {
  const dir = getInboxesDir(teamName);
  await fs.rm(dir, { recursive: true, force: true });
  disposeInboxLocks(teamName);
}

// ─── Convenience: send structured message ───────────────────

/**
 * Send a structured control message to an agent's mailbox.
 */
export async function sendStructuredMessage(
  teamName: string,
  toAgentName: string,
  opts: {
    from: string;
    type: MailboxMessageType;
    text: string;
    color?: string;
    summary?: string;
  },
): Promise<void> {
  await writeMessage(teamName, toAgentName, {
    from: opts.from,
    text: opts.text,
    timestamp: new Date().toISOString(),
    read: false,
    type: opts.type,
    color: opts.color,
    summary: opts.summary,
  });
}

// ─── Helpers ────────────────────────────────────────────────

/** Ensure the inbox file exists (create empty array if not). */
async function ensureInboxFile(inboxPath: string): Promise<void> {
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  try {
    await fs.writeFile(inboxPath, '[]\n', { flag: 'wx' });
  } catch (err) {
    // EEXIST means file already exists — that's fine.
    if (!isNodeError(err) || err.code !== 'EEXIST') throw err;
  }
}

/**
 * Read inbox without locking (caller must hold lock or accept races).
 *
 * Returns [] when the inbox file is missing — that's a legitimate
 * empty mailbox. A corrupt inbox (parse failure, unreadable file) is
 * quarantined to `.corrupt-{ts}` and treated as empty, mirroring the
 * leader path in `readLeaderInboxOrQuarantine`: without this, every
 * future `writeMessage` / `consumeUnread` for the teammate re-throws
 * on the same corrupt file, and the teammate can never receive
 * another message — including shutdown requests. Only if the
 * quarantine rename itself fails do we propagate the original error,
 * so a corrupt-but-recoverable file is never silently overwritten.
 */
async function readInboxRaw(inboxPath: string): Promise<MailboxMessage[]> {
  try {
    const raw = await fs.readFile(inboxPath, 'utf-8');
    return JSON.parse(raw) as MailboxMessage[];
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    const errMsg = err instanceof Error ? err.message : String(err);
    debug.warn(`Quarantining corrupt inbox at ${inboxPath}: ${errMsg}`);
    try {
      await fs.rename(inboxPath, `${inboxPath}.corrupt-${Date.now()}`);
    } catch (renameErr) {
      const renameMsg =
        renameErr instanceof Error ? renameErr.message : String(renameErr);
      debug.warn(`Failed to quarantine ${inboxPath}: ${renameMsg}`);
      throw err instanceof Error
        ? err
        : new Error(`Failed to read inbox at ${inboxPath}: ${errMsg}`);
    }
    return [];
  }
}
