/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { posix, win32 } from 'node:path';
import type {
  FileHistorySnapshot,
  SerializedFileHistorySnapshot,
} from '../services/fileHistoryService.js';

/** Capture coordinates use the producer's grammar, never the reader's drive. */
export function getSnapshotPathGrammar(cwd: string): typeof posix {
  return cwd.startsWith('/') ? posix : win32;
}

function normalizeCapturePath(cwd: string, filePath: string): string {
  const grammar = getSnapshotPathGrammar(cwd);
  const normalized = qualifyCapturePathRoot(cwd, filePath);
  if (grammar === posix) {
    // Simplify only separators and interior dots, never parent traversal or
    // the terminal directory requirement. Two leading slashes stay distinct.
    const prefix =
      normalized.startsWith('//') && !normalized.startsWith('///')
        ? '//'
        : normalized.startsWith('/')
          ? '/'
          : '';
    const parts = normalized.split('/');
    const body = parts
      .filter(
        (part, index) =>
          part !== '' && (part !== '.' || index === parts.length - 1),
      )
      .join('/');
    return prefix + body + (body && normalized.endsWith('/') ? '/' : '');
  }
  const root = grammar.parse(normalized).root;
  const trimmed =
    normalized.length > root.length && normalized.endsWith(grammar.sep)
      ? normalized.slice(0, -1)
      : normalized;
  // A Win32 drive letter names the same drive in either case — path.win32
  // resolves `C:\Current` against `c:\Current\new.txt` — while the
  // remaining components keep their case-sensitive spelling (the POSIX
  // grammar has no drive letters, and a `c:`-prefixed POSIX name is an
  // ordinary filename). Fold only the letter so identities, containment
  // and origin equality compare consistently across spellings.
  return grammar === win32 && /^[A-Za-z]:/.test(trimmed)
    ? trimmed[0]!.toUpperCase() + trimmed.slice(1)
    : trimmed;
}

/** Qualify a Win32 rooted path using only its capture drive or UNC share. */
export function qualifyCapturePathRoot(cwd: string, filePath: string): string {
  const grammar = getSnapshotPathGrammar(cwd);
  if (grammar === posix) return filePath;
  const normalized = grammar.normalize(filePath);
  if (grammar === win32 && grammar.parse(normalized).root === '\\') {
    const root = win32.parse(win32.normalize(cwd)).root;
    // join() uses no process/reader drive. An unknown capture root must
    // stay unknown; both identity lookup and executable keys use this rule.
    if (root !== '\\' && win32.isAbsolute(root)) {
      return win32.join(root, normalized);
    }
  }
  return normalized;
}

export function getCapturePath(cwd: string, key: string): string {
  const grammar = getSnapshotPathGrammar(cwd);
  // resolve() supplies the reader's drive for a rooted Win32 path. join()
  // keeps an unknown drive unknown; POSIX backslashes stay literal bytes.
  const captured =
    grammar.isAbsolute(key) || (/^[A-Za-z]:/.test(key) && grammar === win32)
      ? key
      : grammar === posix
        ? cwd + (cwd.endsWith('/') ? '' : '/') + key
        : grammar.join(cwd, key);
  return `${grammar === posix ? 'posix' : 'win32'}:${normalizeCapturePath(cwd, captured)}`;
}

export function areSnapshotOriginsEqual(left: string, right: string): boolean {
  // Identical rooted spellings still do not prove that two unknown drives
  // were the same drive. Never supply that missing provenance from the reader.
  if (
    [left, right].some(
      (cwd) =>
        getSnapshotPathGrammar(cwd) === win32 && win32.parse(cwd).root === '\\',
    )
  )
    return false;
  const originIdentity = (cwd: string): string => {
    if (getSnapshotPathGrammar(cwd) === win32) return getCapturePath(cwd, cwd);
    // An origin names a directory; unlike a file key its trailing directory
    // syntax can be removed, but parent components still cannot be cancelled.
    const trimmed = cwd.replace(/(?:\/\.|\/)+$/g, '');
    const root = cwd.startsWith('//') && !cwd.startsWith('///') ? '//' : '/';
    return getCapturePath(cwd, trimmed || root);
  };
  return originIdentity(left) === originIdentity(right);
}

/**
 * Win32 extended-namespace spellings (`\\?\`, including `\\?\UNC\`, and
 * `\\.\`), detected separator-agnostically: `win32.normalize` folds `/`
 * into `\`, so a mixed spelling like `\\?/UNC/…` still names the
 * namespace once normalized — historical labels may arrive in that
 * shape. The prefix is also fragile under normalization's dot-segment
 * rules (`\\.\foo\..` collapses to the bare `\\.\`), so detection must
 * run on the original spelling, before any shortening or qualification
 * can erase the prefix. The boundary is enforced by refusing such
 * captures, never by re-qualifying them.
 *
 * Exported for FileHistoryService's constructor, which classifies the
 * caller's original cwd spelling under the READER's separator (not the
 * label grammar) before resolve() can erase an incomplete prefix.
 */
export function isWin32NamespacePath(value: string): boolean {
  return /^[\\/][\\/][?.](?:[\\/]|$)/.test(value);
}

/**
 * Drive-relative Win32 coordinate: `C:f` or `C:` (a drive letter not
 * followed by a separator names that drive's own current directory,
 * which this service never recorded), and any input CONTAINING such a
 * component (`.\\C:f`, `C:\\w\\C:f`). On Win32 a colon may belong only
 * to the leading drive root, so an `X:` component after any separator
 * is the same unrepresentable coordinate. The predicate is applied to
 * the caller's original input, before shortening: `relative(cwd,
 * 'C:\\w\\C:f')` would manufacture exactly the bare `C:f` key the
 * direct spelling is refused for, while `normalize('.\\C:f')` keeps the
 * explicit-relative spelling verbatim — classifying after the transform
 * would refuse one spelling of a coordinate and accept its twin.
 *
 * Exported for the same constructor-side classification as
 * `isWin32NamespacePath`.
 */
export function isWin32DriveRelativePath(value: string): boolean {
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return true;
  return value
    .split(/[\\/]/)
    .slice(1)
    .some((component) => /^[A-Za-z]:/.test(component));
}

/**
 * Key-spelling half of the raw-coordinate admission policy: a raw key
 * that names a Win32 namespace or drive-relative coordinate in ANY
 * spelling (`C:f`, `.\\C:f`, `C:\\w\\C:f`, `\\?\…`, `\\.\…`, either
 * separator). Hydration uses this half to keep such singleton keys
 * verbatim — shortening them would manufacture the ordinary spelling of
 * a coordinate the record-time policy refuses.
 */
export function isRefusedWin32KeySpelling(key: string): boolean {
  return isWin32NamespacePath(key) || isWin32DriveRelativePath(key);
}

/**
 * THE raw-coordinate admission policy — one predicate for every
 * admission call-site family. A record names an executable coordinate
 * only when, under the capture grammar of `base`, neither the capture
 * root nor the raw key spells a refused Win32 coordinate. POSIX bases
 * never refuse.
 *
 * Wired into (FileHistoryService unless noted):
 * - capture admission: `trackEdit` (raw input + resolved cwd + the
 *   constructor's original-cwd flag) refuses before any transform;
 * - execution-candidate admission: `collectTrackedFiles` and
 *   `getExecutionPaths` classify each candidate key together with its
 *   capture root, before shortening, so preview (`getTurnDiff`) and
 *   restore (`rewind`/`applySnapshot`) admit identically;
 * - executable baseline selection: `getSnapshotBackup` filters identity
 *   aliases on the raw spelling (`getUnrestorableDiscardedCaptures`
 *   mirrors it), so a refused record can never authorize execution
 *   through an ordinary candidate from another checkpoint;
 * - fold admission: `removeFileHistorySnapshots` (this module, R21)
 *   refuses to graft a deleted endpoint's records into a survivor when
 *   the deleted endpoint's capture root spells a refused coordinate —
 *   see `isRefusedWin32CaptureRoot`.
 *
 * Deliberately NOT admission-filtered (raw records stay preserved):
 * serialize/deserialize round-trips, version reservation
 * (`getBackupsForPath`/`getMaxVersion`), and backup retention
 * (`validateRestoredSnapshots`, `cleanupOrphanedBackups`).
 */
export function isRefusedWin32CaptureCoordinate(
  base: string,
  key: string,
): boolean {
  if (getSnapshotPathGrammar(base).sep !== '\\') return false;
  return (
    isWin32NamespacePath(base) ||
    isWin32DriveRelativePath(base) ||
    isRefusedWin32KeySpelling(key)
  );
}

/**
 * Root half of the policy, applied to a snapshot's capture-root label
 * (the fold's provenance face): the label itself must spell an ordinary
 * Win32 root before its records may be relabeled into another
 * checkpoint. An unlabeled (legacy) snapshot has no root to refuse.
 */
export function isRefusedWin32CaptureRoot(cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  if (getSnapshotPathGrammar(cwd).sep !== '\\') return false;
  return isWin32NamespacePath(cwd) || isWin32DriveRelativePath(cwd);
}

/**
 * Whether a survivor snapshot can prove that a deleted snapshot's backups
 * were captured under the same root: the deleted data is unlabeled (legacy,
 * folds as before), or both snapshots carry cwd labels that resolve to the
 * same directory.
 */
function sameRootProven<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(survivor: T, deleted: T): boolean {
  return (
    deleted.cwd === undefined ||
    (survivor.cwd !== undefined &&
      areSnapshotOriginsEqual(survivor.cwd, deleted.cwd))
  );
}

/**
 * Whether the snapshot's endpoint holds any confirmed capture — a record
 * that actually captured a baseline. A failed capture recorded nothing,
 * and an empty checkpoint even less. Failed records can still reserve
 * versions; deletionEvidence separately protects those non-execution effects.
 */
function hasConfirmedCaptures<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(snapshot: T): boolean {
  return [snapshot.trackedFileBackups, snapshot.diffAfterBackups].some(
    (backups) => Object.values(backups ?? {}).some((backup) => !backup.failed),
  );
}

/** Transfer authority is independent of an existing, possibly disjoint endpoint. */
export function deletionDropsRequiredEndpoint<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(survivor: T, deleted: T): boolean {
  return (
    hasConfirmedCaptures(deleted) &&
    (!sameRootProven(survivor, deleted) ||
      isRefusedWin32CaptureRoot(survivor.cwd) ||
      isRefusedWin32CaptureRoot(deleted.cwd))
  );
}

/**
 * Check exact-record lifetime and current-view baseline, execution and reuse
 * selection. Pointer-free records still reserve physical publish names. These
 * checks do not certify future candidate order after eviction/reload or physical
 * alias independence; keep evidence rather than guessing a lost record harmless.
 */
function deletionEvidence<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(snapshots: readonly T[]): string {
  const records = new Map<string, number>();
  const firstVersions = new Map<string, string>();
  const execution = new Map<string, string>();
  const reusable = new Map<string, string>();
  for (const [index, snapshot] of snapshots.entries()) {
    for (const [mapIndex, backups] of [
      snapshot.trackedFileBackups,
      snapshot.diffAfterBackups,
    ].entries()) {
      const aliases = new Map<
        string,
        Array<{
          value: string;
          failed: boolean;
          file: string | null;
        }>
      >();
      for (const [key, backup] of Object.entries(backups ?? {})) {
        const identity =
          snapshot.cwd === undefined
            ? `legacy:${key}`
            : isRefusedWin32CaptureRoot(snapshot.cwd)
              ? JSON.stringify([snapshot.cwd, key])
              : getCapturePath(snapshot.cwd, key);
        const value = JSON.stringify([
          backup.backupFileName,
          backup.version,
          new Date(backup.backupTime).toISOString(),
          !!backup.failed,
        ]);
        // Equal newest distances preserve presence in EVERY future retained
        // suffix, not just today's window. Moving a reservation nearer the end
        // can be as unsafe as losing it: it changes later publish names.
        records.set(
          JSON.stringify([identity, key, value]),
          snapshots.length - index - 1,
        );
        if (
          snapshot.cwd !== undefined &&
          isRefusedWin32CaptureCoordinate(snapshot.cwd, key)
        )
          continue;
        if (backup.version === 1) {
          const first = firstVersions.get(identity);
          if (first !== undefined && first !== value)
            throw new Error(
              'Deleting ambiguous first-version history is not supported.',
            );
          firstVersions.set(identity, value);
        }
        const origin =
          snapshot.cwd === undefined
            ? 'legacy'
            : getCapturePath(snapshot.cwd, '');
        execution.set(JSON.stringify([origin, identity]), key);
        const entries = aliases.get(identity) ?? [];
        entries.push({
          value,
          failed: !!backup.failed,
          file: backup.backupFileName,
        });
        aliases.set(identity, entries);
      }
      for (const [identity, entries] of aliases) {
        const confirmed = entries.filter((entry) => !entry.failed);
        const selected = confirmed[0] ?? entries[0]!;
        const conflict = confirmed.some(
          (entry) => entry.value !== selected.value,
        );
        if (conflict)
          throw new Error(
            'Deleting conflicting file-history aliases is not supported.',
          );
        const selection = selected.value;
        if (
          snapshot === snapshots.at(-1) &&
          mapIndex === 0 &&
          !selected.failed &&
          selected.file !== null
        )
          reusable.set(identity, selection);
      }
    }
  }
  return JSON.stringify([
    [...records].sort(),
    [...execution],
    [...reusable].sort(),
  ]);
}

export function foldFileHistoryEndpoint<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(survivor: T, deleted: T, preserveExistingEndpoint: boolean): T {
  if (
    (preserveExistingEndpoint && survivor.diffAfterBackups) ||
    !sameRootProven(survivor, deleted) ||
    isRefusedWin32CaptureRoot(survivor.cwd) ||
    isRefusedWin32CaptureRoot(deleted.cwd)
  ) {
    return survivor;
  }
  // The closest pre-edit capture wins. Later endpoints supply baselines
  // for additional files, including records retained by earlier deletions.
  const endpoint = {
    // Insert in original candidate order, then apply baseline precedence.
    ...survivor.diffAfterBackups,
    ...deleted.trackedFileBackups,
    ...deleted.diffAfterBackups,
    ...deleted.trackedFileBackups,
    ...survivor.diffAfterBackups,
  };
  return Object.keys(endpoint).length > 0
    ? { ...survivor, diffAfterBackups: endpoint }
    : survivor;
}

export function removeFileHistorySnapshots<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(snapshots: readonly T[], removedPromptIds: ReadonlySet<string>): T[] {
  if (!snapshots.some((snapshot) => removedPromptIds.has(snapshot.promptId)))
    return [...snapshots];
  const folded = [...snapshots];
  // Work backwards so a consecutive deleted run carries all of its
  // endpoints through each provenance-checked link to the survivor.
  for (let index = folded.length - 2; index >= 0; index--) {
    const survivor = folded[index]!;
    const deleted = folded[index + 1]!;
    if (removedPromptIds.has(deleted.promptId)) {
      if (deletionDropsRequiredEndpoint(survivor, deleted)) {
        throw new Error(
          'Deleting file history would discard a checkpoint whose capture directory cannot be proven.',
        );
      }
      folded[index] = foldFileHistoryEndpoint(
        survivor,
        deleted,
        !removedPromptIds.has(survivor.promptId),
      );
    }
  }
  const retained = folded.filter(
    (snapshot) => !removedPromptIds.has(snapshot.promptId),
  );
  if (deletionEvidence(snapshots) !== deletionEvidence(retained)) {
    throw new Error(
      'Deleting file history would discard recovery evidence or change backup version reservations; refusing to keep file restoration safe.',
    );
  }
  return retained;
}
