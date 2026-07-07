/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseTmuxListPanes } from './tmux-commands.js';

describe('parseTmuxListPanes', () => {
  it('parses a single running pane', () => {
    const output = '%0 0 0\n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([{ paneId: '%0', dead: false, deadStatus: 0 }]);
  });

  it('parses a single dead pane with exit code', () => {
    const output = '%1 1 42\n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([{ paneId: '%1', dead: true, deadStatus: 42 }]);
  });

  it('parses multiple panes with mixed statuses', () => {
    const output = '%0 0 0\n%1 1 1\n%2 0 0\n%3 1 137\n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([
      { paneId: '%0', dead: false, deadStatus: 0 },
      { paneId: '%1', dead: true, deadStatus: 1 },
      { paneId: '%2', dead: false, deadStatus: 0 },
      { paneId: '%3', dead: true, deadStatus: 137 },
    ]);
  });

  it('returns empty array for empty output', () => {
    expect(parseTmuxListPanes('')).toEqual([]);
  });

  it('returns empty array for whitespace-only output', () => {
    expect(parseTmuxListPanes('  \n  \n')).toEqual([]);
  });

  it('skips lines with insufficient fields', () => {
    const output = '%0\n%1 1 0\n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([{ paneId: '%1', dead: true, deadStatus: 0 }]);
  });

  it('defaults deadStatus to 0 when missing', () => {
    // tmux might omit the third field when pane is alive
    const output = '%0 0\n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([{ paneId: '%0', dead: false, deadStatus: 0 }]);
  });

  it('handles extra whitespace gracefully', () => {
    const output = '  %5   1   99  \n';
    const result = parseTmuxListPanes(output);
    expect(result).toEqual([{ paneId: '%5', dead: true, deadStatus: 99 }]);
  });
});
