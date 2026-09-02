/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ComponentProps } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { LoadedSettings, SettingScope } from '../../../config/settings.js';
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

function createConfig(skills: SkillConfig[]): Config {
  const skillManager = {
    listSkills: vi.fn().mockResolvedValue(skills),
    suppressNextSlashReload: vi.fn(),
    notifyConfigChanged: vi.fn(async () => undefined),
  };
  return {
    getSkillManager: () => skillManager,
    isSkillEnabled: vi.fn().mockReturnValue(true),
  } as unknown as Config;
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
  it.each([18, 12, 11, 6, 5, 1])(
    'keeps the interactive list within a %i-row budget',
    async (availableTerminalHeight) => {
      const { lastFrame } = renderDialog({ availableTerminalHeight });

      await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
    },
  );

  it('keeps bare-mode keys active without changing a retained query', async () => {
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

    act(() => {
      stdin.write('z');
      stdin.write('\x7f');
      stdin.write('\x7f');
    });
    act(() => stdin.write('j'));
    await vi.waitFor(() => expect(lastFrame()).toContain('› [x] nine'));
    act(() => stdin.write('k'));
    await vi.waitFor(() => expect(lastFrame()).toContain('› [x] eight'));

    act(() => stdin.write('\u001B'));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    rerender(renderAt(18));
    expect(lastFrame()).toContain('Search: six');
  });

  it('picks the visibly highlighted skill after entering bare mode', async () => {
    const settings = createSettings([]);
    const config = createConfig(mixedSkills.slice(5));
    const onClose = vi.fn();
    const setInputBuffer = vi.fn();
    const renderAt = (availableTerminalHeight: number) =>
      dialog({
        settings,
        config,
        onClose,
        setInputBuffer,
        availableTerminalHeight,
      });
    const { stdin, lastFrame, rerender } = render(renderAt(18));

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    act(() => stdin.write('six'));
    await vi.waitFor(() => expect(lastFrame()).toContain('Search: six'));

    rerender(renderAt(5));
    await vi.waitFor(() => expect(lastFrame()).toContain('› [x] eight'));
    act(() => stdin.write('\r'));

    await vi.waitFor(() =>
      expect(setInputBuffer).toHaveBeenCalledWith('/eight'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('searches unlocked rows but not hidden locked rows when constrained', async () => {
    const { stdin, lastFrame } = renderDialog({
      availableTerminalHeight: 8,
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    act(() => stdin.write('six'));
    await vi.waitFor(() => expect(lastFrame()).toContain('six skill'));
    expect(lastFrame()).toContain('1 / 10 skills');

    act(() => stdin.write('\u001B'));
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Search: six'));
    act(() => stdin.write('one'));
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('No skills match the search.'),
    );
    expect(lastFrame()).toContain('0 / 10 skills');
    expect(lastFrame()).not.toContain('one skill');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(8);
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

  it('shows locked-only search results without an empty state', async () => {
    const { stdin, lastFrame } = renderDialog();

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    act(() => stdin.write('one'));

    await vi.waitFor(() => expect(lastFrame()).toContain('one skill'));
    expect(lastFrame()).toContain(
      'Locked by higher-scope settings (cannot toggle here):',
    );
    expect(lastFrame()).not.toContain('No skills match the search.');
    expect(lastFrame()).not.toContain('[x]');
  });

  it('persists toggles and refreshes skills on escape', async () => {
    const settings = createSettings();
    const setValues = vi
      .spyOn(settings, 'setValues')
      .mockImplementation(() => undefined);
    const config = createConfig(mixedSkills);
    const skillManager = config.getSkillManager()!;
    const reloadCommands = vi.fn();
    const onClose = vi.fn();
    const { stdin, lastFrame } = renderDialog({
      settings,
      config,
      reloadCommands,
      onClose,
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('› [x] eight'));
    act(() => stdin.write(' '));
    await vi.waitFor(() => expect(lastFrame()).toContain('› [ ] eight'));
    act(() => stdin.write('\u001B'));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(setValues).toHaveBeenCalledWith([
      {
        scope: SettingScope.Workspace,
        key: 'skills.disabled',
        value: ['eight'],
      },
    ]);
    expect(reloadCommands).toHaveBeenCalledTimes(1);
    expect(skillManager.suppressNextSlashReload).toHaveBeenCalledTimes(1);
    expect(skillManager.notifyConfigChanged).toHaveBeenCalledTimes(1);
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

  it('keeps item rows within the height budget at 10 columns', async () => {
    const { lastFrame } = renderDialog(
      {
        settings: createSettings([]),
        availableTerminalHeight: 16,
      },
      10,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('[x]'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(16);
  });

  it.each([
    ['loading', 1, false],
    ['loading', 6, false],
    ['loading', 12, false],
    ['error', 1, true],
    ['error', 6, true],
    ['error', 12, true],
  ])(
    'keeps %s state within a %i-row budget',
    async (_state, availableTerminalHeight, rejects) => {
      const listSkills = rejects
        ? vi.fn().mockRejectedValue(new Error('load failed'))
        : vi.fn(() => new Promise<SkillConfig[]>(() => undefined));
      const config = {
        getSkillManager: () => ({ listSkills }),
      } as unknown as Config;
      const { lastFrame } = renderDialog({
        config,
        availableTerminalHeight,
      });

      await vi.waitFor(() =>
        expect(lastFrame()).toContain(
          rejects ? 'Failed to load skills' : 'Loading skills',
        ),
      );
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
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
      { availableTerminalHeight: 12 },
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
