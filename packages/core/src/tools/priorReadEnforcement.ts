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
 * Error thrown by `getConfirmationDetails()` when it needs to surface
 * a structured `ToolErrorType` to the scheduler instead of letting
 * the throw collapse into a generic `UNHANDLED_EXCEPTION`. Originally
 * introduced for prior-read enforcement (hence the file location)
 * but now also carries other content-derived `calculateEdit` errors
 * — `EDIT_NO_OCCURRENCE_FOUND`, `EDIT_EXPECTED_OCCURRENCE_MISMATCH`,
 * `EDIT_NO_CHANGE`, `ATTEMPT_TO_CREATE_EXISTING_FILE` — through the
 * confirmation path so they keep their proper error code instead of
 * being reported as "unhandled exception".
 *
 * Caught by `coreToolScheduler` via the `errorType` instance field.
 *
 * Naming note: kept generic (`StructuredToolError`) rather than
 * `PriorReadEnforcementError` so the name matches the broader set of
 * `ToolErrorType` values it actually carries — an oncall engineer
 * seeing this in a log paired with `edit_no_occurrence_found` should
 * not have to wonder what prior-read has to do with it.
 */
export class StructuredToolError extends Error {
  override readonly name = 'StructuredToolError';
  constructor(
    message: string,
    readonly errorType: ToolErrorType,
  ) {
    super(message);
  }
}

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
 * Options for {@link checkPriorRead}.
 *
 *  - `expectExisting`: when true, an `ENOENT` from the stat call
 *    rejects with `FILE_CHANGED_SINCE_READ` instead of returning
 *    `ok: true`. Use this for the post-read and pre-write recheck
 *    calls — at those points the model has already committed to
 *    mutating an existing path, so a disappeared file is a stale-read
 *    drift, not a "the file genuinely never existed" disappearance
 *    race. The default (`expectExisting: false`) is the pre-read
 *    behaviour: ENOENT means "go ahead and create".
 *
 * **Do not re-introduce a `requireFullRead` (or any "stricter for
 * WriteFile than Edit") option here.** PR #3932 added one with the
 * rationale that WriteFile's overwrite path needs more evidence than
 * Edit's `old_string`-matched in-place change; PR #4002 removed it
 * because the truncate-tool-output limit makes "fully read" an
 * impossible precondition on files larger than the limit, producing
 * the deadlock issue #3945 reported. The contract now matches Claude
 * Code's `readFileState`: any prior read clears enforcement for both
 * tools, the mtime/size drift check is the safety net.
 *
 * There is no built-in "stricter than this" mode. `fileReadCacheDisabled:
 * true` is the OPPOSITE — it bypasses the cache (and thus prior-read
 * enforcement) entirely, ceding the safety net to whatever
 * application-level overwrite-protection the operator wires up
 * (lockfiles, content hashing, atomic temp-file rename, etc.). Users
 * who want STRICTER built-in enforcement than the residual #2499 risk
 * accepts have no flag here today; file a feature request.
 *
 * See the docstring on {@link checkPriorRead} for the full rationale
 * and the residual #2499 risk it accepts.
 */
export interface CheckPriorReadOptions {
  expectExisting?: boolean;
}

/**
 * Test whether a mutating tool is cleared to proceed against
 * `filePath` based on the session FileReadCache.
 *
 * Approval requires more than `cache.check === 'fresh'`: the recorded
 * read must also have been (a) stamped with `lastReadAt` and
 * (b) `lastReadCacheable` (i.e. plain text, not binary / image /
 * audio / video / PDF / notebook — those return a structured payload
 * the Edit / WriteFile tools cannot mutate as text).
 *
 * `lastReadCacheable` is purely about content type, not completeness.
 * A truncated or partial text read still records `lastReadCacheable:
 * true` because the bytes the model saw were text. Whether the model
 * has seen *every* byte is recorded on `lastReadWasFull` for the
 * Read fast-path; we do NOT consult it for enforcement, because the
 * truncate-tool-output limit makes "fully read" an impossible
 * precondition on files larger than the limit (issue #3945).
 * Aligning with Claude Code's `readFileState`: any prior read clears
 * enforcement for both Edit and WriteFile; the mtime/size drift
 * check above is the only gate that distinguishes "the model has
 * seen current bytes" from "the model has seen older bytes", and it
 * fires identically for both tools. Issue #2499 (model hallucinates
 * unread bytes on overwrite) is the residual risk this stance
 * accepts, mitigated by the drift check. There is no built-in
 * stricter mode — `fileReadCacheDisabled: true` is an OPT-OUT (it
 * bypasses enforcement entirely so application-level locking can
 * take over), not an opt-in to anything stricter.
 *
 * Stat policy: `ENOENT` means the path disappeared between the
 * caller's `fileExists` check and now — a disappearance race that is
 * harmless for our purposes (the downstream write will resurface the
 * absence as its own error). Any other stat error (`EACCES`, `EBUSY`,
 * NFS hiccup, …) is fail-closed: returning `ok: true` would re-open
 * the blind-write path the helper exists to block, since a transient
 * stat failure does not imply the subsequent read/write will fail.
 *
 * Note on `recordWrite` interaction: when a tool *creates* a file via
 * Edit (`old_string === ''`) or WriteFile (new path), the FileReadCache
 * `recordWrite` call seeds `lastReadAt` / `lastReadCacheable` on the
 * brand-new entry, so a subsequent edit on that same file passes here
 * without an intervening explicit Read. The model authored those bytes;
 * for the purposes of prior-read enforcement that counts as having
 * seen them.
 */
export async function checkPriorRead(
  cache: FileReadCache,
  filePath: string,
  verb: PriorReadVerb,
  options: CheckPriorReadOptions = {},
): Promise<PriorReadDecision> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      if (options.expectExisting) {
        // Post-read or pre-write: the file existed at planning time
        // but disappeared before this recheck. That is not a benign
        // disappearance race — it is the original target going away
        // from under the model. Reject so the caller does not
        // silently fall through to the new-file path with stale
        // bytes.
        const raw =
          `File ${filePath} disappeared after the model read it ` +
          `(stat now returns ENOENT). Re-read with the ${ToolNames.READ_FILE} ` +
          `tool — the path may have been deleted or moved — before ` +
          `retrying ${verb} it.`;
        return {
          ok: false,
          type: ToolErrorType.FILE_CHANGED_SINCE_READ,
          rawMessage: raw,
          displayMessage: `file disappeared after last read; re-run ${ToolNames.READ_FILE} first.`,
        };
      }
      // Pre-read disappearance race vs the caller's fileExists check.
      // Let the downstream write path surface the absence — synthesising
      // a "you must read first" message here would be misleading.
      return { ok: true };
    }
    // Any other stat failure: fail closed. We cannot prove the file
    // has been read; treating that as approval would silently bypass
    // enforcement on transient metadata errors that don't prevent
    // the subsequent write from succeeding. Use a distinct
    // PRIOR_READ_VERIFICATION_FAILED code (rather than
    // EDIT_REQUIRES_PRIOR_READ) because the model may have
    // legitimately read this file — we just cannot verify it.
    // Operators monitoring on error codes can route the two
    // populations separately.
    const raw =
      `Could not stat ${filePath} to verify prior read (${code ?? 'unknown error'}). ` +
      `Re-read with the ${ToolNames.READ_FILE} tool, then retry ${verb} it.`;
    const verbDisplay =
      verb === 'editing' ? 'editing this file' : 'overwriting this file';
    return {
      ok: false,
      type: ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      rawMessage: raw,
      displayMessage: `cannot verify prior read of ${filePath}; re-run ${ToolNames.READ_FILE} before ${verbDisplay}.`,
    };
  }
  // Directory and other non-regular paths get dedicated rejections
  // with structured ToolErrorType codes — never `ok: true`. Falling
  // through to readTextFile would either block (FIFO),
  // over-allocate (/dev/urandom), or throw a plain Error that the
  // confirmation path collapses into UNHANDLED_EXCEPTION (e.g.
  // EISDIR on WriteFile.getConfirmationDetails, which never reaches
  // execute()'s explicit EISDIR mapping).
  if (stats.isDirectory()) {
    const verbBare = verb === 'editing' ? 'edit' : 'overwrite';
    const raw =
      `${filePath} is a directory. The Edit / WriteFile tools only ` +
      `operate on regular files. Use a different mechanism (e.g. ` +
      `the shell tool) if you need to ${verbBare} the contents of ` +
      `this directory.`;
    return {
      ok: false,
      type: ToolErrorType.TARGET_IS_DIRECTORY,
      rawMessage: raw,
      displayMessage: `path is a directory; cannot ${verbBare} via this tool.`,
    };
  }
  if (!stats.isFile()) {
    const verbBare = verb === 'editing' ? 'edit' : 'overwrite';
    const raw =
      `${filePath} is a FIFO / socket / character or block device. ` +
      `The Edit / WriteFile tools only operate on regular files; ` +
      `the ${ToolNames.READ_FILE} tool also rejects these targets. ` +
      `Use a different mechanism (e.g. shell tool with the appropriate ` +
      `command) if you need to ${verbBare} this path.`;
    return {
      ok: false,
      type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      rawMessage: raw,
      displayMessage: `special file; cannot ${verbBare} via this tool.`,
    };
  }
  const status = cache.check(stats);
  if (
    status.state === 'fresh' &&
    status.entry.lastReadAt !== undefined &&
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
  // Differentiate "fresh but the recorded read was non-cacheable"
  // (binary / image / audio / video / PDF / notebook) from "never
  // read at all". Telling the model to "re-read with read_file" for
  // a binary file would loop forever because that read would also
  // leave `lastReadCacheable === false`.
  if (
    status.state === 'fresh' &&
    status.entry.lastReadAt !== undefined &&
    !status.entry.lastReadCacheable
  ) {
    // Both raw and displayMessage use the bare verb (`edit` /
    // `overwrite`) rather than the gerund — the noun phrase
    // "cannot editing via this tool" would be ungrammatical, and
    // both strings need to read correctly on the EditTool path
    // (where "overwrite" would be the wrong verb for an in-place
    // edit) and the WriteFileTool path (where "overwrite" is
    // correct).
    const verbBare = verb === 'editing' ? 'edit' : 'overwrite';
    const raw =
      `File ${filePath} is a binary / image / audio / video / PDF / ` +
      `notebook payload that the ${ToolNames.READ_FILE} tool returns ` +
      `as a structured value rather than as plain text. The Edit / ` +
      `WriteFile tools cannot mutate that payload safely — re-reading ` +
      `it would not change this. Use a different mechanism (e.g. shell ` +
      `tool with a binary-aware writer) if you need to ${verbBare} it.`;
    return {
      ok: false,
      type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      rawMessage: raw,
      displayMessage: `non-text payload; cannot ${verbBare} via this tool.`,
    };
  }
  // unknown: the model has never read this file in this session.
  const verbBare = verb === 'editing' ? 'edit' : 'overwrite';
  const verbDisplay =
    verb === 'editing' ? 'editing this file' : 'overwriting this file';
  // Tool-specific guidance on partial reads. Edit can use a partial
  // read (the model only needs to have seen `old_string`-bearing
  // bytes; the rest of the file passes through untouched). WriteFile
  // OVERWRITES — the model is replacing the entire file, so a
  // partial read leaves any unseen bytes as collateral damage. The
  // mtime/size drift check still catches the worst case (#2499
  // hallucinated-bytes risk), but recommending a partial read here
  // would actively encourage the foot-gun.
  const partialReadGuidance =
    verb === 'editing'
      ? `(a partial read with offset / limit is fine — you only need to have seen the bytes you intend to ${verbBare})`
      : `(read the full file — overwriting replaces every byte, so any unseen bytes would be discarded)`;
  const raw =
    `File ${filePath} has not been read in this session. ` +
    `Use the ${ToolNames.READ_FILE} tool first to load the current ` +
    `content ${partialReadGuidance} before ${verb} it.`;
  return {
    ok: false,
    type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
    rawMessage: raw,
    displayMessage: `${ToolNames.READ_FILE} required before ${verbDisplay}.`,
  };
}
