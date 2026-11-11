/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { selectBuiltinExitOption } from './selectBuiltinExitOption.js';

describe('selectBuiltinExitOption', () => {
  it.each([
    { input: {}, expected: undefined },
    {
      input: { listExtensions: false, listSessions: false, listModels: false },
      expected: undefined,
    },
    { input: { listExtensions: true }, expected: 'listExtensions' },
    { input: { listSessions: true }, expected: 'listSessions' },
    { input: { listModels: true }, expected: 'listModels' },
    { input: { deleteSession: '1' }, expected: 'deleteSession' },
    { input: { deleteSession: '' }, expected: 'deleteSession' },
    { input: { remote: '' }, expected: undefined },
    { input: { remote: 'task' }, expected: undefined },
    { input: { listSessions: true, remote: '' }, expected: 'listSessions' },
    {
      input: {
        listExtensions: true,
        listSessions: true,
        listModels: true,
        deleteSession: '1',
      },
      expected: 'listExtensions',
    },
    {
      input: { listSessions: true, listModels: true, deleteSession: '1' },
      expected: 'listSessions',
    },
    { input: { listModels: true, deleteSession: '1' }, expected: 'listModels' },
  ])('preserves the existing selection for $input', ({ input, expected }) => {
    expect(selectBuiltinExitOption(input)).toBe(expected);
  });
});
