/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { DiffStatsDisplay } from './DiffStatsDisplay.js';
import type { DiffRenderModel } from '../../types.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('DiffStatsDisplay', () => {
  it('renders header and per-file rows aligned in columns', () => {
    const model: DiffRenderModel = {
      filesCount: 2,
      linesAdded: 7,
      linesRemoved: 3,
      hiddenCount: 0,
      rows: [
        {
          filename: 'src/a.ts',
          added: 5,
          removed: 2,
          isBinary: false,
          isUntracked: false,
          isDeleted: false,
          truncated: false,
        },
        {
          filename: 'src/b.ts',
          added: 2,
          removed: 1,
          isBinary: false,
          isUntracked: false,
          isDeleted: false,
          truncated: false,
        },
      ],
    };
    const { lastFrame } = render(<DiffStatsDisplay model={model} />);
    const visible = stripAnsi(lastFrame() ?? '');
    expect(visible).toContain('2 files changed');
    expect(visible).toContain('+7');
    expect(visible).toContain('-3');
    const aRow = visible.split('\n').find((l) => l.endsWith('src/a.ts'))!;
    const bRow = visible.split('\n').find((l) => l.endsWith('src/b.ts'))!;
    // Columns align — "src/a.ts" and "src/b.ts" start at the same offset.
    expect(aRow.indexOf('src/a.ts')).toBe(bRow.indexOf('src/b.ts'));
  });

  it('renders the (new) marker for untracked text files', () => {
    const model: DiffRenderModel = {
      filesCount: 1,
      linesAdded: 3,
      linesRemoved: 0,
      hiddenCount: 0,
      rows: [
        {
          filename: 'notes.md',
          added: 3,
          removed: 0,
          isBinary: false,
          isUntracked: true,
          isDeleted: false,
          truncated: false,
        },
      ],
    };
    const { lastFrame } = render(<DiffStatsDisplay model={model} />);
    const visible = stripAnsi(lastFrame() ?? '');
    expect(visible).toContain('notes.md');
    expect(visible).toContain('(new)');
    expect(visible).not.toContain('(new, partial)');
  });

  it('renders the (new, partial) marker for truncated untracked text files', () => {
    const model: DiffRenderModel = {
      filesCount: 1,
      linesAdded: 10000,
      linesRemoved: 0,
      hiddenCount: 0,
      rows: [
        {
          filename: 'big.log',
          added: 10000,
          removed: 0,
          isBinary: false,
          isUntracked: true,
          isDeleted: false,
          truncated: true,
        },
      ],
    };
    const visible = stripAnsi(
      render(<DiffStatsDisplay model={model} />).lastFrame() ?? '',
    );
    expect(visible).toContain('(new, partial)');
  });

  it('renders the (deleted) marker for tracked files removed from the worktree', () => {
    const model: DiffRenderModel = {
      filesCount: 1,
      linesAdded: 0,
      linesRemoved: 5,
      hiddenCount: 0,
      rows: [
        {
          filename: 'gone.txt',
          added: 0,
          removed: 5,
          isBinary: false,
          isUntracked: false,
          isDeleted: true,
          truncated: false,
        },
      ],
    };
    const visible = stripAnsi(
      render(<DiffStatsDisplay model={model} />).lastFrame() ?? '',
    );
    const row = visible.split('\n').find((l) => l.includes('gone.txt'))!;
    expect(row).toContain('(deleted)');
    expect(row).toContain('-5');
  });

  it('renders binary rows with a ~ marker and no +N/-M', () => {
    const model: DiffRenderModel = {
      filesCount: 1,
      linesAdded: 0,
      linesRemoved: 0,
      hiddenCount: 0,
      rows: [
        {
          filename: 'img.png',
          isBinary: true,
          isUntracked: false,
          isDeleted: false,
          truncated: false,
        },
      ],
    };
    const visible = stripAnsi(
      render(<DiffStatsDisplay model={model} />).lastFrame() ?? '',
    );
    const rowLine = visible.split('\n').find((l) => l.includes('img.png'))!;
    expect(rowLine).toContain('~');
    expect(rowLine).toContain('(binary)');
    expect(rowLine).not.toMatch(/\+\d/);
  });

  it('renders the "…and N more" note when hiddenCount > 0', () => {
    const model: DiffRenderModel = {
      filesCount: 60,
      linesAdded: 100,
      linesRemoved: 20,
      hiddenCount: 59,
      rows: [
        {
          filename: 'src/a.ts',
          added: 1,
          removed: 0,
          isBinary: false,
          isUntracked: false,
          isDeleted: false,
          truncated: false,
        },
      ],
    };
    const visible = stripAnsi(
      render(<DiffStatsDisplay model={model} />).lastFrame() ?? '',
    );
    expect(visible).toContain('60 files changed');
    expect(visible).toMatch(/59 more/);
  });
});
