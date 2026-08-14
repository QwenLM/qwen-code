import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
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
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';

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
   * The legacy file's mtime at the last adoption sync. A content diff
   * alone cannot see a re-stop written BYTE-IDENTICALLY by an older
   * release (re-stopping an already-stopped channel rewrites the same
   * map): the snapshot matches, so the merge loop would drop it and the
   * explicitly re-stopped channel resurrects on `--channel all`. When the
   * mtime moved AND the content still equals the snapshot, the rewrite
   * itself is a new stop signal re-asserting the whole map, so
   * snapshot-identical entries are re-applied too. (A rewrite that
   * CHANGES the content stays on the plain content diff — the unchanged
   * entries were not re-asserted, and re-applying them would override an
   * explicit restart, the R9-3 hazard.) Absent on files written before
   * mtime recording; adoption then keeps the content-only diff for that
   * one sync and starts recording (#8975).
   */
  adoptedLegacyMtime?: number;
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
 * workspace's own map with the stale old stop. Exception: a rewrite of
 * the legacy file that leaves an entry byte-identical (an older release
 * re-stopping an already-stopped channel) is invisible to the content
 * diff, so the sync also records the legacy mtime; when it moved since
 * the snapshot was recorded, the rewrite itself is a new stop signal and
 * snapshot-identical entries are re-applied (#8975). Entries that
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
  let legacyMtime: number;
  try {
    legacyMtime = statSync(legacyPath).mtimeMs;
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = parseStateFile(raw);
    // A legacy file that reads successfully but no longer parses is
    // silently coerced to empty otherwise: the stops it carried are lost
    // with no trace, so warn like every other discard path (#8975).
    if (!parsed) {
      writeStoreWarning(
        `[Channel] Warning: could not parse legacy channel state file ${legacyPath}; treating it as empty for this adoption.`,
      );
    }
    legacyChannels = parsed?.channels ?? Object.create(null);
  } catch {
    // ENOENT is pre-checked above, so a throw here is a real read failure
    // (EACCES/EIO/EISDIR on a shared ~/.qwen): the unadopted stops may
    // resurrect on the next start, so leave a trace (#8975).
    writeStoreWarning(
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
    } catch {
      target = undefined;
    }
  }
  // A corrupt target is reseeded from the legacy map below, which makes
  // it valid forever after — no later read/prune can warn about the
  // discarded records, so the discard itself must (#8975).
  if (targetExisted && target === undefined) {
    writeStoreWarning(
      `[Channel] Warning: could not read channel state file ${targetPath}; treating all channels as active.`,
    );
  }

  const channels: Record<string, ChannelRuntimeState> =
    target?.channels ?? Object.create(null);
  const snapshot = target?.adoptedLegacy;
  // A snapshot-identical entry is re-applied only on a BYTE-IDENTICAL
  // rewrite of the legacy file: the moved mtime proves a rewrite happened
  // since the snapshot was recorded, and unchanged content means the
  // rewrite re-asserted exactly the adopted map — a re-stop (see the
  // function doc). Without a recorded mtime (a file written before mtime
  // recording) the content-only diff stands for this sync; the write
  // below starts recording.
  const legacyRewritten =
    snapshot !== undefined &&
    target?.adoptedLegacyMtime !== undefined &&
    target.adoptedLegacyMtime !== legacyMtime &&
    sameChannelMaps(snapshot, legacyChannels);
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
      } else if (legacyRewritten && channels[name] !== state) {
        // Byte-identical re-stop by an older release (see the function
        // doc): content cannot distinguish it from 'unchanged since
        // adoption', but the moved mtime proves a rewrite, and a rewrite
        // carrying this entry is a stop event — re-apply it over an
        // explicit restart recorded since (#8975).
        channels[name] = state;
        merged.push(name);
      }
    }
  }
  // Nothing new and the snapshot is already recorded: skip the write so a
  // normal start does not pay an fsync'd rewrite of an unchanged file. A
  // detected rewrite still writes even with nothing merged, to advance
  // the recorded mtime — otherwise every later sync re-detects it.
  if (targetExisted && target !== undefined && snapshot !== undefined) {
    if (merged.length === 0 && !legacyRewritten) return;
  }
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    // Write via the atomic path (temp + fsync + rename): a failure can
    // never leave a partial (corrupt) target behind, which would be
    // treated as empty on the next start and lose both this workspace's
    // records and its adoption snapshot (#8975).
    const data: ChannelStateFile = {
      version: STORE_VERSION,
      channels,
      adoptedLegacy: legacyChannels,
      adoptedLegacyMtime: legacyMtime,
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
    writeStoreWarning(
      `[Channel] Warning: could not adopt legacy channel state from ${legacyPath}; recorded stops may not be honored.`,
    );
  }
  // The legacy file is intentionally kept: later-starting workspaces must
  // be able to adopt the same recorded stops (see the function doc).
}

interface ParsedStateFile {
  channels: Record<string, ChannelRuntimeState>;
  adoptedLegacy?: Record<string, ChannelRuntimeState>;
  adoptedLegacyMtime?: number;
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
  if (
    typeof file.adoptedLegacyMtime === 'number' &&
    Number.isFinite(file.adoptedLegacyMtime)
  ) {
    result.adoptedLegacyMtime = file.adoptedLegacyMtime;
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

/** Entry-wise equality of two state maps (both already filtered). */
function sameChannelMaps(
  a: Record<string, ChannelRuntimeState>,
  b: Record<string, ChannelRuntimeState>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((name) => b[name] === a[name]);
}

/**
 * Default warning sink for the store: provably non-fatal. A failing
 * `process.stderr.write` (e.g. ENOSPC on a redirected log — the same disk
 * condition that fails the state write) does not throw; Node emits an
 * asynchronous `'error'` event on `process.stderr` that terminates the
 * process with exit 1 past any surrounding try/catch. Store warnings are
 * incidental diagnostics and must not defeat the store's never-fails
 * contract, so guard the async channel while nothing else listens (#8975).
 */
function writeStoreWarning(message: string): void {
  if (process.stderr.listenerCount('error') === 0) {
    process.stderr.on('error', () => {
      // The stderr target is gone; this diagnostic is already lost.
    });
  }
  writeStderrLineSafe(message);
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

  constructor(
    private readonly filePath: string,
    opts: { onWarning?: (message: string) => void } = {},
  ) {
    this.warn = opts.onWarning ?? writeStoreWarning;
  }

  /**
   * Read + tolerantly parse the whole state file. A missing or corrupt
   * file behaves like an empty state map (never fails channel startup);
   * a CORRUPT file additionally warns, since the discarded records are the
   * only thing a later resurrection can be traced to (#8975). Returns the
   * full parsed file (channels + adoption snapshot) so writers can
   * preserve fields they do not own.
   */
  private readFileFull(): ParsedStateFile | undefined {
    if (!existsSync(this.filePath)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      this.warnDiscardedFile();
      return undefined;
    }
    const parsed = parseStateFile(raw);
    if (!parsed) {
      this.warnDiscardedFile();
      return undefined;
    }
    return parsed;
  }

  readAll(): Record<string, ChannelRuntimeState> {
    return this.readFileFull()?.channels ?? Object.create(null);
  }

  set(name: string, state: ChannelRuntimeState): void {
    this.applyChange((channels) => {
      channels[name] = state;
    });
  }

  setMany(names: readonly string[], state: ChannelRuntimeState): void {
    if (names.length === 0) return;
    this.applyChange((channels) => {
      for (const name of names) {
        channels[name] = state;
      }
    });
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
   */
  prune(
    configuredNames: readonly string[],
  ): Record<string, ChannelRuntimeState> {
    const states = this.readAll();
    if (configuredNames.length === 0) return states;
    const configured = new Set(configuredNames);
    const stale = Object.keys(states).filter((name) => !configured.has(name));
    if (stale.length === 0) return states;
    this.applyChange((channels) => {
      for (const name of stale) {
        delete channels[name];
      }
    });
    for (const name of stale) {
      delete states[name];
    }
    return states;
  }

  private applyChange(
    mutate: (channels: Record<string, ChannelRuntimeState>) => void,
  ): void {
    // Read via the full-file reader: the adoptedLegacy snapshot must
    // survive every production write, or the next adoption sync loses its
    // diff baseline — silently dropping post-adoption legacy stops (they
    // can no longer be told apart from the already-adopted ones), or a
    // later re-adoption re-applying stale legacy stops over explicit
    // restarts (R9-3). A corrupt file is treated as empty by design, so
    // its snapshot is dropped with it.
    const full = this.readFileFull();
    const channels = full?.channels ?? Object.create(null);
    mutate(channels);
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows and some filesystems do not implement POSIX modes.
    }
    const data: ChannelStateFile = {
      version: STORE_VERSION,
      channels,
      // Preserve the snapshot (and its legacy-mtime watermark) across
      // writes this store does not own. When no snapshot exists to
      // preserve, record an EMPTY one: every writer in this codebase
      // creates a file only after adoption ran (start flow) or for a
      // stop record, so the file has 'seen' the legacy file — `{}` marks
      // that, letting a later first-ever legacy stop merge instead of
      // baselining into permanent invisibility. Absent stays the marker
      // for files that genuinely predate snapshot recording (#8975).
      ...(full?.adoptedLegacy
        ? {
            adoptedLegacy: full.adoptedLegacy,
            ...(full.adoptedLegacyMtime !== undefined
              ? { adoptedLegacyMtime: full.adoptedLegacyMtime }
              : {}),
          }
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
