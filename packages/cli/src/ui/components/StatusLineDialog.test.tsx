/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ComponentProps } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { MessageType } from '../types.js';
import { STATUS_LINE_PRESET_ITEMS } from '../statusLinePresets.js';
import { StatusLineDialog } from './StatusLineDialog.js';

function createSettings(): LoadedSettings {
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-statusline-'));
  return new LoadedSettings(
    {
      settings: {},
      originalSettings: {},
      path: path.join(dir, 'system-settings.json'),
    },
    {
      settings: {},
      originalSettings: {},
      path: path.join(dir, 'system-defaults.json'),
    },
    {
      settings: {},
      originalSettings: {},
      path: path.join(dir, 'user-settings.json'),
    },
    {
      settings: {},
      originalSettings: {},
      path: path.join(dir, 'workspace-settings.json'),
    },
    true,
    new Set(),
  );
}

const config = {
  getCliVersion: () => '1.2.3',
  getModel: () => 'qwen3-code-plus',
  getModelDisplayName: () => 'Qwen3 Code Plus',
  getTargetDir: () => '/repo/project',
  getContentGeneratorConfig: () => ({
    contextWindowSize: 1000,
    reasoning: { effort: 'high' },
  }),
} as Config;

type DialogProps = ComponentProps<typeof StatusLineDialog>;

function dialog(overrides: Partial<DialogProps> = {}) {
  return (
    <KeypressProvider kittyProtocolEnabled={false}>
      <StatusLineDialog
        settings={createSettings()}
        config={config}
        addItem={vi.fn()}
        onClose={vi.fn()}
        availableTerminalHeight={18}
        {...overrides}
      />
    </KeypressProvider>
  );
}

function renderDialog(overrides: Partial<DialogProps> = {}, columns?: number) {
  const ui = dialog(overrides);
  const result = render(ui);
  if (columns !== undefined) {
    Object.defineProperty(result.stdout, 'columns', { value: columns });
    result.rerender(ui);
  }
  return result;
}

describe('StatusLineDialog', () => {
  it('renders a searchable preset picker without an internal preview', () => {
    const { lastFrame } = renderDialog({ availableTerminalHeight: 25 });

    expect(lastFrame()).toContain('Configure Status Line');
    expect(lastFrame()).toContain('Type to search');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('model-with-reasoning');
    expect(frame).toContain('model-only');
    expect(frame).toContain('git-branch');
    expect(frame).toContain('context-remaining');
    expect(frame).toContain('current-dir');
    expect(frame.indexOf('project-name')).toBeLessThan(
      frame.indexOf('git-branch'),
    );
    expect(frame.indexOf('git-branch')).toBeLessThan(
      frame.indexOf('model-with-reasoning'),
    );
    expect(frame.indexOf('model-with-reasoning')).toBeLessThan(
      frame.indexOf('model-only'),
    );
    expect(frame.indexOf('model-only')).toBeLessThan(
      frame.indexOf('context-remaining'),
    );
    expect(frame.indexOf('context-remaining')).toBeLessThan(
      frame.indexOf('current-dir'),
    );
    expect(lastFrame()).not.toContain('Preview');
    expect(lastFrame()).not.toContain('Qwen3 Code Plus high');
  });

  it('publishes draft changes without saving and clears the preview on unmount', async () => {
    const settings = createSettings();
    const setValue = vi.spyOn(settings, 'setValue');
    const onPreviewChange = vi.fn();
    const onClose = vi.fn();
    const { stdin, unmount } = renderDialog({
      settings,
      onPreviewChange,
      onClose,
    });
    await vi.waitFor(() =>
      expect(onPreviewChange).toHaveBeenCalledWith({
        type: 'preset',
        useThemeColors: true,
        items: [
          'project-name',
          'git-branch',
          'model-with-reasoning',
          'context-used',
        ],
      }),
    );
    act(() => stdin.write(' '));
    await vi.waitFor(() =>
      expect(onPreviewChange).toHaveBeenLastCalledWith({
        type: 'preset',
        useThemeColors: false,
        items: [
          'project-name',
          'git-branch',
          'model-with-reasoning',
          'context-used',
        ],
      }),
    );
    act(() => stdin.write('\u001b'));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(setValue).not.toHaveBeenCalled();
    unmount();
    expect(onPreviewChange).toHaveBeenLastCalledWith(undefined);
  });

  it('persists selected presets on enter', async () => {
    const settings = createSettings();
    const addItem = vi.fn();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const recordSlashCommand = vi.fn();
    const recordingConfig = {
      ...config,
      getChatRecordingService: () => ({ recordSlashCommand }),
    } as unknown as Config;
    const { stdin } = renderDialog({
      settings,
      config: recordingConfig,
      addItem,
      onSaved,
      onClose,
    });

    act(() => {
      stdin.write('\r');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settings.merged.ui?.statusLine).toEqual({
      type: 'preset',
      useThemeColors: true,
      items: [
        'project-name',
        'git-branch',
        'model-with-reasoning',
        'context-used',
      ],
    });
    expect(
      settings.forScope(SettingScope.User).settings.ui?.statusLine,
    ).toEqual(settings.merged.ui?.statusLine);
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Status line preset saved to user settings.',
      },
      expect.any(Number),
    );
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/statusline',
      outputHistoryItems: [
        {
          type: MessageType.INFO,
          text: 'Status line preset saved to user settings.',
        },
      ],
    });
    expect(onSaved).toHaveBeenCalledWith(settings.merged.ui?.statusLine);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps preset priority order after an item is toggled off and on', async () => {
    const settings = createSettings();
    const onPreviewChange = vi.fn();
    const { stdin } = renderDialog({ settings, onPreviewChange });

    const press = async (input: string) => {
      act(() => {
        stdin.write(input);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await press('j');
    await press('j');
    await press('j');
    await press(' ');
    await press(' ');

    expect(onPreviewChange).toHaveBeenLastCalledWith({
      type: 'preset',
      useThemeColors: true,
      items: [
        'project-name',
        'git-branch',
        'model-with-reasoning',
        'context-used',
      ],
    });

    await press('\r');

    expect(settings.merged.ui?.statusLine).toEqual({
      type: 'preset',
      useThemeColors: true,
      items: [
        'project-name',
        'git-branch',
        'model-with-reasoning',
        'context-used',
      ],
    });
  });

  it.each([false, true])(
    'saves hideContextIndicator=%s back to the effective workspace scope',
    async (hideContextIndicator) => {
      const settings = createSettings();
      settings.workspace.settings.ui = {
        statusLine: {
          type: 'preset',
          useThemeColors: false,
          items: ['model'],
          hideContextIndicator,
        },
      };
      settings.workspace.originalSettings.ui = settings.workspace.settings.ui;
      settings.recomputeMerged();
      const addItem = vi.fn();
      const { stdin } = renderDialog({ settings, addItem });

      act(() => {
        stdin.write('\r');
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(settings.forScope(SettingScope.User).settings.ui).toBeUndefined();
      expect(settings.forScope(SettingScope.Workspace).settings.ui).toEqual({
        statusLine: {
          type: 'preset',
          useThemeColors: false,
          items: ['model'],
          hideContextIndicator,
        },
      });
      expect(addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'Status line preset saved to workspace settings.',
        },
        expect.any(Number),
      );
    },
  );

  it('preserves an explicit command indicator setting when saving a preset', async () => {
    const settings = createSettings();
    settings.workspace.settings.ui = {
      statusLine: {
        type: 'command',
        command: 'echo status',
        hideContextIndicator: false,
      },
    };
    settings.workspace.originalSettings.ui = settings.workspace.settings.ui;
    settings.recomputeMerged();
    const { stdin } = renderDialog({ settings });

    act(() => {
      stdin.write('\r');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      settings.forScope(SettingScope.Workspace).settings.ui?.statusLine,
    ).toHaveProperty('hideContextIndicator', false);
  });

  it('does not copy a user override into workspace settings', async () => {
    const settings = createSettings();
    settings.user.settings.ui = {
      statusLine: {
        type: 'preset',
        items: ['model'],
        hideContextIndicator: true,
      },
    };
    settings.workspace.settings.ui = {
      statusLine: {
        type: 'preset',
        items: ['git-branch'],
      },
    };
    settings.recomputeMerged();
    const { stdin } = renderDialog({ settings });

    act(() => {
      stdin.write('\r');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      settings.forScope(SettingScope.Workspace).settings.ui?.statusLine,
    ).not.toHaveProperty('hideContextIndicator');
    expect(
      settings.forScope(SettingScope.User).settings.ui?.statusLine,
    ).toHaveProperty('hideContextIndicator', true);
  });

  it('does not append navigation keys to the search query', async () => {
    const { stdin, lastFrame } = renderDialog();

    act(() => {
      stdin.write('m');
      stdin.write('j');
      stdin.write('k');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastFrame()).toContain('> m');
    expect(lastFrame()).not.toContain('> mj');
    expect(lastFrame()).not.toContain('> mk');
  });

  it('excludes the separator from search results', async () => {
    const { stdin, lastFrame } = renderDialog();

    act(() => stdin.write('separator'));

    await vi.waitFor(() =>
      expect(lastFrame()).toContain('No preset items match.'),
    );
    expect(lastFrame()).not.toMatch(/›\s+─/);
  });

  it.each([
    [13, true],
    [12, false],
  ] as const)(
    'uses the expected layout at the %i-row boundary',
    (availableTerminalHeight, hasFullLayout) => {
      const { lastFrame } = renderDialog({ availableTerminalHeight });

      const frame = lastFrame() ?? '';
      expect(frame.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame.includes('Configure Status Line')).toBe(hasFullLayout);
    },
  );

  it('uses every available row in an intermediate compact layout', () => {
    const { lastFrame } = renderDialog({ availableTerminalHeight: 5 });

    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(5);
    expect(lastFrame()).toContain('model-with-reasoning');
  });

  it('keeps every option reachable in a one-line layout', async () => {
    const { stdin, lastFrame } = renderDialog({ availableTerminalHeight: 1 });

    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(1);
    expect(lastFrame()).not.toContain('Configure Status Line');

    for (let i = 0; i < STATUS_LINE_PRESET_ITEMS.length; i++) {
      act(() => {
        stdin.write('j');
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lastFrame()).toMatch(/›.*session-id/);
  });

  it('bypasses a hidden query in compact mode and restores it', async () => {
    const settings = createSettings();
    const renderAt = (availableTerminalHeight: number) =>
      dialog({ settings, availableTerminalHeight });
    const { stdin, lastFrame, rerender } = render(renderAt(18));

    act(() => stdin.write('identifier'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastFrame()).toContain('> identifier');
    expect(lastFrame()).toContain('session-id');
    expect(lastFrame()).not.toContain('project-name');

    rerender(renderAt(12));
    expect(lastFrame()).not.toContain('Type to search');
    expect(lastFrame()).toContain('project-name');

    rerender(renderAt(18));
    expect(lastFrame()).toContain('> identifier');
    expect(lastFrame()).toContain('session-id');
    expect(lastFrame()).not.toContain('project-name');
  });

  it('closes on escape in the compact layout', async () => {
    // Below the full-layout threshold, query input and backspace are gated
    // off and MultiSelect has no escape handling of its own — the
    // fall-through to onClose() is the dialog's only dismissal path.
    const onClose = vi.fn();
    const { stdin } = renderDialog({
      onClose,
      availableTerminalHeight: 5,
    });

    act(() => {
      stdin.write('\u001b');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onClose).toHaveBeenCalled();
  });

  it('stays within the height budget at 10 columns', () => {
    const { lastFrame, unmount } = renderDialog(
      { availableTerminalHeight: 20 },
      10,
    );
    try {
      expect(lastFrame()).toContain('[x]');
      expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(20);
    } finally {
      unmount();
    }
  });

  it('keeps the empty picker within its budget without an internal preview', () => {
    const settings = createSettings();
    settings.user.settings.ui = {
      statusLine: { type: 'preset', useThemeColors: false, items: [] },
    };
    settings.recomputeMerged();
    const { lastFrame, unmount } = renderDialog(
      { settings, availableTerminalHeight: 20 },
      50,
    );
    try {
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('Select at least one item');
      expect(frame).not.toContain('Preview');
      expect(frame.split('\n').length).toBeLessThanOrEqual(20);
    } finally {
      unmount();
    }
  });
});
