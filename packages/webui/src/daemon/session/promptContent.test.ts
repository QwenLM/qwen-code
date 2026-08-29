/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  attachmentUriForName,
  daemonPromptImageToBlob,
  toDaemonPromptContent,
} from './promptContent.js';

describe('attachmentUriForName', () => {
  it('uses the encoded file name as the attachment id', () => {
    expect(attachmentUriForName('my file (1).json')).toBe(
      'attachment:///my%20file%20(1).json',
    );
  });
});

describe('daemonPromptImageToBlob', () => {
  it('decodes raw base64 image data', async () => {
    const blob = daemonPromptImageToBlob({
      data: 'AQID',
      mimeType: 'image/png',
    });

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('strips a data URI prefix before decoding', async () => {
    const blob = daemonPromptImageToBlob({
      data: 'data:image/jpeg;base64,BAUG',
      media_type: 'image/jpeg',
    });

    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(4, 5, 6),
    );
  });
});

describe('toDaemonPromptContent', () => {
  it('keeps text prompts as the first daemon content block', () => {
    expect(toDaemonPromptContent('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('rejects file resources whose content is unavailable', () => {
    expect(() =>
      toDaemonPromptContent(
        'check',
        [],
        [{ name: 'report.pdf', data: new Blob(['pdf']) }],
      ),
    ).toThrow('File attachment content is unavailable: report.pdf');
  });

  it('normalizes image aliases into daemon image content blocks', () => {
    expect(
      toDaemonPromptContent('look', [
        { data: 'a', mimeType: 'image/png' },
        { data: 'b', media_type: 'image/jpeg' },
      ]),
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'image', data: 'b', mimeType: 'image/jpeg' },
    ]);
  });

  it('preserves an image-only BMP prompt as canonical daemon content', () => {
    expect(
      toDaemonPromptContent('', [{ data: 'Qk0=', mimeType: 'image/bmp' }]),
    ).toEqual([
      { type: 'text', text: '' },
      { type: 'image', data: 'Qk0=', mimeType: 'image/bmp' },
    ]);
  });

  it('embeds text files as resource blocks with transcript tokens', () => {
    expect(
      toDaemonPromptContent(
        'check this',
        [],
        [{ name: 'app.log', text: 'line1\nline2', media_type: 'text/plain' }],
      ),
    ).toEqual([
      {
        type: 'text',
        text: 'check this\n\n@attachment:///app.log',
      },
      {
        type: 'resource',
        resource: {
          uri: 'attachment:///app.log',
          mimeType: 'text/plain',
          text: 'line1\nline2',
        },
      },
    ]);
  });

  it('keeps the token identical to the resource uri and joins multiple files', () => {
    const content = toDaemonPromptContent(
      'look',
      [],
      [
        { name: 'a.log', text: 'aaa' },
        { name: 'b.md', text: 'bbb', mimeType: 'text/markdown' },
      ],
    );
    expect(content[0]).toEqual({
      type: 'text',
      text: 'look\n\n@attachment:///a.log\n@attachment:///b.md',
    });
    expect(content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'attachment:///a.log', text: 'aaa' },
    });
    expect(content[2]).toEqual({
      type: 'resource',
      resource: {
        uri: 'attachment:///b.md',
        mimeType: 'text/markdown',
        text: 'bbb',
      },
    });
  });

  it('omits token lines for slash commands while still sending resources', () => {
    expect(
      toDaemonPromptContent('/review', [], [{ name: 'app.log', text: 'x' }]),
    ).toEqual([
      { type: 'text', text: '/review' },
      {
        type: 'resource',
        resource: { uri: 'attachment:///app.log', text: 'x' },
      },
    ]);
  });

  it('uses bare tokens as the text block when the prompt is file-only', () => {
    expect(
      toDaemonPromptContent('', [], [{ name: 'app.log', text: 'x' }])[0],
    ).toEqual({ type: 'text', text: '@attachment:///app.log' });
  });

  it('orders text, images, then files', () => {
    expect(
      toDaemonPromptContent(
        'both',
        [{ data: 'a', mimeType: 'image/png' }],
        [{ name: 'app.log', text: 'x' }],
      ),
    ).toEqual([
      { type: 'text', text: 'both\n\n@attachment:///app.log' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'attachment:///app.log', text: 'x' },
      },
    ]);
  });
});
