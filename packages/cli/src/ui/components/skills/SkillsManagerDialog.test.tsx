/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ComponentProps } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../../config/settings.js';
import { setLanguageAsync } from '../../../i18n/index.js';
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
const manyLockedSkills: SkillConfig[] = Array.from({ length: 12 }, (_, i) => {
  const name = `locked-${String(i + 1).padStart(2, '0')}`;
  return {
    name,
    description: `${name} skill`,
    level: 'user' as const,
    filePath: `/skills/${name}/SKILL.md`,
    body: '',
  };
});
const verboseSkills: SkillConfig[] = ['alpha', 'beta', 'gamma'].map((name) => ({
  name,
  description: `A fairly long ${name} description that runs on and on and on`,
  level: 'user' as const,
  filePath: `/skills/${name}/SKILL.md`,
  body: '',
}));

function createConfig(skills: SkillConfig[]): Config {
  const skillManager = { listSkills: vi.fn().mockResolvedValue(skills) };
  return { getSkillManager: () => skillManager } as unknown as Config;
}

function createSettings(
  disabled = lockedSkills.map((skill) => skill.name),
): LoadedSettings {
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    {
      path: '',
      settings: { skills: { disabled } },
      originalSettings: {},
    },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );
}

type DialogProps = ComponentProps<typeof SkillsManagerDialog>;

function dialog(overrides: Partial<DialogProps> = {}) {
  return (
    <KeypressProvider kittyProtocolEnabled={false}>
      <SkillsManagerDialog
        settings={createSettings()}
        config={createConfig(mixedSkills)}
        addItem={vi.fn()}
        onClose={vi.fn()}
        reloadCommands={vi.fn()}
        setInputBuffer={vi.fn()}
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

describe('SkillsManagerDialog', () => {
  it.each([18, 11, 10, 8, 5, 3, 1])(
    'keeps the interactive list within a %i-row budget',
    async (availableTerminalHeight) => {
      const { lastFrame } = renderDialog({ availableTerminalHeight });

      await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
    },
  );

  it('keeps bare-mode navigation and escape active with a retained query', async () => {
    const settings = createSettings([]);
    const config = createConfig(mixedSkills.slice(5));
    const onClose = vi.fn();
    const renderAt = (availableTerminalHeight: number) =>
      dialog({ settings, config, onClose, availableTerminalHeight });
    const { stdin, lastFrame, rerender } = render(renderAt(18));

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    act(() => stdin.write('six'));
    await vi.waitFor(() => expect(lastFrame()).toContain('Search: six'));

    rerender(renderAt(5));
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Search:'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(5);
    expect(lastFrame()).toContain('› [x] eight');
    act(() => stdin.write('j'));
    await vi.waitFor(() => expect(lastFrame()).toContain('› [x] nine'));

    act(() => stdin.write('\u001B'));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('prioritizes unlocked rows and summarizes locked skills', async () => {
    const { lastFrame } = renderDialog({ availableTerminalHeight: 18 });

    await vi.waitFor(() => expect(lastFrame()).toContain('six skill'));
    expect(lastFrame()).toContain('(+5 locked)');
    expect(lastFrame()).not.toContain('one skill');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([12, 5, 1])(
    'uses one locked-count row when every skill is locked at %i rows',
    async (availableTerminalHeight) => {
      const { lastFrame } = renderDialog({
        config: createConfig(lockedSkills),
        availableTerminalHeight,
      });

      await vi.waitFor(() => expect(lastFrame()).toContain('(+5 locked)'));
      expect(lastFrame()).not.toContain('one skill');
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
    },
  );

  it('does not search hidden locked rows in a constrained dialog', async () => {
    const { stdin, lastFrame } = renderDialog({
      availableTerminalHeight: 18,
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('six skill'));
    act(() => stdin.write('one'));
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('No skills match the search.'),
    );
    expect(lastFrame()).toContain('0 / 10 skills');
    expect(lastFrame()).not.toContain('one skill');
  });

  it('shows every locked skill without a height constraint', async () => {
    const { lastFrame } = renderDialog({
      settings: createSettings(manyLockedSkills.map((skill) => skill.name)),
      config: createConfig(manyLockedSkills),
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('locked-12'));
    expect(lastFrame()).toContain('locked-01');
    expect(lastFrame()).toContain(
      'Locked by higher-scope settings (cannot toggle here):',
    );
    expect(lastFrame()).not.toContain('(+12 locked)');
  });

  it('keeps the translated title on one row at narrow widths', async () => {
    await setLanguageAsync('ca');
    const result = renderDialog({ availableTerminalHeight: 12 }, 26);
    try {
      await vi.waitFor(() => expect(result.lastFrame()).toContain('Gestiona'));
      expect(result.lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
    } finally {
      result.unmount();
      await setLanguageAsync('en');
    }
  });

  it.each([80, 54, 30])(
    'keeps item rows single at %i columns',
    async (terminalWidth) => {
      const { lastFrame } = renderDialog(
        {
          settings: createSettings([]),
          config: createConfig(verboseSkills),
          availableTerminalHeight: 16,
          terminalWidth,
        },
        terminalWidth,
      );

      await vi.waitFor(() => expect(lastFrame()).toContain('alpha'));
      expect(lastFrame()).toContain('…');
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(16);
    },
  );

  it('collapses multi-line descriptions', async () => {
    const skills: SkillConfig[] = [
      {
        name: 'multiline-locked',
        description: 'first line\nsecond line',
        level: 'user',
        filePath: '/skills/multiline-locked/SKILL.md',
        body: '',
      },
      {
        name: 'multiline',
        description: 'third line\nfourth line',
        level: 'user',
        filePath: '/skills/multiline/SKILL.md',
        body: '',
      },
    ];
    const { lastFrame } = renderDialog({
      settings: createSettings(['multiline-locked']),
      config: createConfig(skills),
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('multiline'));
    expect(lastFrame()).toContain('first line second line');
    expect(lastFrame()).toContain('third line fourth line');
  });

  it('keeps a long search query within a narrow height budget', async () => {
    const { stdin, lastFrame } = renderDialog(
      { availableTerminalHeight: 12, terminalWidth: 54 },
      54,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    act(() => stdin.write('x'.repeat(80)));
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('No skills match the search.'),
    );
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
  });
});
