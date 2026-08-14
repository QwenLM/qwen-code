/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ReactElement } from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../../config/settings.js';
import { setLanguageAsync } from '../../../i18n/index.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { SkillsManagerDialog } from './SkillsManagerDialog.js';

// ink-testing-library hard-codes a 100-column buffer, so wrap-driven
// overflow below 100 columns can never fail a budget assertion. Render
// through ink directly with a fake narrow stdout — same pattern as
// DiffDialog.test.tsx's renderWide.
const renderNarrow = (columns: number, ui: ReactElement) => {
  let lastFrame = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: (frame: string) => {
      lastFrame = frame;
    },
  });
  const stderr = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: () => {},
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  const instance = inkRender(ui, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // debug:true writes the full frame synchronously (true widths) instead
    // of throttled cursor-diff output, so row counts can be measured.
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    lastFrame: () => lastFrame.replace(/\n+$/, ''),
    type: (text: string) => {
      stdin.emit('data', Buffer.from(text));
    },
    unmount: instance.unmount,
  };
};

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
// Realistic >50-char descriptions make uncapped labels ~110 cells, wrapping
// to 2 rows and overflowing the budget without a width-derived cap.
const verboseSkills: SkillConfig[] = ['alpha', 'beta', 'gamma'].map((name) => ({
  name,
  description: `A fairly long ${name} description that runs on and on and on`,
  level: 'user' as const,
  filePath: `/skills/${name}/SKILL.md`,
  body: '',
}));

// The component's useEffect(..., [skillManager]) re-fires whenever the
// manager identity changes, so the manager must be a stable object per
// test — `getSkillManager: () => ({ ... })` would create an unbounded
// re-fetch/re-render loop.
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
    const skillManager = {
      listSkills: vi.fn().mockResolvedValue(lockedSkills),
    };
    const config = { getSkillManager: () => skillManager } as unknown as Config;
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
    // A fresh manager object per getSkillManager() call would re-fire the
    // loading effect on every render — an unbounded re-fetch loop.
    expect(skillManager.listSkills).toHaveBeenCalledTimes(1);

    act(() => {
      stdin.write('two');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('two'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    expect(lastFrame()).not.toContain('Hidden locked skills');
  });

  it('does not point to an empty locked section', async () => {
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={createConfig(lockedSkills)}
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

  it('shows the locked hint in the forced list row at a minimal budget', async () => {
    // residual === 1 (budget 12): the forced unlocked-row claim renders
    // nothing when every skill is locked, and the hint used to be dropped
    // with it — leaving an empty list area with no sign of locked skills.
    const threeLocked = lockedSkills.slice(0, 3);
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(threeLocked.map((skill) => skill.name))}
          config={createConfig(threeLocked)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={12}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Hidden locked skills: 3'),
    );
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('sheds chrome to fit budgets the fixed frame cannot', async () => {
    // Budgets below the 11-row frame used to render 12 rows regardless
    // (round-5 R5-1); compact mode drops border, paddingY, and footer so
    // the always-rendered list row fits.
    const unlocked = mixedSkills.slice(5);
    for (const budget of [11, 10, 8]) {
      const { lastFrame, unmount } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SkillsManagerDialog
            settings={createSettings([])}
            config={createConfig(unlocked)}
            addItem={vi.fn()}
            onClose={vi.fn()}
            reloadCommands={vi.fn()}
            setInputBuffer={vi.fn()}
            availableTerminalHeight={budget}
          />
        </KeypressProvider>,
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('eight skill'));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(budget);
      unmount();
    }
  });

  it('surfaces locked matches at a budget the full frame cannot fit', async () => {
    // Round-5 R5-1 secondary symptom: at residual === 0 a locked-only
    // query left the list area blank while the subtitle advertised
    // matches.
    const { stdin, lastFrame, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={createConfig(lockedSkills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={11}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Hidden locked skills: 3'),
    );
    act(() => {
      stdin.write('two');
    });
    await vi.waitFor(() => expect(lastFrame()).toContain('two skill'));
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(11);
    unmount();
  });

  it('notes locked skills in the subtitle when no locked row fits', async () => {
    // Round-5 R5-6: at residual === 1 (budget 12) in the mixed layout the
    // locked block used to vanish without a trace; the subtitle now
    // carries the count.
    const skills = [...lockedSkills.slice(0, 2), ...mixedSkills.slice(5, 8)];
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two'])}
          config={createConfig(skills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={12}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('(+2 locked)'));
    expect(lastFrame()).not.toContain('Hidden locked skills');
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('keeps the translated title on one row at narrow widths', async () => {
    // ca's 23-cell title wraps below ~27 columns and pushed the dialog one
    // row past its budget (round-5 R5-2); wrap="truncate" caps it.
    await setLanguageAsync('ca');
    try {
      const { lastFrame, unmount } = renderNarrow(
        26,
        <KeypressProvider kittyProtocolEnabled={false}>
          <SkillsManagerDialog
            settings={createSettings(['one'])}
            config={createConfig(mixedSkills)}
            addItem={vi.fn()}
            onClose={vi.fn()}
            reloadCommands={vi.fn()}
            setInputBuffer={vi.fn()}
            availableTerminalHeight={12}
          />
        </KeypressProvider>,
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('Gestiona'));
      expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
      unmount();
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('fits mixed locked and unlocked skills within the height budget', async () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two'])}
          config={createConfig(mixedSkills)}
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
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(manyLockedSkills.map((skill) => skill.name))}
          config={createConfig(manyLockedSkills)}
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
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two'])}
          config={createConfig(mixedSkills)}
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
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one'])}
          config={createConfig(mixedSkills)}
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
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['one', 'two', 'three', 'four'])}
          config={createConfig(mixedSkills)}
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
    // Realistic >50-char descriptions make uncapped labels ~110 cells,
    // wrapping to 2 rows and overflowing the budget. With terminalWidth
    // 80 the width-derived cap must keep each item on a single row.
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings([])}
          config={createConfig(verboseSkills)}
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
    // Exact count: 11 fixed rows + 3 single-row items. Any label wrapping
    // (or doubling) pushes the total beyond the budget.
    expect(lastFrame()?.split('\n').length).toBe(14);
    // Cap = 80 - 10 overhead = 70 cells: the ~110-cell label is clipped.
    expect(lastFrame()).toMatch(/alpha.*…/);
  });

  it('renders multi-line descriptions on single rows', async () => {
    // YAML block scalars (`description: |` / `>`) can carry newlines into a
    // skill description; each rendered row must still be exactly one
    // terminal row or the height budget overflows.
    const newlineSkills: SkillConfig[] = [
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
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings(['multiline-locked'])}
          config={createConfig(newlineSkills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={15}
        />
      </KeypressProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('multiline'));
    expect(lastFrame()).toContain('first line second line');
    expect(lastFrame()).toContain('third line fourth line');
    // Exact fit: 11 fixed + 1 unlocked row + 3 locked-block rows. A raw
    // newline in either description inflates its row and overflows.
    expect(lastFrame()?.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('stays within the height budget at a 54-column terminal width', async () => {
    // Wrap-driven overflow below ink-testing-library's 100 columns: at 54
    // columns the width-derived cap (54 - 10 = 44) must keep every label
    // on one row.
    const { lastFrame, unmount } = renderNarrow(
      54,
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings([])}
          config={createConfig(verboseSkills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={16}
          terminalWidth={54}
        />
      </KeypressProvider>,
    );
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('alpha'));
      expect(lastFrame().split('\n').length).toBeLessThanOrEqual(16);
    } finally {
      unmount();
    }
  });

  it('keeps item rows single at a 30-column terminal width', async () => {
    // Below ~34 columns a labelCap floor at the 24-cell name column would
    // exceed the available label width (30 - 10 overhead = 20) and wrap
    // every item to 2 rows — the floor must be 1 instead.
    const { lastFrame, unmount } = renderNarrow(
      30,
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings([])}
          config={createConfig(verboseSkills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={16}
          terminalWidth={30}
        />
      </KeypressProvider>,
    );
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('alpha'));
      expect(lastFrame().split('\n').length).toBeLessThanOrEqual(16);
    } finally {
      unmount();
    }
  });

  it('keeps the search row on one line for long queries at narrow widths', async () => {
    // The search row is counted as exactly one row in the fixed budget; a
    // query longer than the content width must truncate, not wrap.
    const { lastFrame, type, unmount } = renderNarrow(
      54,
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={createConfig(lockedSkills)}
          addItem={vi.fn()}
          onClose={vi.fn()}
          reloadCommands={vi.fn()}
          setInputBuffer={vi.fn()}
          availableTerminalHeight={12}
          terminalWidth={54}
        />
      </KeypressProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('Hidden locked skills: 5'),
      );
      act(() => {
        type('x'.repeat(80));
      });
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('No skills match the search.'),
      );
      expect(lastFrame().split('\n').length).toBeLessThanOrEqual(12);
    } finally {
      unmount();
    }
  });

  it('shows the no-match message instead of a dangling (see below) pointer', async () => {
    const { stdin, lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SkillsManagerDialog
          settings={createSettings()}
          config={createConfig(lockedSkills)}
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
