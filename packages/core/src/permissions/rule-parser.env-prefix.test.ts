/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesCommandPattern } from './rule-parser.js';

describe('matchesCommandPattern environment prefixes', () => {
  it('keeps plain concrete commands matching', () => {
    expect(matchesCommandPattern('npm --version', 'npm --version')).toBe(true);
  });

  it('does not let NODE_OPTIONS widen a concrete npm allow rule', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(false);
  });

  it('does not let GIT_CONFIG_* widen a concrete git allow rule', () => {
    expect(
      matchesCommandPattern(
        'git status --short',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/fsmonitor.sh git status --short',
      ),
    ).toBe(false);
  });

  it('allows an environment-prefixed command only when the rule includes it', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
  });
});
