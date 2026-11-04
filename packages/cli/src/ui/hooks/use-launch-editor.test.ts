/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appEvents, AppEvent } from '../../utils/events.js';
import { useLaunchEditor } from './useLaunchEditor.js';

const { spawn, settings } = vi.hoisted(() => ({
  spawn: vi.fn(),
  settings: {
    merged: { general: { preferredEditor: undefined as string | undefined } },
  },
}));
vi.mock('child_process', () => ({
  default: { spawnSync: spawn },
  spawnSync: spawn,
}));
vi.mock('ink', () => ({
  useStdin: () => ({ stdin: { isRaw: false }, setRawMode: vi.fn() }),
}));
vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: () => settings,
}));
vi.mock(
  '@qwen-code/qwen-code-core/utils/editor.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/utils/editor.js')
    >()),
    getEditorExecutable: (editor: string) =>
      editor === 'vim' ? 'custom-terminal-wrapper' : 'custom-gui-wrapper',
    isTerminalEditor: (editor: string) => editor === 'vim',
  }),
);

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  settings.merged.general.preferredEditor = undefined;
  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  });
  spawn.mockReset();
});
afterEach(() => {
  cleanup();
  Object.defineProperty(process, 'platform', platform);
});

describe('editor terminal handoff', () => {
  it.each([0, 1])(
    'pairs terminal release/acquire for vim exit %s',
    async (status) => {
      settings.merged.general.preferredEditor = 'vim';
      const events: string[] = [];
      const release = () => events.push('release');
      const acquire = () => events.push('acquire');
      appEvents.on(AppEvent.TerminalReleased, release);
      appEvents.on(AppEvent.TerminalAcquired, acquire);
      spawn.mockImplementation(() => {
        events.push('spawn');
        return { status };
      });
      try {
        const { result } = renderHook(() => useLaunchEditor());
        await act(async () => {
          if (status)
            await expect(result.current('/tmp/test.md')).rejects.toThrow(
              'Editor exited',
            );
          else await result.current('/tmp/test.md');
        });
        expect(events).toEqual(['release', 'spawn', 'acquire']);
      } finally {
        appEvents.removeListener(AppEvent.TerminalReleased, release);
        appEvents.removeListener(AppEvent.TerminalAcquired, acquire);
      }
    },
  );

  it.each([undefined, 'vscode'])(
    'does not release the terminal for GUI editor %s',
    async (preferredEditor) => {
      settings.merged.general.preferredEditor = preferredEditor;
      const events: string[] = [];
      const release = () => events.push('release');
      const acquire = () => events.push('acquire');
      appEvents.on(AppEvent.TerminalReleased, release);
      appEvents.on(AppEvent.TerminalAcquired, acquire);
      spawn.mockImplementation(() => {
        events.push('spawn');
        return { status: 0 };
      });
      try {
        const { result } = renderHook(() => useLaunchEditor());
        await act(async () => {
          await result.current('/tmp/test.md');
        });
        expect(events).toEqual(['spawn']);
      } finally {
        appEvents.removeListener(AppEvent.TerminalReleased, release);
        appEvents.removeListener(AppEvent.TerminalAcquired, acquire);
      }
    },
  );
});
