/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { encodeTextFileContentAsync } from './fileSystemService.js';
import { decodeBufferWithEncodingInfoAsync } from '../utils/fileUtils.js';
import {
  decodeBufferWithEncodingInfo,
  encodeTextFileContent,
} from './sync-file-encoding.js';

describe('sync file encoding compatibility', () => {
  it.each([
    ['empty', Buffer.alloc(0)],
    ['UTF-8', Buffer.from('Hello, 世界', 'utf8')],
    [
      'UTF-8 BOM',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('Hello', 'utf8'),
      ]),
    ],
    [
      'GBK',
      Buffer.from([
        0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xd5, 0xe2, 0xca, 0xc7,
        0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4,
      ]),
    ],
  ])('matches the async decoder for %s input', async (_name, input) => {
    expect(await decodeBufferWithEncodingInfoAsync(input)).toEqual(
      decodeBufferWithEncodingInfo(input),
    );
  });

  it.each([
    ['UTF-8', undefined],
    ['CRLF', { lineEnding: 'crlf' as const }],
    ['UTF-8 BOM', { bom: true }],
    ['GBK', { encoding: 'gb18030' }],
    ['unsupported encoding', { encoding: 'unsupported-codec' }],
  ])('matches the async encoder for %s metadata', async (_name, meta) => {
    expect(
      await encodeTextFileContentAsync('/test/file.txt', 'Hello\n世界\n', meta),
    ).toEqual(encodeTextFileContent('/test/file.txt', 'Hello\n世界\n', meta));
  });
});
