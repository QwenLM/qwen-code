import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFileSync,
  hashDaemonWorkspace,
  Storage,
} from '@qwen-code/qwen-code-core';
import { sanitizeLogText } from '@qwen-code/channel-base';
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
    hashDaemonWorkspace(workspaceCwd),
    'channel-state.json',
  );
}

/**
 * Migration for stops recorded by an older release, which wrote the legacy
 * global file when the pidfile carried no workspace. The standalone read
 * path is always workspace-scoped, so without this seed the recorded stops
 * would be silently lost on upgrade and the channels resurrected by the
 * next `--channel all` start (#8975). Runs only when the workspace file
 * does not exist yet; best-effort — any failure just drops the legacy
 * record for this workspace. The legacy file carries no workspace
 * attribution, so it is deliberately KEPT after an adoption: deleting it
 * after the first workspace adopts it would silently lose the recorded
 * stops of every later-starting workspace and resurrect the channels they
 * explicitly stopped. Each adopting workspace copies the whole file;
 * entries for channels it does not configure are dropped by `prune` on
 * start anyway (#8975).
 */
export function adoptLegacyChannelState(workspaceCwd: string): void {
  const targetPath = channelRuntimeStatePath(workspaceCwd);
  if (existsSync(targetPath)) return;
  const legacyPath = channelRuntimeStatePath();
  if (!existsSync(legacyPath)) return;
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    // Copy via the atomic write (temp + fsync + rename): a failure can
    // never leave a partial (corrupt) target behind, which the existsSync
    // guard above would otherwise treat as a completed adoption — skipping
    // adoption forever and orphaning the recoverable legacy stops.
    atomicWriteFileSync(targetPath, readFileSync(legacyPath), {
      encoding: 'utf-8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  } catch {
    // Best-effort migration; a failure only loses the one-time legacy stops,
    // but surface it so a later resurrection of those channels has a
    // traceable cause — once any write creates the workspace file, the
    // existsSync guard above locks adoption out permanently (#8975).
    writeStoreWarning(
      `[Channel] Warning: could not adopt legacy channel state from ${legacyPath}; recorded stops may not be honored.`,
    );
  }
  // The legacy file is intentionally kept: later-starting workspaces must
  // be able to adopt the same recorded stops (see the function doc).
}

function isChannelRuntimeState(value: unknown): value is ChannelRuntimeState {
  return value === 'active' || value === 'stopped';
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

  readAll(): Record<string, ChannelRuntimeState> {
    if (!existsSync(this.filePath)) return Object.create(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      this.warnDiscardedFile();
      return Object.create(null);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.warnDiscardedFile();
      return Object.create(null);
    }
    const channels = (parsed as Partial<ChannelStateFile>).channels;
    if (
      typeof channels !== 'object' ||
      channels === null ||
      Array.isArray(channels)
    ) {
      this.warnDiscardedFile();
      return Object.create(null);
    }
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
    const channels = this.readAll();
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
