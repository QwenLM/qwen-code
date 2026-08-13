/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../../config/settings.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { SkillsManagerDialog } from './SkillsManagerDialog.js';

const lockedSkills: SkillConfig[] = ['one', 'two', 'three', 'four', 'five'].map(
  (name) => ({
    name,
    description: `${name} skill`,
    level: 'user',
    filePath: `/skills/${name}/SKILL.md`,
    body: '',
  }),
);

function createSettings(): LoadedSettings {
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    {
      path: '',
      settings: {
        skills: { disabled: lockedSkills.map((skill) => skill.name) },
      },
      originalSettings: {},
    },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );
}

describe('SkillsManagerDialog', () => {
  it('fits locked skills within a small height budget', async () => {
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(lockedSkills),
      }),
    } as unknown as Config;
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('one'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    expect(lastFrame()).not.toContain('two');

    act(() => {
      stdin.write('two');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('two'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps every locked skill without a height constraint', async () => {
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(lockedSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('two'));
  });
});
