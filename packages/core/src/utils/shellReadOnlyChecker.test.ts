/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

describe('evaluateShellCommandReadOnly', () => {
  it('allows simple read-only command', () => {
    const result = isShellCommandReadOnly('ls -la');
    expect(result).toBe(true);
  });

  it('rejects mutating commands like rm', () => {
    const result = isShellCommandReadOnly('rm -rf temp');
    expect(result).toBe(false);
  });

  it('rejects redirection output', () => {
    const result = isShellCommandReadOnly('ls > out.txt');
    expect(result).toBe(false);
  });

  it('rejects command substitution', () => {
    const result = isShellCommandReadOnly('echo $(touch file)');
    expect(result).toBe(false);
  });

  it('allows git status but rejects git commit', () => {
    expect(isShellCommandReadOnly('git status')).toBe(true);
    const commitResult = isShellCommandReadOnly('git commit -am "msg"');
    expect(commitResult).toBe(false);
  });

  it('rejects find with exec', () => {
    const result = isShellCommandReadOnly('find . -exec rm {} \\;');
    expect(result).toBe(false);
  });

  it('rejects sed in-place', () => {
    const result = isShellCommandReadOnly("sed -i 's/foo/bar/' file");
    expect(result).toBe(false);
  });

  it('rejects empty command', () => {
    const result = isShellCommandReadOnly('   ');
    expect(result).toBe(false);
  });

  it('respects environment prefix followed by allowed command', () => {
    const result = isShellCommandReadOnly('FOO=bar ls');
    expect(result).toBe(true);
  });
});
