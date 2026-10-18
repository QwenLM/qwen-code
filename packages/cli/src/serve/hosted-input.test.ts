/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  HOSTED_ATTACHMENT_INPUT_BYTES,
  parseHostedInput,
} from './hosted-input.js';

const image = {
  type: 'image',
  mimeType: 'image/png',
  data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
};
const file = {
  type: 'resource',
  resource: {
    uri: 'managed-input:///notes%201.md',
    mimeType: 'text/markdown',
    text: '你好\nsecond line',
  },
};

describe('Hosted immutable attachment input', () => {
  it('keeps real image parts and named text resources, including attachment-only input', () => {
    const parsed = parseHostedInput([
      { type: 'text', text: 'Review' },
      file,
      image,
    ]);
    expect(parsed.text).toBe('Review');
    expect(parsed.parts[0]).toEqual({ text: 'Review' });
    expect(parsed.parts[1]?.text).toContain('"notes 1.md" (text/markdown)');
    expect(parsed.parts[1]?.text).toContain('你好\nsecond line');
    expect(parsed.parts[2]).toEqual({
      inlineData: { data: image.data, mimeType: 'image/png' },
    });
    expect(parseHostedInput([image]).parts).toEqual([parsed.parts[2]]);
    expect(parseHostedInput([file]).text).toBe('');
  });

  it.each(
    [
      [],
      [{ type: 'text', text: '' }],
      [{ type: 'text', text: 'x', data: 'x' }],
      [{ ...image, mimeType: 'image/jpeg' }],
      [{ ...image, data: `${image.data}\n` }],
      [{ ...image, data: '%%%=' }],
      [{ type: 'image', mimeType: 'image/svg+xml', data: image.data }],
      [{ ...file, resource: { ...file.resource, uri: 'file:///etc/passwd' } }],
      [
        {
          ...file,
          resource: { ...file.resource, uri: 'https://example.org/file' },
        },
      ],
      [
        {
          ...file,
          resource: {
            ...file.resource,
            uri: 'managed-input:///..%2Fsecret.txt',
          },
        },
      ],
      [
        {
          ...file,
          resource: { ...file.resource, uri: 'managed-input:///%E0%A4%A' },
        },
      ],
      [
        {
          ...file,
          resource: { ...file.resource, mimeType: 'application/pdf' },
        },
      ],
      [{ ...file, resource: { ...file.resource, text: '\0binary' } }],
      [{ ...file, resource: { ...file.resource, blob: 'ignored' } }],
    ].map((value) => ({ value })),
  )('refuses unsupported or ambiguous input $value', ({ value }) => {
    expect(() => parseHostedInput(value)).toThrow();
  });

  it('enforces the complete encoded input budget, including non-ASCII and surrounding text', () => {
    const empty = [{ ...file, resource: { ...file.resource, text: '' } }];
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const within = [
      {
        ...file,
        resource: {
          ...file.resource,
          text: 'x'.repeat(HOSTED_ATTACHMENT_INPUT_BYTES - overhead),
        },
      },
    ];
    expect(Buffer.byteLength(JSON.stringify(within))).toBe(
      HOSTED_ATTACHMENT_INPUT_BYTES,
    );
    expect(() => parseHostedInput(within)).not.toThrow();
    expect(() =>
      parseHostedInput([...within, { type: 'text', text: 'one byte too far' }]),
    ).toThrow('48 KiB');
    expect(() =>
      parseHostedInput([
        { ...file, resource: { ...file.resource, text: '界'.repeat(17000) } },
      ]),
    ).toThrow('48 KiB');
  });
});
