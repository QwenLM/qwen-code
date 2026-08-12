import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
 * workspace (e.g. a pidfile written by an older release) the legacy global
 * file is used so recorded stops are not lost on upgrade.
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

  constructor(
    private readonly filePath: string,
    opts: { onWarning?: (message: string) => void } = {},
  ) {
    this.warn = opts.onWarning ?? writeStderrLine;
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
