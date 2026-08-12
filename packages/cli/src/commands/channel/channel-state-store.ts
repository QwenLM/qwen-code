import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync, Storage } from '@qwen-code/qwen-code-core';

/**
 * Per-channel runtime state persisted by the daemon. `--channel all`
 * restores every configured channel whose state is not `stopped`; channels
 * without a recorded state are treated as `active`.
 */
export type ChannelRuntimeState = 'active' | 'stopped';

const STORE_VERSION = 1;

interface ChannelStateFile {
  version: typeof STORE_VERSION;
  channels: Record<string, ChannelRuntimeState>;
}

/** State file used by the standalone `qwen channel` commands. */
export function channelRuntimeStatePath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'channel-state.json',
  );
}

function isChannelRuntimeState(value: unknown): value is ChannelRuntimeState {
  return value === 'active' || value === 'stopped';
}

/**
 * Daemon-managed channel runtime state. The file is owned by the daemon
 * (never user-edited), so reads are tolerant: a missing or corrupt file
 * behaves like an empty state map and never fails channel startup.
 */
export class ChannelStateStore {
  constructor(private readonly filePath: string) {}

  readAll(): Record<string, ChannelRuntimeState> {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      return {};
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const channels = (parsed as Partial<ChannelStateFile>).channels;
    if (
      typeof channels !== 'object' ||
      channels === null ||
      Array.isArray(channels)
    ) {
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

  get(name: string): ChannelRuntimeState | undefined {
    return this.readAll()[name];
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
}
