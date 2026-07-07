/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
} from '@qwen-code/qwen-code-core';
import { MemoryDialog } from './MemoryDialog.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import { useKeypress } from '../hooks/useKeypress.js';

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}));

vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: vi.fn(),
}));

vi.mock('../hooks/useLaunchEditor.js', () => ({
  useLaunchEditor: vi.fn(),
}));

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fsMock = {
    access: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(() => Promise.reject(new Error('not found'))),
    writeFile: vi.fn(),
  };
  return {
    ...actual,
    ...fsMock,
    default: { ...actual, ...fsMock },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
    };
    child.unref = vi.fn();
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return {
    ...actual,
    spawn: spawnMock,
    default: { ...actual, spawn: spawnMock },
  };
});

const mockedUseConfig = vi.mocked(useConfig);
const mockedUseSettings = vi.mocked(useSettings);
const mockedUseLaunchEditor = vi.mocked(useLaunchEditor);
const mockedUseKeypress = vi.mocked(useKeypress);
const mockedSpawn = vi.mocked(spawn);
const originalPlatform = process.platform;

type MockSpawnChild = EventEmitter & { unref: ReturnType<typeof vi.fn> };

function createMockSpawnChild(
  event: 'spawn' | 'error' = 'spawn',
  error?: Error,
): MockSpawnChild {
  const child = new EventEmitter() as MockSpawnChild;
  child.unref = vi.fn();
  queueMicrotask(() => {
    child.emit(event, error);
  });
  return child;
}

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('MemoryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DISPLAY', ':99');
    vi.stubEnv('QWEN_HOME', path.join(os.homedir(), '.qwen'));
    vi.stubEnv(
      'QWEN_CODE_MEMORY_BASE_DIR',
      path.join(os.homedir(), '.qwen-memory-test'),
    );
    clearAutoMemoryRootCache();

    mockedUseConfig.mockReturnValue({
      getWorkingDir: vi.fn(() => '/tmp/project'),
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getBareMode: vi.fn(() => false),
      isSafeMode: vi.fn(() => false),
      // Stale snapshot getters — the dialog must NOT read its toggle state
      // from these; it reads from the live merged settings instead.
      getManagedAutoMemoryEnabled: vi.fn(() => false),
      getManagedAutoDreamEnabled: vi.fn(() => false),
      getAutoSkillEnabled: vi.fn(() => false),
      isManagedMemoryAvailable: vi.fn(() => true),
    } as never);

    mockedUseSettings.mockReturnValue({
      setValue: vi.fn(),
      merged: {
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
          enableAutoSkill: false,
          autoSkillConfirm: true,
        },
      },
    } as never);
    mockedUseLaunchEditor.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
    clearAutoMemoryRootCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('renders managed memory folders without advertising QWEN.md', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    expect(lastFrame()).toContain('› 1. User memory');
    expect(lastFrame()).toContain('2. Project memory');
    expect(lastFrame()).toContain('/memories');
    expect(lastFrame()).toContain('/memory');
    expect(lastFrame()).not.toContain('QWEN.md');
    expect(lastFrame()).not.toContain('Open auto-memory folder');
  });

  it('opens managed memory folders instead of launching an editor', async () => {
    const onClose = vi.fn();
    const launchEditor = vi.fn();
    mockedUseLaunchEditor.mockReturnValue(launchEditor);

    render(<MemoryDialog onClose={onClose} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressHandler({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [path.join(os.homedir(), '.qwen-memory-test', 'memories')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(
      (mockedSpawn.mock.results[0]?.value as MockSpawnChild).unref,
    ).toHaveBeenCalled();
    expect(launchEditor).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)(
    'opens managed memory folders on %s without display variables',
    async (platform) => {
      stubPlatform(platform);
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      const onClose = vi.fn();
      const launchEditor = vi.fn();
      mockedUseLaunchEditor.mockReturnValue(launchEditor);

      render(<MemoryDialog onClose={onClose} />);

      const keypressHandler = mockedUseKeypress.mock.calls[0][0];
      await act(async () => {
        keypressHandler({ name: 'return' } as never);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        expect.any(String),
        [path.join(os.homedir(), '.qwen-memory-test', 'memories')],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
      expect(launchEditor).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    },
  );

  it('opens the project managed memory folder after moving selection down', async () => {
    const onClose = vi.fn();
    const launchEditor = vi.fn();
    mockedUseLaunchEditor.mockReturnValue(launchEditor);
    const { lastFrame } = render(<MemoryDialog onClose={onClose} />);

    expect(lastFrame()).toContain('› 1. User memory');

    act(() => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'down' } as never);
    });

    expect(lastFrame()).toContain('› 2. Project memory');

    await act(async () => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [getAutoMemoryRoot('/tmp/project')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(launchEditor).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the second visible item with its numeric shortcut', async () => {
    const onClose = vi.fn();
    render(<MemoryDialog onClose={onClose} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressHandler({ name: '2', sequence: '2' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [getAutoMemoryRoot('/tmp/project')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the managed memory index in an editor on headless Linux', async () => {
    stubPlatform('linux');
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('MIR_SOCKET', '');
    const onClose = vi.fn();
    const launchEditor = vi.fn();
    mockedUseLaunchEditor.mockReturnValue(launchEditor);

    render(<MemoryDialog onClose={onClose} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressHandler({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(launchEditor).toHaveBeenCalledWith(
      path.join(
        os.homedir(),
        '.qwen-memory-test',
        'memories',
        AUTO_MEMORY_INDEX_FILENAME,
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error when opening a managed memory folder fails', async () => {
    const onClose = vi.fn();
    mockedSpawn.mockImplementationOnce(
      () => createMockSpawnChild('error', new Error('ENOENT')) as never,
    );
    const { lastFrame } = render(<MemoryDialog onClose={onClose} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressHandler({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lastFrame()).toContain('ENOENT');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves selection with Ctrl+N/P readline aliases', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    expect(lastFrame()).toContain('› 1. User memory');

    const pressKey = (key: { name: string; ctrl?: boolean }) => {
      const keypressHandler =
        mockedUseKeypress.mock.calls[
          mockedUseKeypress.mock.calls.length - 1
        ]![0];
      act(() => {
        keypressHandler(key as never);
      });
    };

    pressKey({ name: 'n', ctrl: true });
    expect(lastFrame()).toContain('› 2. Project memory');

    pressKey({ name: 'p', ctrl: true });
    expect(lastFrame()).toContain('› 1. User memory');
  });

  it('renders the Auto-skill row with the status from merged settings', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    // beforeEach mocks merged.memory.enableAutoSkill => false
    expect(lastFrame()).toContain('Auto-skill: off');
  });

  it('chains focus list ↑ autoSkillConfirm ↑ autoSkill ↑ autoDream ↑ autoMemory and back down', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    expect(lastFrame()).toContain('› 1. User memory');

    const pressKey = (key: { name: string }) => {
      const keypressHandler =
        mockedUseKeypress.mock.calls[
          mockedUseKeypress.mock.calls.length - 1
        ]![0];
      act(() => {
        keypressHandler(key as never);
      });
    };

    // list (index 0) ↑ → autoSkillConfirm
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Confirm auto-skills before saving: on');

    // autoSkillConfirm ↑ → autoSkill
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Auto-skill: off');

    // autoSkill ↑ → autoDream
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Auto-dream:');

    // autoDream ↓ → autoSkill
    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› Auto-skill: off');

    // autoSkill ↓ → autoSkillConfirm
    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› Confirm auto-skills before saving: on');

    // autoSkillConfirm ↓ → list (index 0)
    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› 1. User memory');
  });

  it('toggles Auto-skill on Enter and persists to workspace settings', () => {
    const setValue = vi.fn();
    mockedUseSettings.mockReturnValue({
      setValue,
      merged: { memory: { enableAutoSkill: false, autoSkillConfirm: true } },
    } as never);

    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    const pressKey = (key: { name: string }) => {
      const keypressHandler =
        mockedUseKeypress.mock.calls[
          mockedUseKeypress.mock.calls.length - 1
        ]![0];
      act(() => {
        keypressHandler(key as never);
      });
    };

    expect(lastFrame()).toContain('Auto-skill: off');

    // navigate to the autoSkillConfirm row first, then up to autoSkill
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Confirm auto-skills before saving: on');

    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Auto-skill: off');

    // Enter toggles
    pressKey({ name: 'return' });

    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'memory.enableAutoSkill',
      true,
    );
    expect(lastFrame()).toContain('› Auto-skill: on');
  });

  it('toggles autoSkillConfirm on Enter and persists to workspace settings', () => {
    const setValue = vi.fn();
    mockedUseSettings.mockReturnValue({
      setValue,
      merged: { memory: { enableAutoSkill: false, autoSkillConfirm: true } },
    } as never);

    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    const pressKey = (key: { name: string }) => {
      const keypressHandler =
        mockedUseKeypress.mock.calls[
          mockedUseKeypress.mock.calls.length - 1
        ]![0];
      act(() => {
        keypressHandler(key as never);
      });
    };

    expect(lastFrame()).toContain('Confirm auto-skills before saving: on');

    // navigate to the autoSkillConfirm row
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Confirm auto-skills before saving: on');

    // Enter toggles
    pressKey({ name: 'return' });

    expect(setValue).toHaveBeenCalledWith(
      expect.anything(),
      'memory.autoSkillConfirm',
      false,
    );
    expect(lastFrame()).toContain('› Confirm auto-skills before saving: off');
  });

  it('keeps QWEN.md editor entries when managed memory is unavailable', async () => {
    const launchEditor = vi.fn();
    mockedUseLaunchEditor.mockReturnValue(launchEditor);
    mockedUseConfig.mockReturnValue({
      getWorkingDir: vi.fn(() => '/tmp/project'),
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getBareMode: vi.fn(() => true),
      isSafeMode: vi.fn(() => false),
      getManagedAutoMemoryEnabled: vi.fn(() => false),
      getManagedAutoDreamEnabled: vi.fn(() => false),
      getAutoSkillEnabled: vi.fn(() => false),
      isManagedMemoryAvailable: vi.fn(() => false),
    } as never);

    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    expect(lastFrame()).toContain('› 1. User memory');
    expect(lastFrame()).toContain('Saved in ~/.qwen/QWEN.md');
    expect(lastFrame()).toContain('2. Project memory');
    expect(lastFrame()).toContain('Saved in QWEN.md');

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressHandler({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(launchEditor).toHaveBeenCalledWith(
      expect.stringMatching(/\/\.qwen\/QWEN\.md$/),
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('reflects the persisted value when the dialog is reopened (remounted)', () => {
    // Emulate LoadedSettings: setValue writes through to the merged view,
    // exactly like the real saveSettings + recomputeMerged path.
    const merged = {
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableAutoSkill: false,
        autoSkillConfirm: true,
      },
    };
    const setValue = vi.fn((_scope: unknown, key: string, value: boolean) => {
      if (key === 'memory.enableAutoSkill') {
        merged.memory.enableAutoSkill = value;
      }
    });
    mockedUseSettings.mockReturnValue({ setValue, merged } as never);

    const pressKey = (key: { name: string }) => {
      const keypressHandler =
        mockedUseKeypress.mock.calls[
          mockedUseKeypress.mock.calls.length - 1
        ]![0];
      act(() => {
        keypressHandler(key as never);
      });
    };

    // First open: toggle Auto-skill on, then close the dialog.
    const first = render(<MemoryDialog onClose={vi.fn()} />);
    expect(first.lastFrame()).toContain('Auto-skill: off');
    pressKey({ name: 'up' }); // focus autoSkillConfirm
    pressKey({ name: 'up' }); // focus the Auto-skill row
    pressKey({ name: 'return' }); // toggle on
    expect(first.lastFrame()).toContain('› Auto-skill: on');
    first.unmount();

    // Reopen: a fresh mount must read the persisted value, not a stale snapshot.
    const second = render(<MemoryDialog onClose={vi.fn()} />);
    expect(second.lastFrame()).toContain('Auto-skill: on');
  });
});
