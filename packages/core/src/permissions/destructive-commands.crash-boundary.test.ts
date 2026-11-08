/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// Force an internal evaluation error on a sentinel command: the guard's
// catch boundary (#16075 R15-3) must turn ANY throw into manual approval,
// never an escaped exception and never a silent allow. The IFS regression
// rows prove the known crash source is fixed; this proves the boundary
// itself, independent of which internal step might throw next.
vi.mock('./shell-semantics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shell-semantics.js')>();
  return {
    ...actual,
    classifyGitAmend: (command: string) => {
      if (command.includes('__CRASH_WITNESS__')) {
        throw new SyntaxError('witness: guard internals must not escape');
      }
      return actual.classifyGitAmend(command);
    },
  };
});

import { isDestructiveCommand } from './destructive-commands.js';

describe('isDestructiveCommand crash boundary (#16075 R15-3)', () => {
  it('routes an internal evaluation error to approval', () => {
    const result = isDestructiveCommand('echo __CRASH_WITNESS__', 'prompt');
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(false);
    expect(result!.ask).toBe(true);
  });

  it('keeps normal evaluation intact around the boundary', () => {
    expect(isDestructiveCommand('git reset --hard', 'fix')!.blocked).toBe(true);
    expect(isDestructiveCommand('npm install', 'build')).toBeNull();
  });
});
