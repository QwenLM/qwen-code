/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-session file attachments.
 *
 * Both peers share a filesystem, so the sender ships absolute paths rather than
 * bytes. The receiver copies each file into its *own* uploads directory — the
 * one `isInboundUploadPath` exempts — and rewrites the body with `@"path"`
 * references so the existing mention pipeline reads them.
 *
 * Copying rather than referencing the sender's path matters twice over: the
 * sender stays free to delete its original, and the read the model is granted
 * without a prompt is confined to this session's own uploads directory.
 *
 * Which file a peer chooses to send is *not* constrained here, and cannot be:
 * the sender may name any absolute path it can read, exactly as
 * {@link describePeerFiles} allows. What bounds that is the inbound gate —
 * accept, hold or refuse — plus the attachment count the approval dialog
 * discloses. This module's job is to keep the copy inside our own directory and
 * to reject a reference we could not have produced ourselves.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { BRAND_CLI_SLUG, ENV_PRODUCT_HOME } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';
import { sanitizeForDisplay } from './peer-message-preview.js';

/** Most files one message may carry. */
export const MAX_PEER_FILES = 10;

/** Keep attachment production separate from permission path matching. */
export function getInboundUploadDir(sessionId: string): string {
  const base = process.env[ENV_PRODUCT_HOME] ||
    path.join(homedir(), `.${BRAND_CLI_SLUG}`);
  return path.join(base, 'uploads', sessionId);
}

/** Largest single file we will copy. */
export const MAX_PEER_FILE_BYTES = 50 * 1024 * 1024;

/** Longest sanitized filename retained. */
const MAX_SAFE_NAME_LENGTH = 64;

/** Wire shape of one attachment reference. */
export interface PeerFileRef {
  path: string;
  name: string;
  bytes: number;
}

export interface PeerFileValidation {
  files: PeerFileRef[];
  rejected: string[];
}

/**
 * Validates sender-side paths, returning the references to put on the wire and
 * the human-readable reasons for anything skipped.
 */
export async function describePeerFiles(
  paths: readonly string[],
): Promise<PeerFileValidation> {
  const files: PeerFileRef[] = [];
  const rejected: string[] = [];

  for (const candidate of paths.slice(0, MAX_PEER_FILES)) {
    if (!path.isAbsolute(candidate)) {
      rejected.push(`${candidate} (not an absolute path)`);
      continue;
    }
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        rejected.push(`${candidate} (not a regular file)`);
        continue;
      }
      if (stat.size > MAX_PEER_FILE_BYTES) {
        rejected.push(`${candidate} (exceeds ${MAX_PEER_FILE_BYTES} bytes)`);
        continue;
      }
      files.push({
        path: candidate,
        name: path.basename(candidate),
        bytes: stat.size,
      });
    } catch {
      rejected.push(`${candidate} (unreadable)`);
    }
  }

  if (paths.length > MAX_PEER_FILES) {
    rejected.push(`${paths.length - MAX_PEER_FILES} file(s) beyond the limit`);
  }
  return { files, rejected };
}

/** Whether a value parsed off the wire is a usable attachment reference. */
export function isPeerFileRef(value: unknown): value is PeerFileRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Partial<PeerFileRef>;
  return (
    typeof ref.path === 'string' &&
    ref.path.length > 0 &&
    typeof ref.name === 'string' &&
    typeof ref.bytes === 'number'
  );
}

function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = base.slice(0, MAX_SAFE_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : 'attachment';
}

/**
 * A peer-authored name, bounded for text a human will read.
 *
 * Deliberately not {@link safeFileName}: that exists to make a name safe as a
 * *filename* and replaces everything outside `[A-Za-z0-9._-]`, which turns
 * `报告 final.pdf` into `___final.pdf`. Rejected attachments are named in the
 * message body, so what is needed there is display safety, which
 * {@link sanitizeForDisplay} provides without mangling non-ASCII names.
 */
function displayName(name: string): string {
  const cleaned = sanitizeForDisplay(name).trim().slice(0, MAX_SAFE_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * Whether a reference off the wire names a file we are willing to read.
 *
 * The sender checks this too ({@link describePeerFiles}), but a peer is free not
 * to be our sender: a relative path here would resolve against *our* working
 * directory rather than against anything the sender could see.
 */
function isReadableRefPath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !candidate.includes('\0');
}

export interface MaterializedPeerFiles {
  received: number;
  paths: string[];
  rejected: string[];
}

/**
 * Copies inbound attachments into this session's uploads directory.
 *
 * Best-effort per file: one unreadable attachment does not discard the message.
 * The caller must have already applied a `refuse` policy — nothing here should
 * run for a message this session declined.
 */
export async function materializePeerFiles(
  refs: readonly unknown[],
  sessionId: string,
): Promise<MaterializedPeerFiles> {
  const targetDir = getInboundUploadDir(sessionId);
  const result: MaterializedPeerFiles = {
    received: 0,
    paths: [],
    rejected: [],
  };

  const valid = refs.filter(isPeerFileRef).slice(0, MAX_PEER_FILES);
  if (valid.length === 0) return result;

  try {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    runLogger.debug(`[peer-files] Cannot create ${targetDir}: ${error}`);
    return result;
  }

  for (const ref of valid) {
    // Reported rather than filtered out: an attachment silently dropped is one
    // the model does not know it was denied, and `injectPeerFilePrefix` already
    // has somewhere to say so.
    if (!isReadableRefPath(ref.path)) {
      result.rejected.push(displayName(ref.name));
      continue;
    }
    try {
      const stat = await fs.stat(ref.path);
      if (!stat.isFile() || stat.size > MAX_PEER_FILE_BYTES) {
        result.rejected.push(displayName(ref.name));
        continue;
      }
      const destination = path.join(
        targetDir,
        // A timestamp and a per-message index are not unique across messages:
        // two copied in the same millisecond with the same basename landed on
        // one path, so the second overwrote the first and left the first
        // message's recorded attachment pointing at the second's bytes.
        `peer-${randomUUID().slice(0, 8)}-${safeFileName(ref.name)}`,
      );
      await fs.copyFile(ref.path, destination);
      await fs.chmod(destination, 0o600).catch(() => {});
      result.paths.push(destination);
      result.received += 1;
    } catch (error) {
      runLogger.debug(`[peer-files] Failed to copy ${ref.name}: ${error}`);
      result.rejected.push(displayName(ref.name));
    }
  }
  return result;
}

/**
 * Removes attachments copied for a message this session did not accept.
 *
 * The counterpart to {@link materializePeerFiles}. A held message's files are
 * written on arrival — deferring the copy would re-read the sender's paths
 * minutes later and approve different bytes than were described — so denying,
 * expiring or evicting one has to clean up after itself.
 *
 * Confined to the session's own uploads directory: a path that resolves outside
 * it is ignored rather than followed, so a forged entry cannot turn a denial
 * into an arbitrary unlink. Best-effort and never throws — a leftover file in
 * our own uploads directory is untidy, not unsafe, and is not worth failing a
 * denial over.
 *
 * @returns how many files were removed.
 */
export async function discardPeerFiles(
  paths: readonly string[],
  sessionId: string,
): Promise<number> {
  if (paths.length === 0) return 0;
  const targetDir = path.resolve(getInboundUploadDir(sessionId));
  let removed = 0;

  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== targetDir) {
      runLogger.debug(
        `[peer-files] Refusing to discard ${candidate}: outside ${targetDir}`,
      );
      continue;
    }
    try {
      await fs.unlink(resolved);
      removed += 1;
    } catch (error) {
      runLogger.debug(`[peer-files] Failed to discard ${candidate}: ${error}`);
    }
  }
  return removed;
}

/**
 * Prefixes a body with `@"path"` references so the mention pipeline reads the
 * copied files. Rejected attachments are named explicitly rather than dropped
 * silently, so the model is not led to believe it saw them.
 */
export function injectPeerFilePrefix(
  text: string,
  materialized: MaterializedPeerFiles,
): string {
  if (materialized.received === 0 && materialized.rejected.length === 0) {
    return text;
  }
  const refs = materialized.paths.map((p) => `@"${p}"`).join(' ');
  const note =
    materialized.rejected.length > 0
      ? `\n[Attachments not delivered: ${materialized.rejected.join(', ')}]`
      : '';
  return refs ? `${refs} ${text}${note}` : `${text}${note}`;
}
