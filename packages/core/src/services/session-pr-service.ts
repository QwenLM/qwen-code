/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';

/**
 * Persisted GitHub pull request binding for a session. Written by the daemon
 * when a PR is created from the session (e.g. the Web Shell Git dialog), and
 * read on session listing so the binding survives daemon restarts.
 *
 * Stored as a sidecar JSON file alongside the session's JSONL transcript at
 * `<chatsDir>/<sessionId>.pr.json`.
 */
export interface SessionPr {
  number: number;
  url: string;
  createdAt: string;
}

/**
 * Runtime shape check for a parsed sidecar object. Guards against partial
 * writes and manual edits (same rationale as the worktree sidecar check).
 * The url is rendered as a link target, so only http(s) URLs are accepted.
 */
function isValidSessionPr(value: unknown): value is SessionPr {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    typeof v['url'] === 'string' &&
    /^https?:\/\//i.test(v['url']) &&
    typeof v['createdAt'] === 'string'
  );
}

/**
 * Read the sidecar. Returns null when the file does not exist, is invalid
 * JSON, or fails the shape check. Throws only on unexpected I/O errors.
 */
export async function readSessionPr(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionPr | null> {
  let raw: string;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal
      ? await fs.readFile(filePath, {
          encoding: 'utf-8',
          signal: options.signal,
        })
      : await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  options.signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();
  if (!isValidSessionPr(parsed)) return null;
  return parsed;
}

/** Writes the PR sidecar via `atomicWriteJSON`. */
export async function writeSessionPr(
  filePath: string,
  pr: SessionPr,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, pr);
}
