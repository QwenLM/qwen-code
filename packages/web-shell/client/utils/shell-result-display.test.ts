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
      label: 'valid failed result with error string and null numeric fields',
      value: {
        ...validResult,
        exitCode: 1,
        signal: 9,
        pid: null,
        error: 'failed',
        outcome: 'failed',
        truncated: true,
      },
      expected: true,
    },
    {
      label: 'valid cancelled outcome with null exitCode',
      value: { ...validResult, exitCode: null, outcome: 'cancelled' },
      expected: true,
    },
    {
      label: 'valid timed_out outcome',
      value: { ...validResult, outcome: 'timed_out' },
      expected: true,
    },
    { label: 'null', value: null, expected: false },
    { label: 'undefined', value: undefined, expected: false },
    { label: 'primitive string', value: 'shell_result', expected: false },
    { label: 'array', value: [], expected: false },
    {
      label: 'wrong type discriminator',
      value: { ...validResult, type: 'other' },
      expected: false,
    },
    {
      label: 'wrong version',
      value: { ...validResult, version: 2 },
      expected: false,
    },
    {
      label: 'non-string text',
      value: { ...validResult, text: 123 },
      expected: false,
    },
    {
      label: 'non-string output',
      value: { ...validResult, output: null },
      expected: false,
    },
    {
      label: 'non-string directory',
      value: { ...validResult, directory: 123 },
      expected: false,
    },
    {
      label: 'non-integer exitCode',
      value: { ...validResult, exitCode: 1.5 },
      expected: false,
    },
    {
      label: 'unsafe-integer exitCode',
      value: { ...validResult, exitCode: Number.MAX_SAFE_INTEGER + 1 },
      expected: false,
    },
    {
      label: 'non-numeric signal',
      value: { ...validResult, signal: 'SIGTERM' },
      expected: false,
    },
    {
      label: 'non-numeric pid',
      value: { ...validResult, pid: '1234' },
      expected: false,
    },
    {
      label: 'non-string error',
      value: { ...validResult, error: 500 },
      expected: false,
    },
    {
      label: 'unknown outcome',
      value: { ...validResult, outcome: 'running' },
      expected: false,
    },
    {
      label: 'non-string outcome',
      value: { ...validResult, outcome: 0 },
      expected: false,
    },
    {
      label: 'non-boolean truncated',
      value: { ...validResult, truncated: 'false' },
      expected: false,
    },
    {
      label: 'non-array notices',
      value: { ...validResult, notices: 'notice' },
      expected: false,
    },
    {
      label: 'notices at exact 32 cap',
      value: { ...validResult, notices: Array.from({ length: 32 }, () => 'n') },
      expected: true,
    },
    {
      label: 'notices over 32 cap',
      value: { ...validResult, notices: Array.from({ length: 33 }, () => 'n') },
      expected: false,
    },
    {
      label: 'notices with non-string item',
      value: { ...validResult, notices: ['n', 1] },
      expected: false,
    },
    {
      label: 'non-array outputFiles',
      value: { ...validResult, outputFiles: 'out.log' },
      expected: false,
    },
    {
      label: 'outputFiles at exact 32 cap',
      value: {
        ...validResult,
        outputFiles: Array.from({ length: 32 }, () => 'f'),
      },
      expected: true,
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
      label: 'outputFiles with non-string item',
      value: { ...validResult, outputFiles: ['out.log', 1] },
      expected: false,
    },
    {
      label: 'directory at exact 8192 cap with empty outputFiles',
      value: {
        ...validResult,
        directory: 'a'.repeat(8192),
        outputFiles: [],
      },
      expected: true,
    },
    {
      label: 'directory over 8192 cap',
      value: {
        ...validResult,
        directory: 'a'.repeat(8193),
        outputFiles: [],
      },
      expected: false,
    },
    {
      label: 'outputFiles-only at exact 8192 cap',
      value: {
        ...validResult,
        directory: '',
        outputFiles: ['a'.repeat(8192)],
      },
      expected: true,
    },
    {
      label: 'outputFiles-only over 8192 cap',
      value: {
        ...validResult,
        directory: '',
        outputFiles: ['a'.repeat(8193)],
      },
      expected: false,
    },
    {
      label: 'combined directory + outputFiles at exact 8192 cap',
      value: {
        ...validResult,
        directory: 'a'.repeat(4096),
        outputFiles: ['b'.repeat(2048), 'c'.repeat(2048)],
      },
      expected: true,
    },
    {
      label: 'combined directory + outputFiles over 8192 cap',
      value: {
        ...validResult,
        directory: 'a'.repeat(4096),
        outputFiles: ['b'.repeat(2048), 'c'.repeat(2049)],
      },
      expected: false,
    },
  ])('matches SDK guard on $label', ({ value, expected }) => {
    expect(isShellResultDisplay(value)).toBe(expected);
    expect(isShellResultDisplay(value)).toBe(sdkIsShellResultDisplay(value));
  });
});
