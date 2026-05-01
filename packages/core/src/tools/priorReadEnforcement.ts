/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import type { FileReadCache } from '../services/fileReadCache.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';

/**
 * Result of checking whether a tool that mutates an existing file is
 * cleared to proceed based on the session FileReadCache.
 *
 *  - `ok: true` — the model has legitimately read the file in this
 *    session and the on-disk fingerprint still matches.
 *  - `ok: false` — the call must be rejected. `type` selects the
 *    error code; `rawMessage` is the model-facing prose; `displayMessage`
 *    is the short user-facing form.
 *
 * The decision is structured (rather than a `ToolResult` or thrown
 * error) so each caller can route it into the shape its surrounding
 * code expects — a `CalculatedEdit.error` from EditTool's
 * `calculateEdit`, a thrown error from `getConfirmationDetails`, or a
 * `ToolResult` from `execute`.
 */
export type PriorReadDecision =
  | { ok: true }
  | {
      ok: false;
      type: ToolErrorType;
      rawMessage: string;
      displayMessage: string;
    };

/**
 * Verb used in the user-facing prose ("editing" / "overwriting").
 * Kept as a parameter rather than baked into the tool because EditTool
 * and WriteFileTool word their messages slightly differently and we
 * do not want a future divergence to silently weaken the boundary.
 */
export type PriorReadVerb = 'editing' | 'overwriting';

/**
 * Test whether a mutating tool is cleared to proceed against
 * `filePath` based on the session FileReadCache.
 *
 * Approval requires more than `cache.check === 'fresh'`: the recorded
 * read must also have been (a) stamped with `lastReadAt`,
 * (b) `lastReadWasFull` (no offset / limit / pages), and
 * (c) `lastReadCacheable` (i.e. plain text, not binary / image /
 * audio / video / PDF / notebook). Otherwise the model has only seen
 * a slice or a structured proxy of the file, not the bytes a
 * prospective edit would mutate.
 *
 * Stat failures are intentionally non-blocking — the existing write
 * path will surface a richer error than a synthetic "you must read
 * first" message.
 *
 * Note on `recordWrite` interaction: when a tool *creates* a file via
 * Edit (`old_string === ''`) or WriteFile (new path), the FileReadCache
 * `recordWrite` call seeds `lastReadAt` / `lastReadWasFull` /
 * `lastReadCacheable` on the brand-new entry, so a subsequent edit on
 * that same file passes here without an intervening explicit Read.
 * The model authored those bytes; for the purposes of prior-read
 * enforcement that counts as having seen them.
 */
export async function checkPriorRead(
  cache: FileReadCache,
  filePath: string,
  verb: PriorReadVerb,
): Promise<PriorReadDecision> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    return { ok: true };
  }
  const status = cache.check(stats);
  if (
    status.state === 'fresh' &&
    status.entry.lastReadAt !== undefined &&
    status.entry.lastReadWasFull &&
    status.entry.lastReadCacheable
  ) {
    return { ok: true };
  }
  if (status.state === 'stale') {
    const raw =
      `File ${filePath} has been modified since you last read it ` +
      `(mtime or size changed). Re-read it with the ${ToolNames.READ_FILE} ` +
      `tool before ${verb} it to ensure your changes are based on current ` +
      `content.`;
    return {
      ok: false,
      type: ToolErrorType.FILE_CHANGED_SINCE_READ,
      rawMessage: raw,
      displayMessage: `file changed since last read; re-run ${ToolNames.READ_FILE} first.`,
    };
  }
  // unknown OR fresh-but-partial / non-cacheable: require a fresh
  // full text read.
  const raw =
    `File ${filePath} has not been fully read in this session. ` +
    `Use the ${ToolNames.READ_FILE} tool first (without offset / limit ` +
    `/ pages) to load the entire current text content before ${verb} it.`;
  const verbDisplay =
    verb === 'editing' ? 'editing this file' : 'overwriting this file';
  return {
    ok: false,
    type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
    rawMessage: raw,
    displayMessage: `${ToolNames.READ_FILE} required before ${verbDisplay}.`,
  };
}
