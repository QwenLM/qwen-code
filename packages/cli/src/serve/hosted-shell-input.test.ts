/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { hostedShellInputError } from './hosted-shell-input.js';

it.each(['command', 'description'])(
  'rejects unpaired code units in %s without echoing input',
  (field) => {
    for (const value of [
      '\ud800',
      '\udc00',
      '\ud800a',
      '\udc00\ud800',
      '\ud800\ud800',
      '\udc00\udc00',
      '😀\ud800',
    ]) {
      const error = hostedShellInputError('run_shell_command', {
        command: 'pwd',
        [field]: value,
      });
      expect(error).toBe(
        'Hosted Shell ' +
          field +
          ' contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.',
      );
    }
  },
);

it.each([
  'ASCII',
  '中文',
  '😀',
  'é',
  '\\ud800',
  '\x1b\x01\x7f\u2028\u2029',
  '',
])('preserves valid text and canonical digest (%j)', (value) => {
  const input = { command: 'printf ' + value, description: value };
  const encoded = JSON.stringify(input);
  const digest = managedToolDigest(input);
  expect(hostedShellInputError('run_shell_command', input)).toBeUndefined();
  expect(JSON.stringify(input)).toBe(encoded);
  expect(managedToolDigest(input)).toBe(digest);
});

it('leaves other tools and argument shapes to their existing validators', () => {
  expect(
    hostedShellInputError('monitor', { command: '\ud800' }),
  ).toBeUndefined();
  for (const input of [
    undefined,
    null,
    [],
    { command: 7 },
    { command: 'pwd', description: 7 },
    { command: 'pwd' },
  ])
    expect(hostedShellInputError('run_shell_command', input)).toBeUndefined();
});
