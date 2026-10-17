/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import {
  acceptedCsiToolInput,
  convertHostedCsiToolResult,
} from './hosted-csi-tool-evidence.js';

it.each(['read_file', 'write_file', 'edit'])(
  'rejects a normalized root before admitting %s',
  (name) => {
    const args =
      name === 'read_file'
        ? { file_path: './' }
        : name === 'write_file'
          ? { file_path: './', content: '' }
          : { file_path: './', old_string: '', new_string: '' };
    expect(() =>
      acceptedCsiToolInput({
        callId: 'original',
        name,
        args,
        isClientInitiated: false,
        prompt_id: 'owned',
      }),
    ).toThrow('CSI file input must name a file.');
  },
);

it.each([
  { responseParts: [] },
  { responseParts: [{ text: 'owned runtime refusal' }] },
])(
  'preserves a runtime error without converting it to success (%j)',
  ({ responseParts }) => {
    const runtimeError = { code: 'owned_error', message: 'owned fallback' };
    const converted = convertHostedCsiToolResult('edit', 'original-function', {
      executionStatus: 'error',
      responseParts,
      error: runtimeError,
    });
    expect(converted).toEqual([
      {
        functionResponse: {
          id: 'original-function',
          name: 'edit',
          response: {
            error: responseParts.length
              ? 'owned runtime refusal'
              : 'owned fallback',
            executionStatus: 'error',
            runtimeError,
          },
        },
      },
    ]);
  },
);
