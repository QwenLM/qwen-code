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
 * Concurrency is handled via `proper-lockfile` (10 retries,
 * 5–100ms exponential backoff).
 *
 * Phase 1 uses this for structured messages only (shutdown,
 * plan approval, task assignment). Plain text messages go through
 * `AgentInteractive.enqueueMessage()`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { isNodeError } from '../../utils/errors.js';
import { getInboxesDir } from './teamHelpers.js';

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
  },
  stale: 5000,
  // Suppress compromised lock errors — stale locks from crashed
  // processes are expected in multi-agent scenarios.
  onCompromised: () => {},
};

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
 * Write a message to an agent's inbox.
 * Creates the inbox file and parent directories if needed.
 * Uses file locking to prevent concurrent write corruption.
 */
export async function writeMessage(
  teamName: string,
  toAgentName: string,
  message: MailboxMessage,
): Promise<void> {
  const inboxPath = getInboxPath(teamName, toAgentName);
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  await ensureInboxFile(inboxPath);

  const release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
  try {
    const messages = await readInboxRaw(inboxPath);
    messages.push(message);
    await fs.writeFile(
      inboxPath,
      JSON.stringify(messages, null, 2) + '\n',
      'utf-8',
    );
  } finally {
    await release();
  }
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

  const release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
  try {
    const messages = await readInboxRaw(inboxPath);
    const predicate = (m: MailboxMessage) =>
      !m.read && (type === undefined || m.type === type);
    const matching = messages.filter(predicate);
    if (matching.length === 0) return [];

    const updated = messages.map((m) =>
      predicate(m) ? { ...m, read: true } : m,
    );
    await fs.writeFile(
      inboxPath,
      JSON.stringify(updated, null, 2) + '\n',
      'utf-8',
    );
    return matching;
  } finally {
    await release();
  }
}

/**
 * Read and remove all unread messages of a specific type.
 * @deprecated Use `consumeUnread(teamName, agentName, type)` instead.
 */
export async function consumeUnreadByType(
  teamName: string,
  agentName: string,
  type: MailboxMessageType,
): Promise<MailboxMessage[]> {
  return consumeUnread(teamName, agentName, type);
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

/** Read inbox without locking (caller must hold lock or accept races). */
async function readInboxRaw(inboxPath: string): Promise<MailboxMessage[]> {
  try {
    const raw = await fs.readFile(inboxPath, 'utf-8');
    return JSON.parse(raw) as MailboxMessage[];
  } catch {
    return [];
  }
}
