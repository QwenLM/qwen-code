/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { shellTaskPanelTitle } from './TasksStatusMessage';

describe('shellTaskPanelTitle', () => {
  it('uses the executable basename instead of the full command', () => {
    expect(
      shellTaskPanelTitle(
        '/opt/homebrew/opt/mariadb@10.11/bin/mariadbd --datadir=/tmp/fg12d-db',
      ),
    ).toBe('mariadbd');
  });

  it('skips leading environment assignments', () => {
    expect(shellTaskPanelTitle('FOO=1 BAR=2 node server.js')).toBe('node');
  });

  it('returns an empty string for an empty command', () => {
    expect(shellTaskPanelTitle('')).toBe('');
  });

  it('keeps a quoted executable together', () => {
    expect(shellTaskPanelTitle('"my script.sh" --flag')).toBe('my script.sh');
  });

  it('skips quoted environment assignments', () => {
    expect(shellTaskPanelTitle('FOO="a b" node server.js')).toBe('node');
  });
});
