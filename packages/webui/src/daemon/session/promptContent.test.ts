/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toDaemonPromptContent } from './promptContent.js';

describe('toDaemonPromptContent', () => {
  it('keeps text prompts as the first daemon content block', () => {
    expect(toDaemonPromptContent('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
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
