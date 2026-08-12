import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFileSync,
  hashDaemonWorkspace,
  Storage,
} from '@qwen-code/qwen-code-core';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
 * One-time migration for stops recorded by an older release, which wrote the
 * legacy global file when the pidfile carried no workspace. The standalone
 * read path is always workspace-scoped, so without this seed the recorded
 * stops would be silently lost on upgrade and the channels resurrected by
 * the next `--channel all` start (#8975). Runs only when the workspace file
 * does not exist yet; best-effort — any failure just drops the one-time
 * legacy record.
 */
export function adoptLegacyChannelState(workspaceCwd: string): void {
  const targetPath = channelRuntimeStatePath(workspaceCwd);
  if (existsSync(targetPath)) return;
  const legacyPath = channelRuntimeStatePath();
  if (!existsSync(legacyPath)) return;
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    copyFileSync(legacyPath, targetPath);
    unlinkSync(legacyPath);
  } catch {
    // Best-effort migration; a failure only loses the one-time legacy stops.
  }
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
  try {
    writeStderrLine(message);
  } catch {
    // stderr is gone; there is nowhere to report this.
  }
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
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      this.warnDiscardedFile();
      return {};
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.warnDiscardedFile();
      return {};
    }
    const channels = (parsed as Partial<ChannelStateFile>).channels;
    if (
      typeof channels !== 'object' ||
      channels === null ||
      Array.isArray(channels)
    ) {
      this.warnDiscardedFile();
      return {};
    }
    const states: Record<string, ChannelRuntimeState> = {};
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
   */
  trySet(name: string, state: ChannelRuntimeState): void {
    try {
      this.set(name, state);
    } catch {
      this.warnWriteFailure();
    }
  }

  /** Best-effort `setMany`; see `trySet`. */
  trySetMany(names: readonly string[], state: ChannelRuntimeState): void {
    try {
      this.setMany(names, state);
    } catch {
      this.warnWriteFailure();
    }
  }

  /**
   * Drop recorded entries for channels that are no longer configured, so a
   * channel removed from settings and re-added later is not skipped forever
   * by a stale `stopped` entry. Returns the pruned state map.
   */
  prune(
    configuredNames: readonly string[],
  ): Record<string, ChannelRuntimeState> {
    const states = this.readAll();
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
