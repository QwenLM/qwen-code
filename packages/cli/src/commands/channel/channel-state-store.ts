import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFileSync,
  hashDaemonWorkspace,
  Storage,
} from '@qwen-code/qwen-code-core';
import {
  canonicalizeWorkspacePath,
  sanitizeLogText,
} from '@qwen-code/channel-base';
import { writeStderrLineBestEffort } from '../../utils/stdioHelpers.js';

/**
 * Per-channel runtime state persisted by the channel service. `--channel all`
 * restores every configured channel whose state is not `stopped`; channels
 * without a recorded state are treated as `active`.
 */
export type ChannelRuntimeState = 'active' | 'stopped';

const STORE_VERSION = 1;

interface ChannelStateFile {
  version: typeof STORE_VERSION;
  channels: Record<string, ChannelRuntimeState>;
  /**
   * The legacy global map at the last adoption sync (#8975): lets a later
   * start tell legacy entries written AFTER this workspace adopted (a
   * mixed-version machine where an old-format pidfile routes a stop to the
   * legacy global file) apart from entries already adopted — only the
   * changed ones are merged, so old legacy stops can never override an
   * explicit restart recorded in this workspace's own map.
   */
  adoptedLegacy?: Record<string, ChannelRuntimeState>;
  /**
   * The legacy file's `entryEpochs` at the last adoption sync (R15-15):
   * the per-entry baseline for re-stop detection. A content diff alone
   * cannot see a re-stop — re-stopping an already-stopped channel
   * re-asserts the same entry, the snapshot matches, and the merge loop
   * would drop the re-stop (the explicitly re-stopped channel resurrects
   * on `--channel all`). Re-stop detection is PER-ENTRY: `applyChange`
   * stamps each entry it names with the write's new `generation` value
   * (its epoch), so a snapshot-identical entry is re-applied only when
   * ITS OWN epoch moved past the epoch recorded here — exactly the
   * "some write named this entry after adoption" signal. The global
   * generation arithmetic this replaced (see `adoptedLegacyGeneration`)
   * assumed each entry added since the snapshot accounts for exactly one
   * generation step, but writes bump generation by the number of entries
   * named — repeated writes of ONE new entry inflated the delta and
   * re-applied snapshot-identical entries over an explicit restart
   * recorded in the target (an unrelated workspace's activity re-stopping
   * a channel nobody stopped, R15-15). Absent when the legacy file had
   * no epochs at sync time; adoption then falls back to the global
   * arithmetic for one sync (see `adoptedLegacyGeneration`).
   */
  adoptedLegacyEntryEpochs?: Record<string, number>;
  /**
   * The legacy file's `generation` at the last adoption sync (R11-14).
   * Two uses, in priority order:
   *
   * 1. Lineage-break signal (R15-15): a legacy generation LOWER than
   *    this watermark means the file was deleted/recreated since the
   *    snapshot (user cleanup, backup restore — the counter resets), so
   *    no arithmetic on the new counter can see pre-break re-stops. The
   *    sync treats EVERY snapshot-identical entry as re-stopped — the
   *    fail-safe over-stop direction the R10-5 comment accepts (an
   *    under-start is one explicit start away; a resurrected explicitly
   *    stopped channel is the #8975 regression). The mirror (a
   *    higher-generation replacement with content-equal entries) is
   *    caught per-entry when epochs exist and by the arithmetic below
   *    when they do not.
   * 2. Fallback re-stop arithmetic for legacy files WITHOUT `entryEpochs`
   *    (pre-epoch writers, tolerated): every store write bumps
   *    `generation` BY THE NUMBER OF ENTRIES WRITTEN (R14), so when the
   *    generation moved MORE than the number of entries added since the
   *    snapshot, at least one write touched an entry that was NOT new —
   *    a re-stop — and snapshot-identical entries are re-applied even
   *    when a batched stop mixes the re-stop with a new entry in a
   *    single write (the production shape: `recordStoppedChannels` stops
   *    a service's whole channel list in ONE `setMany`; a per-rewrite
   *    bump of 1 made that mixed batch indistinguishable from a pure new
   *    stop, dropping the re-stop, R13-10). This arithmetic is exact
   *    only when every post-snapshot write names exclusively NEW entries
   *    — the epoch map above is the precise replacement when available
   *    (R15-15). A pure new stop keeps `delta == added` (no rewrite
   *    detected — the comparison cannot relax to `>=`). A
   *    moved-but-content-equal generation is the zero-added-entries
   *    special case.
   *
   * Re-applying is limited to snapshot-identical entries, so an explicit
   * restart recorded since still wins over a stale adopted stop (the
   * R9-3 direction stays closed). The mtime-based watermark the
   * generation replaced was unreliable in both directions: coarse-mtime
   * filesystems (exFAT/FAT32 2 s, some NFS/SMB 1 s) hid real rewrites,
   * and any external `touch`/backup re-materialization with unchanged
   * bytes forged one. Generation lives in the content, so neither pole
   * exists (R11-14). `-1` records a legacy file without generation
   * (pre-feature, tolerated); absent means this file predates watermark
   * recording and adoption keeps the content-only diff for one sync.
   */
  adoptedLegacyGeneration?: number;
  /**
   * Monotonic write counter stamped by every `applyChange` write: files
   * created here start at 0, every write bumps it BY THE NUMBER OF
   * ENTRIES THE WRITE SETS (a delete-only prune bumps by 1) (R11-14,
   * R14). Adoption diffs the legacy file's generation against the
   * recorded `adoptedLegacyGeneration` watermark to see re-stops the
   * content diff cannot — the per-entry bump is what makes a batched
   * re-stop-plus-new-stop write visible there (see
   * `adoptedLegacyGeneration`). External mtime bumps cannot forge it and
   * coarse filesystem granularity cannot hide it.
   */
  generation?: number;
  /**
   * Per-entry write epoch: for each channel entry, the `generation` value
   * of the LAST write that named it (R15-15). Stamped by every
   * `applyChange` write for exactly the entries the write names — the
   * legacy writer (`recordStoppedChannels`' no-workspace fallback) writes
   * the stopping service's channel list, NOT an echo of the whole stored
   * map, so per-entry epochs are the only precise "written after
   * adoption" signal. Adoption compares a snapshot-identical entry's
   * current epoch against `adoptedLegacyEntryEpochs` to detect re-stops
   * the content diff cannot see; entries without an epoch baseline on
   * either side are not re-applied (an unprovable re-stop must not
   * override an explicit restart, the R9-3 direction).
   */
  entryEpochs?: Record<string, number>;
}

/**
 * State file used by the standalone `qwen channel` commands. Standalone
 * channel configuration is loaded per workspace, so the state is scoped the
 * same way: pass the workspace the service was started from. Without a
 * workspace (e.g. a pidfile written by an older release) the write falls
 * back to the legacy global file; `adoptLegacyChannelState` seeds the
 * workspace state file from it on the next start so those stops are honored.
 */
export function channelRuntimeStatePath(workspaceCwd?: string): string {
  if (!workspaceCwd) {
    return path.join(
      Storage.getGlobalQwenDir(),
      'channels',
      'channel-state.json',
    );
  }
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'standalone',
    // Canonicalize before hashing: spelling variants of the same directory
    // (Windows case-insensitivity, symlinks, trailing separators) must map
    // to ONE state file, or a stop recorded under one spelling is silently
    // lost when the user re-enters as another and the next `--channel all`
    // resurrects the explicitly stopped channels. The daemon side derives
    // its state path from a canonicalized workspace (daemon-worker
    // canonicalizeWorkspace); canonicalizeWorkspacePath is the ENOENT/
    // error-tolerant mirror for this never-fails store (#8975). The
    // feature and its files are new, so the identity change migrates
    // nothing.
    hashDaemonWorkspace(canonicalizeWorkspacePath(workspaceCwd)),
    'channel-state.json',
  );
}

/**
 * chmod one already-created directory level to 0o700, tolerating
 * filesystems without POSIX modes but NOT a concurrent deletion: an
 * ENOENT here means the level vanished between its mkdir (or the
 * existsSync walk) and this chmod. Recreate the level and retry the
 * chmod ONCE; a second ENOENT is a real racing deletion and rethrows,
 * so the writer fails closed with the true cause instead of the bare
 * catch silently swallowing it and proceeding to a guaranteed ENOENT
 * state-file write (doudouOUC C3).
 */
function chmodStateLevel(level: string): void {
  try {
    chmodSync(level, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Windows and some filesystems do not implement POSIX modes.
      return;
    }
    try {
      mkdirSync(level, { mode: 0o700 });
    } catch (mkdirError) {
      // Concurrent recreation is fine; anything else (including the
      // parent-vanished ENOENT) surfaces to the writer's fail-closed
      // boundary.
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw mkdirError;
      }
    }
    try {
      chmodSync(level, 0o700);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw retryError;
      }
      // Non-POSIX filesystem again — tolerate.
    }
  }
}

/**
 * Create a state file's directory tree defeating a restrictive umask at
 * EVERY level (R14-24). A recursive `mkdirSync(..., { mode: 0o700 })`
 * masks each created level with the process umask; under a umask that
 * strips owner-execute (0o177/0o133) each new level lands at 0o600 (no
 * traverse bit), so the mkdir of the SECOND missing level throws EACCES
 * before any leaf chmod can run — the first scoped stop never persists,
 * and the first level stays 0o600 so every retry fails identically until
 * a manual chmod. Walk up to the deepest existing ancestor, create each
 * missing level one at a time, and chmod 0o700 immediately after each
 * mkdir. Shared by the store writes and legacy adoption, which mkdir the
 * same shapes (`channels/standalone/<hash>`, `channels/daemon/<hash>`).
 */
function prepareStateDirectory(dir: string): void {
  const missing: string[] = [];
  let cursor = dir;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // filesystem root
    cursor = parent;
  }
  for (const level of missing.reverse()) {
    try {
      mkdirSync(level, { mode: 0o700 });
    } catch (error) {
      // Concurrent creation between existsSync and mkdirSync is fine.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    chmodStateLevel(level);
  }
  chmodStateLevel(dir);
}

/**
 * Migration for stops recorded to the legacy global file, which a stop
 * uses when the pidfile carries no workspace (an older release's service,
 * or a downgrade/parallel install on a mixed-version machine sharing
 * ~/.qwen). The standalone read path is always workspace-scoped, so
 * without adoption the recorded stops would be silently lost and the
 * channels resurrected by the next `--channel all` start (#8975).
 *
 * First adoption seeds the workspace file from the legacy map and records
 * it as the `adoptedLegacy` snapshot; every later start diffs the current
 * legacy map against that snapshot and merges only the entries that
 * changed since — stops written to the legacy file AFTER the workspace
 * file already exists (the one-shot existsSync guard used to drop them
 * silently, resurrecting explicitly stopped channels). Entries already in
 * the snapshot are NOT re-applied: the legacy file is deliberately kept
 * forever (a later-starting workspace adopts the same stops), so blindly
 * re-merging it would override an explicit restart recorded in this
 * workspace's own map with the stale old stop. Exception: a rewrite that
 * re-asserts a snapshot-identical entry (a re-stop of an already-stopped
 * channel) is invisible to the content diff, so the sync also records the
 * legacy file's generation counter and per-entry write epochs; an entry
 * is re-applied when its OWN epoch moved past the recorded snapshot
 * epoch, with a fallback to the global generation arithmetic for legacy
 * files without epochs and a fail-safe re-apply of every
 * snapshot-identical entry when the generation REGRESSED (lineage break:
 * file deleted/recreated, counter reset) (#8975, R11-14, R15-15).
 * Entries that
 * disappeared from the legacy file are likewise never propagated: it
 * carries no workspace attribution, so its loss or rewrite must not
 * destroy this workspace's records. Best-effort — any failure only loses
 * this sync and warns, matching the store's never-fails contract (#8975).
 */
export function adoptLegacyChannelState(workspaceCwd: string): void {
  const targetPath = channelRuntimeStatePath(workspaceCwd);
  const legacyPath = channelRuntimeStatePath();
  if (!existsSync(legacyPath)) return;
  let legacyChannels: Record<string, ChannelRuntimeState>;
  let legacyGeneration: number;
  let legacyEntryEpochs: Record<string, number> | undefined;
  try {
    // The generation watermark lives INSIDE the content, so one
    // readFileSync observes one consistent (generation, channels) pair by
    // construction — the split stat+read window the old mtime watermark
    // needed (and its fd-pinning, R11-2) is gone: a rewrite racing this
    // adoption simply lands in the NEXT sync's diff (R11-14).
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = parseStateFile(raw);
    // A legacy file that reads successfully but no longer parses is
    // UNKNOWN content, not empty: coercing it to an empty map would
    // persist that emptiness as the new adoptedLegacy baseline,
    // destroying the recorded snapshot — when the legacy content is
    // later restored, the sync sees an empty snapshot and merges the
    // stale legacy stops over explicit restarts recorded since (the
    // R9-3 direction the contract keeps closed). Skip this sync like
    // the target-read failure path: adoption runs on every start, so
    // the next one retries once the condition clears (#8975, R17-1).
    if (!parsed) {
      writeStderrLineBestEffort(
        `[Channel] Warning: could not parse legacy channel state file ${legacyPath}; legacy adoption skipped for this start.`,
      );
      return;
    }
    legacyChannels = parsed.channels ?? Object.create(null);
    // A generation-less legacy file predates the watermark (tolerated):
    // record -1 so the NEXT rewrite — the first one stamping a real
    // generation — is visible as a change (R11-14).
    legacyGeneration = parsed.generation ?? -1;
    // Absent on pre-epoch legacy files: adoption falls back to the
    // generation arithmetic for this sync (R15-15).
    legacyEntryEpochs = parsed.entryEpochs;
  } catch {
    // ENOENT can still race the existsSync above; anything else is a real
    // open/read failure (EACCES/EIO/EISDIR on a shared ~/.qwen): the
    // unadopted stops may resurrect on the next start, so leave a trace
    // (#8975).
    writeStderrLineBestEffort(
      `[Channel] Warning: could not read legacy channel state file ${legacyPath}; recorded stops may not be honored.`,
    );
    return;
  }

  let target: ParsedStateFile | undefined;
  let targetExisted = false;
  if (existsSync(targetPath)) {
    targetExisted = true;
    try {
      target = parseStateFile(readFileSync(targetPath, 'utf-8'));
    } catch (error) {
      // ENOENT can still race the existsSync above — the file vanished,
      // so proceed as a first adoption. Any other read failure means the
      // content is UNKNOWN, not corrupt: reseeding from the legacy map
      // below would rebuild the file from an empty view and permanently
      // destroy this workspace's recorded stops and adoption snapshot.
      // Abort this sync with a trace; adoption runs on every start, so
      // the next one retries once the condition clears (#8975).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        writeStderrLineBestEffort(
          `[Channel] Warning: could not read channel state file ${targetPath}; legacy adoption skipped for this start.`,
        );
        return;
      }
      targetExisted = false;
      target = undefined;
    }
  }
  // A corrupt target is reseeded from the legacy map below, which makes
  // it valid forever after — no later read/prune can warn about the
  // discarded records, so the discard itself must (#8975).
  if (targetExisted && target === undefined) {
    writeStderrLineBestEffort(
      `[Channel] Warning: could not read channel state file ${targetPath}; treating all channels as active.`,
    );
  }

  const channels: Record<string, ChannelRuntimeState> =
    target?.channels ?? Object.create(null);
  const snapshot = target?.adoptedLegacy;
  const adoptedGeneration = target?.adoptedLegacyGeneration;
  const snapshotEpochs = target?.adoptedLegacyEntryEpochs;
  // A rewrite of the legacy file re-asserts snapshot-identical entries —
  // a re-stop the plain content diff cannot see (a re-stop of an
  // already-stopped channel re-asserts the same entry). Detection runs in
  // three tiers (R15-15):
  //
  // 1. Lineage break: a generation LOWER than the recorded watermark
  //    means the file was deleted/recreated (counter reset), so no
  //    arithmetic on the new counter can see pre-break re-stops — every
  //    snapshot-identical entry is fail-safe re-stopped. The mirror
  //    (higher-generation replacement) is caught by tiers 2/3.
  // 2. Per-entry epochs (legacy files stamped by this PR's writer): a
  //    snapshot-identical entry is a re-stop exactly when ITS OWN epoch
  //    moved past the epoch recorded at snapshot time. Precise under the
  //    real writer, which writes the stopping service's channel list (NOT
  //    an echo of the whole stored map) and bumps generation BY THE
  //    NUMBER OF ENTRIES NAMED — so the tier-3 arithmetic alone inflates
  //    when one NEW entry is written repeatedly (delta 2, added 1) and
  //    would re-apply snapshot-identical entries over an explicit restart
  //    recorded in the target (an unrelated workspace's activity
  //    re-stopping a channel nobody stopped).
  // 3. Fallback arithmetic for legacy files WITHOUT epochs (pre-epoch
  //    writers, tolerated): every entry added since the snapshot accounts
  //    for exactly one generation step, so when the generation moved MORE
  //    than the number of entries added, at least one write touched a
  //    non-new (snapshot-identical) entry in between — a re-stop that the
  //    plain content diff cannot see (a concurrent new stop in the same
  //    batched write otherwise masks it, resurrecting the re-stopped
  //    channel on the next `--channel all` — the exact #8975 regression,
  //    R13-10). A pure new stop keeps `delta == added` and is NOT a
  //    rewrite (the comparison cannot relax to `>=`, or a plain new stop
  //    would re-apply snapshot-identical entries over an explicit restart
  //    — the R9-3 direction). An entry-set-UNCHANGED rewrite is the
  //    special case where the delta exceeds zero added entries. The
  //    watermark is unified across the `-1` (pre-generation / externally
  //    materialized) boundary: the first stamped write after adoption
  //    lands at `g - (-1)` = the number of entries written, which is the
  //    SAME per-entry semantics as the `>= 0` branch. The old
  //    content-only diff at `-1` could only see entry-set-UNCHANGED
  //    rewrites, so a batched re-stop + new stop at that boundary was
  //    dropped and the re-stopped channel resurrected (#8975, R14).
  //
  // Generation and epochs live in the content, so external mtime bumps
  // (touch, backup restore) cannot forge the signal and coarse-mtime
  // filesystems cannot hide a real rewrite.
  const addedSinceSnapshot = snapshot
    ? Object.keys(legacyChannels).filter((name) => snapshot[name] === undefined)
        .length
    : 0;
  const generationRegressed =
    snapshot !== undefined &&
    adoptedGeneration !== undefined &&
    legacyGeneration < adoptedGeneration;
  const epochsUsable =
    legacyEntryEpochs !== undefined && snapshotEpochs !== undefined;
  const legacyRewrittenByArithmetic =
    snapshot !== undefined &&
    adoptedGeneration !== undefined &&
    !epochsUsable &&
    adoptedGeneration !== legacyGeneration &&
    legacyGeneration - adoptedGeneration > addedSinceSnapshot;
  // Per-entry re-stop predicate over snapshot-identical entries.
  const reStopped = (name: string): boolean => {
    if (generationRegressed) return true;
    if (epochsUsable) {
      const current = legacyEntryEpochs?.[name];
      const adopted = snapshotEpochs?.[name];
      // No baseline on either side: unprovable — an inferred re-stop
      // must not override an explicit restart (the R9-3 direction).
      // One-sided (current epoch present, adopted baseline absent): the
      // entry was first stamped AFTER adoption, i.e. a post-adoption
      // write named it — a re-asserted stop over any explicit restart
      // recorded since. Honoring it is fail-safe (an under-start is one
      // explicit start away) and self-stabilizing: the detected rewrite
      // forces a write that records the entry's epoch baseline, after
      // which normal comparison resumes (R20-1).
      return (
        current !== undefined && (adopted === undefined || current > adopted)
      );
    }
    return legacyRewrittenByArithmetic;
  };
  const merged: string[] = [];
  // A corrupt/unreadable target is treated as empty by design, so reseed
  // it from the whole legacy map; a valid target without a snapshot
  // predates snapshot recording and cannot be diffed — baseline it
  // without merging, or the already-adopted (stale) legacy stops would
  // override explicit restarts made since.
  if (!targetExisted || target === undefined || snapshot !== undefined) {
    for (const [name, state] of Object.entries(legacyChannels)) {
      if (snapshot?.[name] !== state) {
        channels[name] = state;
        merged.push(name);
      } else if (reStopped(name) && channels[name] !== state) {
        // Re-stop detected since the snapshot (see the tier list above):
        // a write named this entry after adoption, re-asserting it. Treat
        // the re-assertion as a stop event over an explicit restart
        // recorded since (R10-5).
        // Accepted trade-off: the lineage-break tier (and the no-epoch
        // arithmetic it falls back to) cannot say WHICH entry the stop
        // touched, so it re-stops explicitly restarted siblings too — the
        // fail-safe direction (an under-start is one explicit start away;
        // a resurrected explicitly stopped channel is the #8975
        // regression) (#8975).
        channels[name] = state;
        merged.push(name);
      }
    }
  }
  // A content-preserving rewrite signal (a detected re-stop that merged
  // nothing because the target already matches): the write still runs to
  // advance the recorded watermarks, or every later sync re-detects it.
  const rewriteSignal =
    generationRegressed ||
    legacyRewrittenByArithmetic ||
    (snapshot !== undefined &&
      Object.entries(legacyChannels).some(
        ([name, state]) => snapshot[name] === state && reStopped(name),
      ));
  // Nothing new and the snapshot is already recorded: skip the write so a
  // normal start does not pay an fsync'd rewrite of an unchanged file. A
  // detected rewrite still writes even with nothing merged, to advance
  // the recorded generation — otherwise every later sync re-detects it. A
  // MISSING generation watermark also writes (R11-20): the skip must not
  // fire before the one-shot baseline write that STARTS recording, or
  // entry-set-unchanged re-stops stay invisible on every subsequent sync
  // while the legacy content stays unchanged. Same for a MISSING epoch
  // baseline: the first sync that sees a legacy epoch map must record it,
  // or per-entry re-stop detection never arms (R15-15).
  if (
    targetExisted &&
    target !== undefined &&
    snapshot !== undefined &&
    adoptedGeneration !== undefined &&
    (legacyEntryEpochs === undefined || snapshotEpochs !== undefined)
  ) {
    if (merged.length === 0 && !rewriteSignal) return;
  }
  try {
    prepareStateDirectory(path.dirname(targetPath));
    // Write via the atomic path (temp + fsync + rename): a failure can
    // never leave a partial (corrupt) target behind, which would be
    // treated as empty on the next start and lose both this workspace's
    // records and its adoption snapshot (#8975).
    const data: ChannelStateFile = {
      version: STORE_VERSION,
      channels,
      adoptedLegacy: legacyChannels,
      adoptedLegacyGeneration: legacyGeneration,
      ...(legacyEntryEpochs
        ? { adoptedLegacyEntryEpochs: legacyEntryEpochs }
        : {}),
    };
    atomicWriteFileSync(targetPath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  } catch {
    // Best-effort migration; surface a failure so a later resurrection of
    // the unadopted stops has a traceable cause (#8975).
    writeStderrLineBestEffort(
      `[Channel] Warning: could not adopt legacy channel state from ${legacyPath}; recorded stops may not be honored.`,
    );
  }
  // The legacy file is intentionally kept: later-starting workspaces must
  // be able to adopt the same recorded stops (see the function doc).
}

interface ParsedStateFile {
  channels: Record<string, ChannelRuntimeState>;
  adoptedLegacy?: Record<string, ChannelRuntimeState>;
  adoptedLegacyEntryEpochs?: Record<string, number>;
  adoptedLegacyGeneration?: number;
  generation?: number;
  entryEpochs?: Record<string, number>;
}

/** Tolerant state-file parse: any deviation yields `undefined`. */
function parseStateFile(raw: string): ParsedStateFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const file = parsed as Partial<ChannelStateFile>;
  if (
    typeof file.channels !== 'object' ||
    file.channels === null ||
    Array.isArray(file.channels)
  ) {
    return undefined;
  }
  const result: ParsedStateFile = {
    channels: filterChannelStates(file.channels),
  };
  if (
    typeof file.adoptedLegacy === 'object' &&
    file.adoptedLegacy !== null &&
    !Array.isArray(file.adoptedLegacy)
  ) {
    result.adoptedLegacy = filterChannelStates(file.adoptedLegacy);
  }
  const adoptedEpochs = filterEpochs(file.adoptedLegacyEntryEpochs);
  if (adoptedEpochs) {
    result.adoptedLegacyEntryEpochs = adoptedEpochs;
  }
  if (
    typeof file.adoptedLegacyGeneration === 'number' &&
    Number.isFinite(file.adoptedLegacyGeneration)
  ) {
    result.adoptedLegacyGeneration = file.adoptedLegacyGeneration;
  }
  if (typeof file.generation === 'number' && Number.isFinite(file.generation)) {
    result.generation = file.generation;
  }
  const entryEpochs = filterEpochs(file.entryEpochs);
  if (entryEpochs) {
    result.entryEpochs = entryEpochs;
  }
  return result;
}

/**
 * Tolerant epoch-map parse (R15-15): keeps finite number values under
 * non-empty keys, drops everything else. Returns `undefined` (not an
 * empty map) when the field is absent or not an object — absence means
 * "no epoch baseline" and must stay distinguishable from an empty map.
 */
function filterEpochs(
  epochs: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (typeof epochs !== 'object' || epochs === null || Array.isArray(epochs)) {
    return undefined;
  }
  const result: Record<string, number> = Object.create(null);
  for (const [name, value] of Object.entries(epochs)) {
    if (
      name.length > 0 &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      result[name] = value;
    }
  }
  return result;
}

function filterChannelStates(
  channels: Record<string, unknown>,
): Record<string, ChannelRuntimeState> {
  // Null-prototype map: channel names are user-controlled settings keys,
  // so a channel literally named `__proto__` must round-trip like any
  // other instead of routing through the Object.prototype setter.
  const states: Record<string, ChannelRuntimeState> = Object.create(null);
  for (const [name, state] of Object.entries(channels)) {
    if (name.length > 0 && isChannelRuntimeState(state)) {
      states[name] = state;
    }
  }
  return states;
}

function isChannelRuntimeState(value: unknown): value is ChannelRuntimeState {
  return value === 'active' || value === 'stopped';
}

/**
 * Channel runtime state persisted by the channel service: the daemon's
 * per-workspace file for `qwen serve`, the standalone commands' own file
 * otherwise. The file is owned by the service (never user-edited), so reads
 * are tolerant: a missing or corrupt file behaves like an empty state map
 * and never fails channel startup.
 */
export class ChannelStateStore {
  private readonly warn: (message: string) => void;
  private readonly readImpl: (filePath: string) => string;

  constructor(
    private readonly filePath: string,
    opts: {
      onWarning?: (message: string) => void;
      /**
       * Internal test seam — defaults to `fs.readFileSync` (utf-8),
       * which vitest cannot intercept across module boundaries (ESM
       * exports of `node:fs` are non-configurable; see
       * atomicWriteFileSync's `_testFs`). Lets a test fail the read on
       * an existing, still-writable file — the transient shape a
       * path-level obstacle (EISDIR) cannot model (#8975).
       */
      _testReadFileSync?: (filePath: string) => string;
    } = {},
  ) {
    // Default warning sink: the shared best-effort stderr writer. Store
    // warnings are incidental diagnostics that fire exactly when the disk
    // is failing, so they must never terminate the process (a failing
    // `process.stderr.write` raises an asynchronous `'error'` event past
    // any try/catch) nor defeat the store's never-fails contract. The
    // store previously carried a byte-for-byte private copy of this guard
    // (`writeStoreWarning`); the shared helper keeps the async-crash
    // defense in ONE place (R13-2).
    this.warn = opts.onWarning ?? writeStderrLineBestEffort;
    this.readImpl = opts._testReadFileSync ?? ((p) => readFileSync(p, 'utf-8'));
  }

  /**
   * Read + tolerantly parse the whole state file. A missing or corrupt
   * file behaves like an empty state map (never fails channel startup);
   * a CORRUPT file additionally warns, since the discarded records are the
   * only thing a later resurrection can be traced to (#8975). A transient
   * READ failure on an existing file (anything but ENOENT — EBUSY/EPERM/
   * EIO, e.g. AV interference on a freshly renamed file, documented at
   * renameWithRetrySync) is neither: the content is UNKNOWN, not empty,
   * so the read throws and writers fail closed instead of rebuilding the
   * file from an empty view — permanently destroying every recorded stop
   * and the adoption snapshot (#8975). Returns the full parsed file
   * (channels + adoption snapshot) so writers can preserve fields they
   * do not own.
   */
  private readFileFull(): ParsedStateFile | undefined {
    if (!existsSync(this.filePath)) return undefined;
    let raw: string;
    try {
      raw = this.readImpl(this.filePath);
    } catch (error) {
      // ENOENT can still race the existsSync above — the file is gone,
      // i.e. the missing-file case. Every other error is the unknown-
      // content case documented above; let it reach the writer's
      // fail-closed boundary (trySet*/set*) (#8975).
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    const parsed = parseStateFile(raw);
    if (!parsed) {
      this.warnDiscardedFile();
      return undefined;
    }
    return parsed;
  }

  readAll(): Record<string, ChannelRuntimeState> {
    try {
      return this.readFileFull()?.channels ?? Object.create(null);
    } catch {
      // The READ path stays tolerant: channel startup must never fail on
      // a transiently unreadable state file (the class contract). Only
      // writers fail closed, so nothing rebuilds the file from this
      // empty view and the records survive the transient condition
      // (#8975).
      this.warnDiscardedFile();
      return Object.create(null);
    }
  }

  set(name: string, state: ChannelRuntimeState): void {
    this.applyChange(
      (channels) => {
        channels[name] = state;
      },
      [name],
    );
  }

  setMany(names: readonly string[], state: ChannelRuntimeState): void {
    if (names.length === 0) return;
    this.applyChange((channels) => {
      for (const name of names) {
        channels[name] = state;
      }
    }, names);
  }

  /**
   * Best-effort `set`: state persistence must never fail a channel operation
   * that already succeeded, so write errors are swallowed with a warning.
   * Returns whether the state was persisted; callers whose success message
   * or response claims a durable stop must surface a failed write (#8975).
   */
  trySet(name: string, state: ChannelRuntimeState): boolean {
    try {
      this.set(name, state);
      return true;
    } catch {
      this.warnWriteFailure();
      return false;
    }
  }

  /** Best-effort `setMany`; see `trySet`. */
  trySetMany(names: readonly string[], state: ChannelRuntimeState): boolean {
    try {
      this.setMany(names, state);
      return true;
    } catch {
      this.warnWriteFailure();
      return false;
    }
  }

  /**
   * Drop recorded entries for channels that are no longer configured, so a
   * channel removed from settings and re-added later is not skipped forever
   * by a stale `stopped` entry. Returns the pruned state map. An empty
   * configured set is a no-op, never a wipe-all: zero configured channels is
   * ambiguous (e.g. a transient settings read recovering to empty) and
   * destroying every recorded `stopped` entry would resurrect exactly the
   * channels #8975 must keep stopped.
   *
   * With `preserveAdopted`, names present in the file's `adoptedLegacy`
   * snapshot are exempt: those stops were recorded in ANOTHER workspace or
   * an older release (the population the legacy file exists to serve) and
   * only adopted here. Deleting them is doubly fatal — the adoption
   * snapshot still equals the legacy entry afterwards, so the merge never
   * re-applies the lost stop, and the explicitly stopped channel connects
   * on every later start once it is configured (#8975). They survive until
   * this workspace's own lifecycle touches them (an explicit by-name start
   * records `active`). Locally recorded entries are still pruned, keeping
   * the removed-and-re-added-starts-fresh semantic for this workspace's
   * own stops.
   *
   * The initial load reads via the fail-closed `readFileFull()`, NOT the
   * tolerant `readAll()`: a transient non-ENOENT READ failure means the
   * content is UNKNOWN, not empty. Returning `{}` there would let prune
   * succeed on an empty view, so `selectActiveChannels` would resurrect
   * every explicitly stopped channel and the post-connect batched `active`
   * write would erase the records permanently — and the documented caller
   * fallback (catch → tolerant `readAll()` + warning) would be dead code
   * for the read-failure class it exists for (R13-11). Throwing lets that
   * fallback actually run; a missing or CORRUPT file still behaves like an
   * empty map (the never-fails class `readAll` documents) (#8975).
   */
  prune(
    configuredNames: readonly string[],
    opts: { preserveAdopted?: boolean } = {},
  ): Record<string, ChannelRuntimeState> {
    const file = this.readFileFull();
    const states = file?.channels ?? Object.create(null);
    if (configuredNames.length === 0) return states;
    const configured = new Set(configuredNames);
    let stale = Object.keys(states).filter((name) => !configured.has(name));
    if (stale.length === 0) return states;
    if (opts.preserveAdopted) {
      const adopted = file?.adoptedLegacy;
      if (adopted) {
        stale = stale.filter((name) => adopted[name] === undefined);
        if (stale.length === 0) return states;
      }
    }
    this.applyChange(
      (channels) => {
        for (const name of stale) {
          delete channels[name];
        }
      },
      // Delete-only rewrite (names no entry): bumps the generation by 1 so
      // the counter stays a monotonic per-rewrite watermark (prune only
      // ever writes the workspace-scoped store, never the legacy file the
      // adoption diff reads, so the exact bump here is not load-bearing)
      // (#8975).
      [],
    );
    for (const name of stale) {
      delete states[name];
    }
    return states;
  }

  private applyChange(
    mutate: (channels: Record<string, ChannelRuntimeState>) => void,
    namesWritten: readonly string[],
  ): void {
    // Read via the full-file reader: the adoptedLegacy snapshot must
    // survive every production write, or the next adoption sync loses its
    // diff baseline — silently dropping post-adoption legacy stops (they
    // can no longer be told apart from the already-adopted ones), or a
    // later re-adoption re-applying stale legacy stops over explicit
    // restarts (R9-3). A corrupt file is treated as empty by design, so
    // its snapshot is dropped with it.
    const fileExisted = existsSync(this.filePath);
    const full = this.readFileFull();
    const channels = full?.channels ?? Object.create(null);
    mutate(channels);
    prepareStateDirectory(path.dirname(this.filePath));
    // Every write bumps the generation watermark BY THE NUMBER OF
    // ENTRIES WRITTEN (R11-14, R14): a new file starts at 0, so the
    // no-workspace stop fallback writing the legacy map is always
    // generation-distinguishable from the snapshot the next adoption
    // recorded, and a batched stop mixing a re-stop with a new entry
    // moves the counter more than the entry set grew — the adoption
    // watermark arithmetic needs that per-entry identity to see the
    // re-stop (see `adoptedLegacyGeneration`).
    const generation =
      (full?.generation ?? -1) + Math.max(1, namesWritten.length);
    // Stamp this write's epoch (the new generation value) on exactly the
    // entries it names; unnamed surviving entries keep their epoch, and
    // entries with no prior epoch keep ABSENCE — an unprovable baseline
    // must not be forged into one (R15-15, see `entryEpochs`).
    const named = new Set(namesWritten);
    const priorEpochs = full?.entryEpochs;
    const entryEpochs: Record<string, number> = Object.create(null);
    for (const name of Object.keys(channels)) {
      if (named.has(name)) {
        entryEpochs[name] = generation;
      } else if (priorEpochs?.[name] !== undefined) {
        entryEpochs[name] = priorEpochs[name];
      }
    }
    const data: ChannelStateFile = {
      version: STORE_VERSION,
      generation,
      channels,
      ...(Object.keys(entryEpochs).length > 0 ? { entryEpochs } : {}),
      // Preserve the snapshot (and its legacy-generation watermark and
      // epoch baseline) across writes this store does not own. When no
      // snapshot exists to preserve, stamp an EMPTY one ONLY if this
      // write CREATES the file: every writer in this codebase creates a
      // file only after adoption ran (start flow) or for a stop record,
      // so the new file has 'seen' the legacy file — `{}` marks that,
      // letting a later first-ever legacy stop merge instead of
      // baselining into permanent invisibility. An EXISTING file without
      // a snapshot keeps absence (R11-27): it predates snapshot recording
      // (or was reseeded from a corrupt read), and stamping it would
      // silently convert its next adoption from the baseline branch into
      // the full-merge branch — an order-dependent R9-3 hazard where a
      // stale legacy stop overrides an explicit restart recorded since.
      // Absent stays the marker for files that genuinely predate snapshot
      // recording (#8975).
      ...(full?.adoptedLegacy
        ? {
            adoptedLegacy: full.adoptedLegacy,
            ...(full.adoptedLegacyGeneration !== undefined
              ? { adoptedLegacyGeneration: full.adoptedLegacyGeneration }
              : {}),
            ...(full.adoptedLegacyEntryEpochs
              ? { adoptedLegacyEntryEpochs: full.adoptedLegacyEntryEpochs }
              : {}),
          }
        : fileExisted
          ? {}
          : { adoptedLegacy: Object.create(null) }),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  }

  private warnDiscardedFile(): void {
    this.warn(
      `[Channel] Warning: could not read channel state file ${this.filePath}; treating all channels as active.`,
    );
  }

  private warnWriteFailure(): void {
    this.warn(
      `[Channel] Warning: failed to persist channel state to ${this.filePath}.`,
    );
  }
}

/**
 * Apply the `--channel all` restore filter (#8975): channels explicitly
 * stopped before the last restart are skipped; channels without recorded
 * state are treated as active. Shared by the daemon worker and the
 * standalone start path so the skip rule and its log rendering stay
 * identical; channel names are user-controlled settings keys, so the skip
 * message sanitizes them.
 */
export function selectActiveChannels(
  names: readonly string[],
  states: Record<string, ChannelRuntimeState>,
  onSkipped?: (message: string) => void,
): string[] {
  const selected: string[] = [];
  for (const name of names) {
    if (states[name] === 'stopped') {
      onSkipped?.(
        `[Channel] "${sanitizeLogText(name, 128)}" skipped (stopped before restart)`,
      );
      continue;
    }
    selected.push(name);
  }
  return selected;
}
