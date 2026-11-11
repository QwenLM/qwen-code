/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ImageFileAttachment } from './models/file-attachments.js';
import { PDFFileAttachment } from './models/file-attachments.js';
import { describe, expect, it } from 'vitest';
import { createAttachmentMessage } from './factory.js';

describe('createAttachmentMessage', () => {
  it('does not persist base64 for an uploaded image file attachment', () => {
    const message = createAttachmentMessage(
      new ImageFileAttachment({
        type: 'image_file',
        filename: '/tmp/image.png',
        base64: 'large-base64-payload',
        url: 'https://assets.example.test/image.png',
        mediaType: 'image/png',
        displayPath: 'image.png',
        originalSize: 123,
      }),
    );

    expect(message.attachment).toEqual({
      type: 'image_file',
      filename: '/tmp/image.png',
      url: 'https://assets.example.test/image.png',
      mediaType: 'image/png',
      displayPath: 'image.png',
      originalSize: 123,
    });
  });

  it('keeps base64 for an image file attachment when no uploaded URL exists', () => {
    const message = createAttachmentMessage(
      new ImageFileAttachment({
        type: 'image_file',
        filename: '/tmp/image.png',
        base64: 'fallback-base64-payload',
        mediaType: 'image/png',
        displayPath: 'image.png',
        originalSize: 123,
      }),
    );

    expect(message.attachment).toEqual(
      expect.objectContaining({
        type: 'image_file',
        base64: 'fallback-base64-payload',
      }),
    );
  });

  it('does not persist base64 for uploaded PDF page images', () => {
    const message = createAttachmentMessage(
      new PDFFileAttachment({
        type: 'pdf_file',
        filename: '/tmp/file.pdf',
        pageCount: 2,
        fileSize: 456,
        displayPath: 'file.pdf',
        pages: [
          {
            base64: 'uploaded-page-base64',
            url: 'https://assets.example.test/page-1.jpg',
            mediaType: 'image/jpeg',
          },
          {
            base64: 'fallback-page-base64',
            mediaType: 'image/jpeg',
          },
        ],
      }),
    );

    expect(message.attachment).toEqual({
      type: 'pdf_file',
      filename: '/tmp/file.pdf',
      pageCount: 2,
      fileSize: 456,
      displayPath: 'file.pdf',
      pages: [
        {
          url: 'https://assets.example.test/page-1.jpg',
          mediaType: 'image/jpeg',
        },
        {
          base64: 'fallback-page-base64',
          mediaType: 'image/jpeg',
        },
      ],
    });
  });
});
