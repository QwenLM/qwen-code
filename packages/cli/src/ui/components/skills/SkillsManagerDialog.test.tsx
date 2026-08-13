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
const mixedSkills: SkillConfig[] = [
  ...lockedSkills,
  ...['six', 'seven', 'eight', 'nine', 'ten'].map((name) => ({
    name,
    description: `${name} skill`,
    level: 'user' as const,
    filePath: `/skills/${name}/SKILL.md`,
    body: '',
  })),
];

function createSettings(
  disabled = lockedSkills.map((skill) => skill.name),
): LoadedSettings {
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    {
      path: '',
      settings: {
        skills: { disabled },
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
    expect(lastFrame()).toContain('Hidden locked skills: 2');

    act(() => {
      stdin.write('two');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('two'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    expect(lastFrame()).not.toContain('Hidden locked skills');
  });

  it('does not point to an empty locked section', async () => {
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
          availableTerminalHeight={14}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Hidden locked skills: 5'),
    );
    expect(lastFrame()).not.toContain('(see below)');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(14);

    act(() => {
      stdin.write('two');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('two skill'));
    expect(lastFrame()).not.toContain('Hidden locked skills');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(14);
  });

  it('fits mixed locked and unlocked skills within the height budget', async () => {
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(mixedSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two'])}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
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
