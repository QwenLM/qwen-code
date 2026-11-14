/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import {
  catalogKey,
  catalogDeferred,
} from '../../test-utils/opentui-catalog.js';

const state = vi.hoisted(() => ({
  keyboard: [] as Array<(key: unknown) => void>,
  rawHandlers: [] as Array<(key: unknown) => void>,
  width: 120,
  height: 40,
  existing: new Set<string>(),
  read: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  write: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  release: vi.fn(),
  restore: vi.fn(),
  editor: vi.fn(),
  relative: vi.fn(),
}));
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react/jsx-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(),
);
vi.mock('@opentui/react/jsx-dev-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(),
);
vi.mock('@opentui/react', async () => {
  const hooks = (
    await import('../../test-utils/opentui-catalog.js')
  ).catalogHooks(state.keyboard, [], () => ({
    width: state.width,
    height: state.height,
  }));
  return {
    ...hooks,
    useKeyboard: (handler: (key: unknown) => void) => {
      state.rawHandlers.push(handler);
      hooks.useKeyboard(handler);
    },
    useRenderer: () => ({ suspend: state.suspend, resume: state.resume }),
  };
});
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: state.read,
    mkdir: state.mkdir,
    access: state.access,
    writeFile: state.write,
  },
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const existsSync = (file: string) => state.existing.has(file);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
vi.mock('node:child_process', () => ({
  spawn: state.spawn,
  spawnSync: state.spawnSync,
  default: { spawn: state.spawn, spawnSync: state.spawnSync },
}));
vi.mock('../../config/settings.js', () => ({
  SettingScope: { Workspace: 'Workspace' },
}));
vi.mock('../utils/formatters.js', () => ({
  formatRelativeTime: state.relative,
}));
vi.mock('./theme.js', () => ({
  C: { text: 'white', dim: 'gray', accent: 'cyan', red: 'red' },
}));
vi.mock('@qwen-code/qwen-code-core/config/storage.js', () => ({
  Storage: { getGlobalQwenDir: () => '/owned/user' },
}));
vi.mock('@qwen-code/qwen-code-core/utils/memory-constants.js', () => ({
  getAllMemoryFilenames: () => ['FIRST.md', 'SECOND.md'],
}));
vi.mock('@qwen-code/qwen-code-core/memory/paths.js', () => ({
  getAutoMemoryRoot: (project: string) => '/managed' + project,
  getAutoMemoryProjectStateDir: (project: string) => '/state' + project,
  getUserAutoMemoryRoot: () => '/managed/user',
  AUTO_MEMORY_INDEX_FILENAME: 'MEMORY.md',
}));
vi.mock('@qwen-code/qwen-code-core/utils/editor.js', () => ({
  getEditorExecutable: state.editor,
}));
vi.mock('../../utils/program-status.js', () => ({
  releaseProgramStatus: state.release,
  restoreProgramStatus: state.restore,
}));
vi.mock('../../i18n/index.js', () => ({
  t: (text: string, variables?: Record<string, string>) =>
    text.replace(/{{(\w+)}}/g, (_, name: string) => variables?.[name] ?? name),
}));
import { OpenTuiMemoryDialog } from './MemoryDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks();
  state.keyboard.length = 0;
  state.rawHandlers.length = 0;
  state.width = 120;
  state.height = 40;
  state.existing.clear();
  state.read.mockResolvedValue('{}');
  state.mkdir.mockResolvedValue(undefined);
  state.access.mockResolvedValue(undefined);
  state.write.mockResolvedValue(undefined);
  state.editor.mockReturnValue('vim');
  state.relative.mockReturnValue('owned relative time');
  state.spawnSync.mockReturnValue({ status: 0 });
  state.suspend.mockImplementation(() => {});
  state.resume.mockImplementation(() => {});
  state.release.mockImplementation(() => {});
  state.restore.mockImplementation(() => {});
  state.spawn.mockImplementation(() => {
    const listeners = new Map<string, () => void>();
    queueMicrotask(() => listeners.get('spawn')?.());
    return {
      once: (name: string, callback: () => void) => {
        listeners.set(name, callback);
      },
      unref: vi.fn(),
    };
  });
});
function fixture() {
  const live = {
    session: 'A',
    cwd: '/owned/project',
    project: '/project',
    managed: false,
    bare: false,
    safe: false,
  };
  const settings = {
    workspace: { path: '/owned/project/.qwen/settings.json' },
    merged: {
      memory: {
        enableManagedAutoMemory: true,
        enableManagedAutoDream: false,
        enableAutoSkill: false,
        autoSkillConfirm: true,
      },
      general: { preferredEditor: 'vim' },
    },
    setValue: vi.fn(),
  };
  settings.setValue.mockImplementation(
    (_scope, key: string, value: boolean, guard: () => void) => {
      guard();
      settings.merged.memory[
        key.slice('memory.'.length) as keyof typeof settings.merged.memory
      ] = value;
    },
  );
  const config = {
    getSessionId: () => live.session,
    getWorkingDir: () => live.cwd,
    getProjectRoot: () => live.project,
    getBareMode: () => live.bare,
    isSafeMode: () => live.safe,
    isManagedMemoryAvailable: () => live.managed,
    setAutoSkillEnabled: vi.fn(),
  };
  const host = { config, settings };
  const onClose = vi.fn();
  const props = {
    config: config as unknown as Config,
    settings: settings as unknown as LoadedSettings,
    host: host as unknown as OpenTuiAppHost,
    onClose,
  };
  return { live, settings, config, host, onClose, props };
}
async function key(name: string, sequence = '') {
  await act(async () => {
    for (const handler of [...state.keyboard])
      handler(catalogKey(name, sequence));
  });
}
async function open(f = fixture(), availableTerminalHeight?: number) {
  const view = render(
    <OpenTuiMemoryDialog
      {...f.props}
      availableTerminalHeight={availableTerminalHeight}
    />,
  );
  await act(async () => {});
  return { ...f, ...view };
}

describe('Native Memory', () => {
  it('persists all four exact Workspace keys and only drives successful auto-skill live', async () => {
    const f = await open();
    for (let index = 0; index < 4; index++) {
      await key('up');
      await key('return', '\r');
    }
    expect(
      f.settings.setValue.mock.calls.map((call) => [call[0], call[1], call[2]]),
    ).toEqual([
      ['Workspace', 'memory.autoSkillConfirm', false],
      ['Workspace', 'memory.enableAutoSkill', true],
      ['Workspace', 'memory.enableManagedAutoDream', true],
      ['Workspace', 'memory.enableManagedAutoMemory', false],
    ]);
    expect(
      f.settings.setValue.mock.calls.every(
        (call) => call[4]?.throwOnWriteFailure === true,
      ),
    ).toBe(true);
    expect(f.config.setAutoSkillEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByText(/Auto-memory: off/)).toBeTruthy();
    f.unmount();
    await open(f);
    expect(
      screen.getByText(/Confirm auto-skills before saving: off/),
    ).toBeTruthy();
    expect(screen.getByText(/Auto-skill: on/)).toBeTruthy();
  });
  it('keeps local state and live Config unchanged when the settings writer rejects', async () => {
    const f = await open();
    f.settings.setValue.mockImplementation(() => {
      throw new Error('disk is read-only');
    });
    await key('up');
    await key('up');
    await key('return', '\r');
    expect(screen.getByText('disk is read-only')).toBeTruthy();
    expect(screen.getByText(/Auto-skill: off/)).toBeTruthy();
    expect(f.config.setAutoSkillEnabled).not.toHaveBeenCalled();
  });
  it('honors bare/safe display gates and leaves managed kind on the startup Config snapshot', async () => {
    const f = fixture();
    f.live.bare = true;
    f.live.managed = true;
    await open(f);
    expect(screen.getByText(/Auto-memory: off/)).toBeTruthy();
    expect(screen.getByText(/managed\/user/)).toBeTruthy();
    await key('up');
    await key('up');
    await key('up');
    await key('up');
    await key('return', '\r');
    expect(screen.getByText(/managed\/user/)).toBeTruthy();
  });
  it('opens the first existing configured User filename and resumes the real terminal boundary', async () => {
    state.existing.add('/owned/user/SECOND.md');
    const f = await open();
    await key('return', '\r');
    expect(state.spawnSync).toHaveBeenCalledWith(
      'vim',
      ['/owned/user/SECOND.md'],
      { stdio: 'inherit', shell: false },
    );
    expect(state.suspend).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.restore).toHaveBeenCalledOnce();
    expect(state.resume).toHaveBeenCalledOnce();
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('numeric Project selection ensures its actual fallback file, without editing User', async () => {
    state.access.mockRejectedValue(new Error('ENOENT'));
    const f = await open();
    await key('2', '2');
    expect(state.write).toHaveBeenCalledExactlyOnceWith(
      '/owned/project/FIRST.md',
      '',
      'utf8',
    );
    expect(state.spawnSync).toHaveBeenCalledWith(
      'vim',
      ['/owned/project/FIRST.md'],
      expect.any(Object),
    );
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('retains editor failures in the panel and always resumes after status restore errors', async () => {
    state.spawnSync.mockReturnValue({ status: 7 });
    const f = await open();
    await key('return', '\r');
    expect(screen.getByText('Editor exited with status 7')).toBeTruthy();
    expect(state.resume).toHaveBeenCalledOnce();
    expect(f.onClose).not.toHaveBeenCalled();
    state.restore.mockImplementation(() => {
      throw new Error('restore failed');
    });
    await key('return', '\r');
    expect(screen.getByText('restore failed')).toBeTruthy();
    expect(state.resume).toHaveBeenCalledTimes(2);
    await key('escape', '\x1b');
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('reports opener spawn failure without closing or pretending its exit was observed', async () => {
    vi.stubEnv('DISPLAY', ':owned');
    const f = fixture();
    f.live.managed = true;
    state.spawn.mockImplementation(() => {
      const callbacks = new Map<string, (error?: Error) => void>();
      queueMicrotask(() =>
        callbacks.get('error')?.(new Error('opener unavailable')),
      );
      return {
        once: (name: string, callback: (error?: Error) => void) =>
          callbacks.set(name, callback),
        unref: vi.fn(),
      };
    });
    await open(f);
    await key('return', '\r');
    expect(screen.getByText('opener unavailable')).toBeTruthy();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it('opens both actual managed directories and loads their known dream metadata', async () => {
    vi.stubEnv('DISPLAY', ':owned');
    state.read.mockResolvedValue('{"lastDreamAt":"2020-01-01T00:00:00.000Z"}');
    const f = fixture();
    f.live.managed = true;
    const view = await open(f);
    expect(state.read).toHaveBeenCalledWith('/state/project/meta.json', 'utf8');
    expect(state.relative).toHaveBeenCalledWith(
      Date.parse('2020-01-01T00:00:00.000Z'),
    );
    expect(screen.getByText(/Auto-dream:/).textContent).toContain(
      'owned relative time',
    );
    expect(screen.getByText(/Auto-dream:/).textContent).not.toContain('never');
    await key('return', '\r');
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer'
          : 'xdg-open';
    expect(state.spawn).toHaveBeenCalledWith(command, ['/managed/user'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(state.spawnSync).not.toHaveBeenCalled();
    view.unmount();
    await open(f);
    await key('2', '2');
    expect(state.spawn).toHaveBeenLastCalledWith(
      command,
      ['/managed/project'],
      { detached: true, stdio: 'ignore' },
    );
  });
  it('leaves invalid metadata as unknown/never and lets safe mode gate all four initial values', async () => {
    state.read.mockResolvedValue('not JSON');
    const f = fixture();
    f.live.safe = true;
    await open(f);
    expect(screen.getByText(/Auto-memory: off/)).toBeTruthy();
    expect(screen.getByText(/Auto-dream: off/).textContent).toContain('never');
    expect(
      screen.getByText(/Confirm auto-skills before saving: off/),
    ).toBeTruthy();
  });
  it.skipIf(process.platform !== 'linux')(
    'uses headless managed MEMORY.md and the existing editor rather than opening a temporary buffer',
    async () => {
      for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'MIR_SOCKET'])
        vi.stubEnv(name, '');
      const f = fixture();
      f.live.managed = true;
      state.access.mockRejectedValue(new Error('ENOENT'));
      await open(f);
      await key('return', '\r');
      expect(state.write).toHaveBeenCalledWith(
        '/managed/user/MEMORY.md',
        '',
        'utf8',
      );
      expect(state.spawnSync).toHaveBeenCalledWith(
        'vim',
        ['/managed/user/MEMORY.md'],
        expect.any(Object),
      );
    },
  );
  it('suppresses repeated actions while resolving an existing target', async () => {
    const pending = catalogDeferred<void>();
    state.access.mockReturnValue(pending.promise);
    const f = await open();
    await key('return', '\r');
    await key('return', '\r');
    expect(state.access).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve();
    });
    expect(state.spawnSync).toHaveBeenCalledOnce();
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('permanently revokes getter-only A→B→A callbacks and permits a fresh replacement owner', async () => {
    const pending = catalogDeferred<void>();
    state.access.mockReturnValue(pending.promise);
    const f = await open();
    await key('return', '\r');
    f.live.session = 'B';
    await act(async () => {
      pending.resolve();
    });
    expect(state.spawnSync).not.toHaveBeenCalled();
    f.live.session = 'A';
    await key('return', '\r');
    expect(state.spawnSync).not.toHaveBeenCalled();
    const next = fixture();
    next.live.session = 'fresh';
    f.rerender(<OpenTuiMemoryDialog {...next.props} />);
    await act(async () => {});
    await key('return', '\r');
    expect(state.spawnSync).toHaveBeenCalledOnce();
    expect(next.onClose).toHaveBeenCalledOnce();
  });
  it('never publishes old metadata or late target failure into a replacement Config', async () => {
    const oldRead = catalogDeferred<string>();
    state.read.mockReturnValue(oldRead.promise);
    const pending = catalogDeferred<void>();
    state.mkdir.mockReturnValue(pending.promise);
    const f = await open();
    await key('return', '\r');
    const next = fixture();
    next.live.project = '/next';
    state.read.mockResolvedValue('{}');
    state.mkdir.mockResolvedValue(undefined);
    f.rerender(<OpenTuiMemoryDialog {...next.props} />);
    await act(async () => {
      oldRead.resolve('{"lastDreamAt":"2020-01-01"}');
      pending.reject(new Error('old mkdir failed'));
    });
    expect(screen.queryByText('old mkdir failed')).toBeNull();
    expect(state.spawnSync).not.toHaveBeenCalled();
    expect(next.onClose).not.toHaveBeenCalled();
  });
  it('rejects a retained settings commit guard after selected owner change', async () => {
    const f = await open();
    await key('up');
    await key('return', '\r');
    const guard = f.settings.setValue.mock.calls[0][3] as () => void;
    f.live.cwd = '/other';
    expect(guard).toThrow('Memory owner changed');
    f.live.cwd = '/owned/project';
    expect(guard).toThrow('Memory owner changed');
  });
  it('preserves same-read arrow→Enter selection and ignores release events', async () => {
    const f = await open();
    await act(async () => {
      for (const handler of [...state.keyboard]) {
        handler(catalogKey('down', '\x1b[B'));
        handler(catalogKey('return', '\r'));
      }
    });
    expect(state.spawnSync).toHaveBeenCalledWith(
      'vim',
      ['/owned/project/FIRST.md'],
      expect.any(Object),
    );
    f.onClose.mockClear();
    await act(async () => {
      for (const handler of [...state.keyboard])
        handler(catalogKey('escape', '\x1b', 'release'));
    });
    expect(f.onClose).not.toHaveBeenCalled();
  });
  it('prevents actions in zero-height or unusably narrow regions and still permits Escape', async () => {
    const f = await open(fixture(), 0);
    await key('return', '\r');
    expect(state.mkdir).not.toHaveBeenCalled();
    state.width = 5;
    f.rerender(
      <OpenTuiMemoryDialog {...f.props} availableTerminalHeight={1} />,
    );
    await key('return', '\r');
    expect(state.mkdir).not.toHaveBeenCalled();
    await key('escape', '\x1b');
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('does not let an old invalid Escape close a replacement or fire after unmount', async () => {
    const f = fixture();
    const view = render(<OpenTuiMemoryDialog {...f.props} host={undefined} />);
    const stale = state.rawHandlers[0];
    const next = fixture();
    view.rerender(<OpenTuiMemoryDialog {...next.props} />);
    await act(async () => {
      stale(catalogKey('escape', '\x1b'));
    });
    expect(next.onClose).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
    view.rerender(<OpenTuiMemoryDialog {...next.props} host={undefined} />);
    const invalid = state.rawHandlers[state.rawHandlers.length - 1];
    view.unmount();
    invalid(catalogKey('escape', '\x1b'));
    expect(next.onClose).not.toHaveBeenCalled();
  });
  it('closes the current invalid notice only once for a same-read Escape burst', async () => {
    const f = fixture();
    render(<OpenTuiMemoryDialog {...f.props} host={undefined} />);
    await act(async () => {
      for (const handler of [...state.keyboard]) {
        handler(catalogKey('escape', '\x1b'));
        handler(catalogKey('escape', '\x1b'));
      }
    });
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('fails closed without a selected matching host instead of process.cwd fallback', async () => {
    const f = fixture();
    render(<OpenTuiMemoryDialog {...f.props} host={undefined} />);
    await act(async () => {});
    await key('return', '\r');
    expect(state.mkdir).not.toHaveBeenCalled();
    expect(f.settings.setValue).not.toHaveBeenCalled();
    await key('escape', '\x1b');
    expect(f.onClose).toHaveBeenCalledOnce();
  });
});
