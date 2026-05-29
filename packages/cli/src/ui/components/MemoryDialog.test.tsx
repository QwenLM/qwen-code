/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
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

const mockedUseConfig = vi.mocked(useConfig);
const mockedUseSettings = vi.mocked(useSettings);
const mockedUseLaunchEditor = vi.mocked(useLaunchEditor);
const mockedUseKeypress = vi.mocked(useKeypress);

describe('MemoryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedUseConfig.mockReturnValue({
      getWorkingDir: vi.fn(() => '/tmp/project'),
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getManagedAutoMemoryEnabled: vi.fn(() => false),
      getManagedAutoDreamEnabled: vi.fn(() => false),
      getAutoSkillEnabled: vi.fn(() => false),
    } as never);

    mockedUseSettings.mockReturnValue({ setValue: vi.fn() } as never);
    mockedUseLaunchEditor.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves selection with down arrow key events', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    expect(lastFrame()).toContain('› 1. User memory');

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];

    act(() => {
      keypressHandler({ name: 'down' } as never);
    });

    expect(lastFrame()).toContain('› 2. Project memory');
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

  it('renders the Auto-skill row with the status from config', () => {
    const { lastFrame } = render(<MemoryDialog onClose={vi.fn()} />);

    // beforeEach mocks getAutoSkillEnabled => false
    expect(lastFrame()).toContain('Auto-skill: off');
  });

  it('chains focus list ↑ autoSkill ↑ autoDream ↑ autoMemory and back down', () => {
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

    // list (index 0) ↑ → autoSkill
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Auto-skill: off');

    // autoSkill ↑ → autoDream
    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› Auto-dream:');

    // autoDream ↓ → autoSkill
    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› Auto-skill: off');

    // autoSkill ↓ → list (index 0)
    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› 1. User memory');
  });

  it('toggles Auto-skill on Enter and persists to workspace settings', () => {
    const setValue = vi.fn();
    mockedUseSettings.mockReturnValue({ setValue } as never);

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

    // navigate to the autoSkill row
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
});
