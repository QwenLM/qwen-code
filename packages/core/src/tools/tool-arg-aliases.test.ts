/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applyToolArgAliases } from './tool-arg-aliases.js';

function aliased(toolName: string, args: Record<string, unknown>) {
  applyToolArgAliases(toolName, args);
  return args;
}

describe('applyToolArgAliases', () => {
  it.each(['read_file', 'write_file', 'edit'])(
    'renames path to file_path for %s',
    (toolName) => {
      expect(aliased(toolName, { path: '/repo/a.py', limit: 5 })).toEqual({
        file_path: '/repo/a.py',
        limit: 5,
      });
    },
  );

  it("renames edit's old_str and new_str", () => {
    expect(
      aliased('edit', { path: '/repo/a.py', old_str: 'a', new_str: 'b' }),
    ).toEqual({ file_path: '/repo/a.py', old_string: 'a', new_string: 'b' });
  });

  it('leaves an alias next to its canonical name', () => {
    expect(
      aliased('read_file', { file_path: '/repo/a.py', path: '/repo/b.py' }),
    ).toEqual({ file_path: '/repo/a.py', path: '/repo/b.py' });
  });

  it('resolves legacy tool names', () => {
    expect(aliased('replace', { path: '/repo/a.py' })).toEqual({
      file_path: '/repo/a.py',
    });
  });

  it('ignores arguments that are not an object', () => {
    expect(() =>
      applyToolArgAliases(
        'read_file',
        null as unknown as Record<string, unknown>,
      ),
    ).not.toThrow();
  });

  it.each([
    ['grep_search', { path: '/repo', pattern: 'x' }],
    ['run_shell_command', { cmd: 'ls' }],
    ['constructor', { path: '/repo' }],
  ])('leaves %s alone', (toolName, args) => {
    expect(aliased(toolName, { ...args })).toEqual(args);
  });
});
