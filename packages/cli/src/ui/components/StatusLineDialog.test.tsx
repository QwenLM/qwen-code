/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { UIState } from '../contexts/UIStateContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { MessageType, StreamingState } from '../types.js';
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

const uiState = {
  currentModel: 'qwen3-code-plus',
  branchName: 'feature/pr-4087-statusline',
  streamingState: StreamingState.Idle,
  sessionStats: {
    sessionId: 'session-123',
    lastPromptTokenCount: 250,
    metrics: {
      models: {},
      files: { totalLinesAdded: 12, totalLinesRemoved: 3 },
    },
  },
} as UIState;

describe('StatusLineDialog', () => {
  it('renders a searchable preset picker with preview', () => {
    const settings = createSettings();
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StatusLineDialog
          settings={settings}
          config={config}
          uiState={uiState}
          addItem={vi.fn()}
          onClose={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

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
    expect(lastFrame()).toContain('Preview');
    expect(lastFrame()).toContain('Qwen3 Code Plus high');
  });

  it('persists selected presets on enter', async () => {
    const settings = createSettings();
    const addItem = vi.fn();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StatusLineDialog
          settings={settings}
          config={config}
          uiState={uiState}
          addItem={addItem}
          onSaved={onSaved}
          onClose={onClose}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

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
    expect(onSaved).toHaveBeenCalledWith(settings.merged.ui?.statusLine);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps preset priority order after an item is toggled off and on', async () => {
    const settings = createSettings();
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StatusLineDialog
          settings={settings}
          config={config}
          uiState={uiState}
          addItem={vi.fn()}
          onClose={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

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

    expect(lastFrame()).toContain(
      '\u279c  project git:(feature/pr-4087-statusline) · Qwen3 Code Plus high · Context 25% used',
    );

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

  it('saves back to workspace settings when workspace config is effective', async () => {
    const settings = createSettings();
    settings.workspace.settings.ui = {
      statusLine: {
        type: 'preset',
        useThemeColors: false,
        items: ['model'],
      },
    };
    settings.workspace.originalSettings.ui = settings.workspace.settings.ui;
    settings.recomputeMerged();
    const addItem = vi.fn();
    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StatusLineDialog
          settings={settings}
          config={config}
          uiState={uiState}
          addItem={addItem}
          onClose={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

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
      },
    });
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Status line preset saved to workspace settings.',
      },
      expect.any(Number),
    );
  });

  it('does not append navigation keys to the search query', async () => {
    const settings = createSettings();
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StatusLineDialog
          settings={settings}
          config={config}
          uiState={uiState}
          addItem={vi.fn()}
          onClose={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

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
});
