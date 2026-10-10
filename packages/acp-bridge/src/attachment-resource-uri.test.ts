/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { attachmentResourceUri } from './attachment-resource-uri.js';
import { readDaemonNativeResourceIndexes } from './embedded-resource-replay.js';
import type { SessionAttachmentReference } from './sessionAttachments.js';

// attachmentId is path.basename of an uploaded file, so spaces, '#', '%',
// '+', and non-ASCII characters are ordinary. Persisted transcripts and the
// replay journal match on this exact URI string, so the format is pinned
// character-for-character.
describe('attachmentResourceUri', () => {
  it('leaves plain filenames unchanged', () => {
    expect(attachmentResourceUri('notes.txt')).toBe('attachment:///notes.txt');
  });

  it('percent-encodes filenames that are not URI-safe', () => {
    expect(attachmentResourceUri('my report.pdf')).toBe(
      'attachment:///my%20report.pdf',
    );
    expect(attachmentResourceUri('100%.txt')).toBe('attachment:///100%25.txt');
    expect(attachmentResourceUri('a+b.txt')).toBe('attachment:///a%2Bb.txt');
    expect(attachmentResourceUri('数据.txt')).toBe(
      'attachment:///%E6%95%B0%E6%8D%AE.txt',
    );
    expect(attachmentResourceUri('my report #1 (final).pdf')).toBe(
      'attachment:///my%20report%20%231%20(final).pdf',
    );
  });

  it('round-trips an encoded id through the legacy native-resource matcher', () => {
    const reference: SessionAttachmentReference = {
      type: 'resource',
      attachmentId: 'my report #1 (final).pdf',
      mimeType: 'application/pdf',
      size: 1,
    };
    const prompt: ContentBlock[] = [
      {
        type: 'resource',
        resource: {
          uri: attachmentResourceUri(reference.attachmentId),
          text: 'native',
        },
      },
    ];

    expect(
      readDaemonNativeResourceIndexes(undefined, prompt, [reference]),
    ).toEqual([0]);
  });
});
