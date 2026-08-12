import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core';
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
  adoptLegacyChannelState,
  ChannelStateStore,
  channelRuntimeStatePath,
  selectActiveChannels,
} from './channel-state-store.js';

describe('channelRuntimeStatePath', () => {
  it('falls back to the legacy global file without a workspace', () => {
    expect(channelRuntimeStatePath()).toBe(
      join(tmpdir(), 'qwen-state-home', 'channels', 'channel-state.json'),
    );
  });

  it('scopes the state file per workspace (#8975)', () => {
    expect(channelRuntimeStatePath('/workspace/a')).toBe(
      join(
        tmpdir(),
        'qwen-state-home',
        'channels',
        'standalone',
        hashDaemonWorkspace('/workspace/a'),
        'channel-state.json',
      ),
    );
    // Different workspaces get different files; the same workspace is stable.
    expect(channelRuntimeStatePath('/workspace/a')).toBe(
      channelRuntimeStatePath('/workspace/a'),
    );
    expect(channelRuntimeStatePath('/workspace/a')).not.toBe(
      channelRuntimeStatePath('/workspace/b'),
    );
  });
});

describe('adoptLegacyChannelState (#8975)', () => {
  const workspace = '/workspace/legacy';
  const legacyPath = channelRuntimeStatePath();
  const workspacePath = channelRuntimeStatePath(workspace);
  const channelsDir = join(tmpdir(), 'qwen-state-home', 'channels');

  beforeEach(() => {
    rmSync(channelsDir, { recursive: true, force: true });
    mkdirSync(channelsDir, { recursive: true });
  });

  it('seeds the workspace file from the legacy global file and removes it', () => {
    const legacyBody = JSON.stringify({
      version: 1,
      channels: { telegram: 'stopped' },
    });
    writeFileSync(channelRuntimeStatePath(), legacyBody, 'utf-8');

    adoptLegacyChannelState(workspace);

    expect(readFileSync(workspacePath, 'utf-8')).toBe(legacyBody);
    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('keeps an existing workspace file untouched', () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: 1, channels: { feishu: 'stopped' } }),
      'utf-8',
    );
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({ version: 1, channels: { telegram: 'stopped' } }),
      'utf-8',
    );

    adoptLegacyChannelState(workspace);

    expect(new ChannelStateStore(workspacePath).readAll()).toEqual({
      telegram: 'stopped',
    });
    // The legacy file is left alone once the workspace file exists.
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('does nothing when no legacy file exists', () => {
    adoptLegacyChannelState(workspace);
    expect(existsSync(workspacePath)).toBe(false);
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
  });

  it('persists state across store instances', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('feishu', 'active');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
      feishu: 'active',
    });
  });

  it('overwrites earlier state for the same channel', () => {
    const store = new ChannelStateStore(filePath);
    store.set('telegram', 'stopped');
    store.set('telegram', 'active');

    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'active',
    });
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
    expect(new ChannelStateStore(filePath).readAll()).toEqual({
      telegram: 'stopped',
    });
  });

  it('warns when an existing state file is discarded (#8975)', () => {
    writeFileSync(filePath, '{not json', 'utf-8');
    const onWarning = vi.fn();
    const store = new ChannelStateStore(filePath, { onWarning });

    store.readAll();

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('could not read channel state file'),
    );
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('treating all channels as active'),
    );
  });

  it('does not warn when the file is simply missing', () => {
    const onWarning = vi.fn();
    new ChannelStateStore(filePath, { onWarning }).readAll();
    expect(onWarning).not.toHaveBeenCalled();
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
      expect(
        new ChannelStateStore(filePath, { onWarning: vi.fn() }).readAll(),
      ).toEqual(expected);
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

  describe('trySet / trySetMany (#8975)', () => {
    /** A path whose parent is a regular file makes mkdirSync (and thus any write) throw. */
    function unwritablePath(): string {
      const blocker = join(
        mkdtempSync(join(tmpdir(), 'qwen-channel-state-')),
        'blocker',
      );
      writeFileSync(blocker, '', 'utf-8');
      return join(blocker, 'channel-state.json');
    }

    it('set and setMany still surface write failures', () => {
      const store = new ChannelStateStore(unwritablePath(), {
        onWarning: vi.fn(),
      });
      expect(() => store.set('telegram', 'stopped')).toThrow();
      expect(() => store.setMany(['telegram'], 'stopped')).toThrow();
    });

    it('trySet and trySetMany swallow write failures with a warning', () => {
      const onWarning = vi.fn();
      const store = new ChannelStateStore(unwritablePath(), { onWarning });

      expect(() => store.trySet('telegram', 'stopped')).not.toThrow();
      expect(() =>
        store.trySetMany(['telegram', 'feishu'], 'stopped'),
      ).not.toThrow();

      expect(onWarning).toHaveBeenCalledTimes(2);
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist channel state'),
      );
    });
  });

  describe('default warning path (#8975)', () => {
    it('survives a failing stderr target when warning without an onWarning override', async () => {
      writeFileSync(filePath, '{not json', 'utf-8');
      // A failing stderr target (e.g. ENOSPC on a redirected log) does not
      // throw synchronously — Node delivers the failure as an async 'error'
      // event on process.stderr, which kills the process unless something
      // listens. The default sink must guard that channel.
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => {
          setImmediate(() => {
            process.stderr.emit('error', new Error('ENOSPC'));
          });
          return true;
        }) as typeof process.stderr.write);

      try {
        // No onWarning override: exercises the default stderr sink.
        expect(new ChannelStateStore(filePath).readAll()).toEqual({});
        // Let the async 'error' event fire; without the guard it would
        // surface as an uncaught exception and fail this test.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('still writes warnings to stderr on the default path', () => {
      writeFileSync(filePath, '{not json', 'utf-8');
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => true) as typeof process.stderr.write);

      try {
        new ChannelStateStore(filePath).readAll();
        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringContaining('could not read channel state file'),
        );
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe('prune (#8975)', () => {
    it('drops entries for channels that are no longer configured', () => {
      const store = new ChannelStateStore(filePath);
      store.setMany(['telegram', 'feishu'], 'stopped');

      const states = store.prune(['telegram']);

      expect(states).toEqual({ telegram: 'stopped' });
      expect(new ChannelStateStore(filePath).readAll()).toEqual({
        telegram: 'stopped',
      });
    });

    it('keeps every entry when nothing is stale', () => {
      const store = new ChannelStateStore(filePath);
      store.set('telegram', 'stopped');
      const before = readFileSync(filePath, 'utf-8');

      const states = store.prune(['telegram', 'feishu']);

      expect(states).toEqual({ telegram: 'stopped' });
      // No stale entries: the file is not rewritten.
      expect(readFileSync(filePath, 'utf-8')).toBe(before);
    });
  });
});

describe('selectActiveChannels (#8975)', () => {
  it('selects channels that are not stopped and reports each skip', () => {
    const onSkipped = vi.fn();

    const selected = selectActiveChannels(
      ['telegram', 'feishu', 'slack'],
      { feishu: 'stopped', slack: 'active' },
      onSkipped,
    );

    expect(selected).toEqual(['telegram', 'slack']);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(
      '[Channel] "feishu" skipped (stopped before restart)',
    );
  });

  it('sanitizes user-controlled channel names in skip messages', () => {
    const onSkipped = vi.fn();
    const evilName = 'evil\n[Channel] "telegram" connected.';

    selectActiveChannels([evilName], { [evilName]: 'stopped' }, onSkipped);

    expect(onSkipped).toHaveBeenCalledTimes(1);
    const message = onSkipped.mock.calls[0]![0] as string;
    expect(message).toContain('skipped (stopped before restart)');
    expect(message).not.toContain('\n');
  });
});
