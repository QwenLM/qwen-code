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
// More skills than the pre-fix default locked budget (24 - 11 - 3 = 10) so a
// regression to a numeric default truncates the list and fails the
// unconstrained test below.
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
        listSkills: vi.fn().mockResolvedValue(manyLockedSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(manyLockedSkills.map((skill) => skill.name))}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('locked-12'));
    expect(lastFrame()).not.toContain('Hidden locked skills');
  });

  it('surfaces locked matches when search filters out every unlocked skill', async () => {
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(mixedSkills),
      }),
    } as unknown as Config;
    const { stdin, lastFrame } = render(
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
    act(() => {
      stdin.write('one');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('one skill'));
    expect(lastFrame()).not.toContain('No skills match the search.');
  });

  it('never renders beyond a minimal height budget', async () => {
    // With >=1 locked + >=1 unlocked skill the pre-fix dialog had an
    // irreducible 13-row frame (fixed rows + forced item + locked hint),
    // so a 12-row budget clipped the footer. The hint must be dropped
    // before the dialog overflows.
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(mixedSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one'])}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={12}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('gives the interactive unlocked list first claim on the budget', async () => {
    // Pre-fix the locked block claimed rows first, leaving a single
    // actionable item at this budget. The unlocked list must get its rows
    // first and the locked block collapse into the hint counter.
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(mixedSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two', 'three', 'four'])}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={18}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Hidden locked skills: 4'),
    );
    // The 6th unlocked row is visible — pre-fix only 1 item fit.
    expect(lastFrame()).toContain('six skill');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps long labels on one row at narrow widths', async () => {
    // Realistic >50-char descriptions make uncapped labels ~118 cells,
    // wrapping to 2 rows and overflowing the budget. With terminalWidth
    // 80 the width-derived cap must keep each item on a single row.
    const verboseSkills: SkillConfig[] = ['alpha', 'beta', 'gamma'].map(
      (name) => ({
        name,
        description: `A fairly long ${name} description that runs on`,
        level: 'user' as const,
        filePath: `/skills/${name}/SKILL.md`,
        body: '',
      }),
    );
    const config = {
      getSkillManager: () => ({
        listSkills: vi.fn().mockResolvedValue(verboseSkills),
      }),
    } as unknown as Config;
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings([])}
          config={config}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={18}
          terminalWidth={80}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('alpha'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    // Cap = 80 - 10 overhead = 70 cells: the ~75-cell label is clipped.
    expect(lastFrame()).toMatch(/alpha.*…/);
  });

  it('shows the no-match message instead of a dangling (see below) pointer', async () => {
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

    await vi.waitFor(() => expect(lastFrame()).toContain('(see below)'));
    act(() => {
      stdin.write('zzz');
    });
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('No skills match the search.'),
    );
    expect(lastFrame()).not.toContain('(see below)');
  });
});
