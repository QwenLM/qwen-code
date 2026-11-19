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
    const runtimeError = { type: 'owned_error', message: 'owned fallback' };
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

it.each(['\ud800', '\udfff'])(
  'rejects malformed Unicode in each supported string field (%j)',
  (value) => {
    for (const [name, args] of [
      ['read_file', { file_path: value }],
      ['write_file', { file_path: 'owned.txt', content: value }],
      ['edit', { file_path: 'owned.txt', old_string: value, new_string: '' }],
      ['edit', { file_path: 'owned.txt', old_string: '', new_string: value }],
    ] as const)
      expect(() =>
        acceptedCsiToolInput({
          callId: 'original',
          name,
          args,
          isClientInitiated: false,
          prompt_id: 'owned',
        }),
      ).toThrow(URIError);
  },
);

it('preserves valid Unicode input', () => {
  const args = { file_path: '中文.txt', content: 'owned 😀' };
  expect(
    acceptedCsiToolInput({
      callId: 'original',
      name: 'write_file',
      args,
      isClientInitiated: false,
      prompt_id: 'owned',
    }),
  ).toEqual(args);
});

it.each(['success', 'error'] as const)(
  'refuses supplied function identities in a %s result',
  (executionStatus) => {
    for (const field of ['functionResponse', 'functionCall']) {
      expect(() =>
        convertHostedCsiToolResult('read_file', 'original-function', {
          executionStatus,
          responseParts: [
            {
              text: 'owned',
              [field]: {
                id: 'worker-replacement-id',
                name: 'write_file',
                response: { output: 'replaced' },
              },
            },
          ],
        }),
      ).toThrow('Runtime returned an unsupported tool result.');
    }
  },
);

it.each([
  { message: '' },
  { message: 42 },
  { message: { detail: 'owned' } },
  { message: 'owned', code: 'unexpected' },
  { message: 'owned', type: '' },
  null,
])(
  'refuses an error envelope the native consumer cannot verify (%j)',
  (error) => {
    expect(() =>
      convertHostedCsiToolResult('edit', 'original-function', {
        executionStatus: 'error',
        responseParts: [],
        error,
      } as unknown as Parameters<typeof convertHostedCsiToolResult>[2]),
    ).toThrow('Runtime returned an unsupported tool result.');
  },
);

it.each([
  { inlineData: { mimeType: 'image/png', data: 'aA==' } },
  { fileData: { mimeType: 'text/plain', fileUri: 'owned://file' } },
])('preserves original identity and complete supported media (%j)', (part) => {
  const result = { executionStatus: 'success' as const, responseParts: [part] };
  const original = structuredClone(result);
  expect(
    convertHostedCsiToolResult('read_file', 'original-function', result),
  ).toEqual([
    {
      functionResponse: {
        id: 'original-function',
        name: 'read_file',
        parts: [part],
        response: { output: '', executionStatus: 'success' },
      },
    },
  ]);
  expect(result).toEqual(original);
});

it.each([
  { text: 'owned', unexpected: true },
  { text: 'owned', type: 'unsupported' },
  { inlineData: { mimeType: 'image/png', data: '' } },
  { inlineData: { mimeType: 'image/png', data: 'x'.repeat(4097) } },
  { fileData: { mimeType: '', fileUri: 'owned://file' } },
])('refuses unsupported Part data before durable conversion (%j)', (part) => {
  expect(() =>
    convertHostedCsiToolResult('read_file', 'original-function', {
      executionStatus: 'success',
      responseParts: [part],
    }),
  ).toThrow('Runtime returned an unsupported tool result.');
});
