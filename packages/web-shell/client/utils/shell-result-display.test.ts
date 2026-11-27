/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isShellResultDisplay as sdkIsShellResultDisplay } from '@qwen-code/sdk/daemon';
import {
  isShellResultDisplay,
  type ShellResultDisplay,
} from './shell-result-display';

const validResult: ShellResultDisplay = {
  type: 'shell_result',
  version: 1,
  text: 'ok',
  output: 'hello\n',
  directory: '/workspace',
  exitCode: 0,
  signal: null,
  pid: 1234,
  error: null,
  outcome: 'completed',
  notices: ['truncated none'],
  truncated: false,
  outputFiles: ['out.log'],
};

describe('isShellResultDisplay', () => {
  it.each([
    { label: 'valid completed result', value: validResult, expected: true },
    {
      label: 'valid failed result with error string',
      value: {
        ...validResult,
        exitCode: 1,
        pid: null,
        error: 'failed',
        outcome: 'failed',
      },
      expected: true,
    },
    { label: 'null', value: null, expected: false },
    { label: 'array', value: [], expected: false },
    {
      label: 'wrong version',
      value: { ...validResult, version: 2 },
      expected: false,
    },
    {
      label: 'non-integer exitCode',
      value: { ...validResult, exitCode: 1.5 },
      expected: false,
    },
    {
      label: 'unknown outcome',
      value: { ...validResult, outcome: 'running' },
      expected: false,
    },
    {
      label: 'notices over 32 cap',
      value: { ...validResult, notices: Array.from({ length: 33 }, () => 'n') },
      expected: false,
    },
    {
      label: 'outputFiles over 32 cap',
      value: {
        ...validResult,
        outputFiles: Array.from({ length: 33 }, () => 'f'),
      },
      expected: false,
    },
    {
      label: 'directory + outputFiles over 8192 cap',
      value: { ...validResult, directory: 'a'.repeat(8193) },
      expected: false,
    },
  ])('matches SDK guard on $label', ({ value, expected }) => {
    expect(isShellResultDisplay(value)).toBe(expected);
    expect(isShellResultDisplay(value)).toBe(sdkIsShellResultDisplay(value));
  });
});
