import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    Storage: {
      getGlobalQwenDir: () => join(tmpdir(), 'qwen-state-home'),
    },
  };
});

import {
  ChannelStateStore,
  channelRuntimeStatePath,
} from './channel-state-store.js';

describe('channelRuntimeStatePath', () => {
  it('lives under the global qwen dir channels folder', () => {
    expect(channelRuntimeStatePath()).toBe(
      join(tmpdir(), 'qwen-state-home', 'channels', 'channel-state.json'),
    );
  });
});

describe('ChannelStateStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = join(
      mkdtempSync(join(tmpdir(), 'qwen-channel-state-')),
      'channel-state.json',
    );
  });

  it('returns an empty map when the file is missing', () => {
    const store = new ChannelStateStore(filePath);
    expect(store.readAll()).toEqual({});
    expect(store.get('telegram')).toBeUndefined();
  });

  it('persists state across store instances', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('feishu', 'active');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'active',
    });
    expect(new ChannelStateStore(filePath).get('telegram')).toBe('stopped');
  });

  it('overwrites earlier state for the same channel', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('telegram', 'active');

    expect(new ChannelStateStore(filePath).get('telegram')).toBe('active');
  });

  it('applies setMany to every named channel', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'active');
    store.setMany(['telegram', 'feishu'], 'stopped');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'stopped',
    });
  });

  it('treats a corrupt file as empty and recovers on next write', () => {
    writeFileSync(filePath, '{not json', 'utf-8');
    const store = new ChannelStateStore(filePath);

    expect(store.readAll()).toEqual({});

    store.set('telegram', 'stopped');
    expect(new ChannelStateStore(filePath).get('telegram')).toBe('stopped');
  });

  it.each([
    ['[]', {}],
    ['"stopped"', {}],
    ['{"channels": "stopped"}', {}],
    ['{"channels": ["telegram"]}', {}],
    ['{"channels": {"telegram": "running"}}', {}],
    // Unknown states are dropped; valid entries survive.
    [
      '{"channels": {"": "stopped", "telegram": "active"}}',
      { telegram: 'active' },
    ],
  ] as Array<[string, Record<string, string>]>)(
    'treats wrong-shaped files as empty: %s',
    (content, expected) => {
      writeFileSync(filePath, content, 'utf-8');
      expect(new ChannelStateStore(filePath).readAll()).toEqual(expected);
    },
  );

  it('writes valid JSON with the recorded states', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
      version: 1,
      channels: { telegram: 'stopped' },
    });
  });
});
