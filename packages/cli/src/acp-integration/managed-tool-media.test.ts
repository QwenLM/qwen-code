/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  managedToolResponseMediaBytes,
  MAX_MANAGED_MEDIA_RESPONSE_BYTES,
} from './managed-tool-media.js';

function execution(data = 'AQ==', mimeType = 'image/png') {
  return {
    executionStatus: 'success',
    result: {
      llmContent: [{ inlineData: { data, mimeType } }],
      returnDisplay: 'image',
    },
  };
}

describe('managed tool media wire validation', () => {
  it.each(['execute', 'status', 'cancel'] as const)(
    'accounts only direct inline media in %s results',
    (operation) => {
      const result = execution();
      const wrapped =
        operation === 'execute'
          ? result
          : { state: 'settled', result, progress: [] };
      expect(managedToolResponseMediaBytes(wrapped, operation)).toBe(4);
      expect(
        managedToolResponseMediaBytes(
          { ...wrapped, postHook: { inlineData: { data: 'AQ==' } } },
          operation,
        ),
      ).toBe(4);
    },
  );

  it('does not exempt progress, display, nested contents, or unsettled results', () => {
    expect(
      managedToolResponseMediaBytes(
        { state: 'executing', result: execution() },
        'status',
      ),
    ).toBe(0);
    const result = execution();
    expect(
      managedToolResponseMediaBytes(
        {
          executionStatus: 'success',
          result: {
            llmContent: { functionResponse: result },
            returnDisplay: result,
          },
          progress: [result],
        },
        'execute',
      ),
    ).toBe(0);
  });

  it.each([
    'AR==',
    'AQ=',
    'AQ===',
    'A===',
    'AQ==\n',
    'AQ==AQ==',
    '-_==',
    'ABCD=',
    'A',
  ])('rejects invalid or noncanonical base64 %j', (data) => {
    expect(() =>
      managedToolResponseMediaBytes(execution(data), 'execute'),
    ).toThrow('invalid inline media');
  });

  it.each(['execute', 'status', 'cancel'] as const)(
    'preserves native empty media in %s results with zero media bytes',
    (operation) => {
      for (const mime of ['audio/wav', 'video/mp4', 'application/pdf']) {
        const result = execution('', mime);
        const wrapped =
          operation === 'execute'
            ? result
            : { state: 'settled', result, progress: [] };
        expect(managedToolResponseMediaBytes(wrapped, operation)).toBe(0);
      }
    },
  );

  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/mpeg',
    'video/mp4',
    'application/pdf',
  ])('permits native media MIME %s', (mime) => {
    expect(
      managedToolResponseMediaBytes(execution('AQID', mime), 'execute'),
    ).toBe(4);
  });

  it('rejects malformed inline parts and non-media MIME', () => {
    for (const inlineData of [
      null,
      { data: 1, mimeType: 'image/png' },
      { data: 'AQ==' },
      { data: 'AQ==', mimeType: 'text/plain' },
    ]) {
      expect(() =>
        managedToolResponseMediaBytes(
          {
            executionStatus: 'success',
            result: { llmContent: { inlineData } },
          },
          'execute',
        ),
      ).toThrow('invalid inline media');
    }
  });

  it('preserves ordinary JSON omission and local ACP text capacity', () => {
    expect(
      managedToolResponseMediaBytes(
        {
          executionStatus: 'success',
          result: { llmContent: 'x'.repeat(9 * 1024 * 1024), error: undefined },
          postHook: undefined,
        },
        'execute',
      ),
    ).toBe(0);
  });

  it('bounds combined wire bytes including a first PDF page larger than the normal page budget', () => {
    const result = execution('AAAA'.repeat(7 * 1024 * 1024));
    expect(managedToolResponseMediaBytes(result, 'execute')).toBe(
      28 * 1024 * 1024,
    );
    const overhead = Buffer.byteLength(
      JSON.stringify({
        ...result,
        result: { ...result.result, llmContent: '' },
      }),
    );
    const boundary = {
      ...result,
      result: {
        ...result.result,
        llmContent: 'x'.repeat(MAX_MANAGED_MEDIA_RESPONSE_BYTES - overhead),
      },
    };
    expect(managedToolResponseMediaBytes(boundary, 'execute')).toBe(0);
    boundary.result.llmContent += 'x';
    expect(() => managedToolResponseMediaBytes(boundary, 'execute')).toThrow(
      'size limit',
    );
  });

  it('refuses unsafe ACP structure before a large result can poison the pipe', () => {
    const result = execution();
    expect(() =>
      managedToolResponseMediaBytes(
        { ...result, progress: Array(4097).fill(null) },
        'execute',
      ),
    ).toThrow('structure limits');
    let nested: unknown = 'leaf';
    for (let index = 0; index < 64; index++) nested = { nested };
    expect(() =>
      managedToolResponseMediaBytes({ ...result, nested }, 'execute'),
    ).toThrow('structure limits');
  });
});
