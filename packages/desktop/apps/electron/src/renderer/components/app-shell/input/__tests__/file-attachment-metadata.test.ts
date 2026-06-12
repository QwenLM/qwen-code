import { describe, expect, it } from 'bun:test';
import { inferFileAttachmentMetadata } from '../file-attachment-metadata';

describe('inferFileAttachmentMetadata', () => {
  it('classifies pasted images when Chromium provides no MIME type', () => {
    expect(inferFileAttachmentMetadata('pasted-image-1.png', '')).toEqual({
      type: 'image',
      mimeType: 'image/png',
    });
  });

  it('classifies local image file pastes with generic MIME type', () => {
    expect(
      inferFileAttachmentMetadata(
        'product-photo.JPG',
        'application/octet-stream',
      ),
    ).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('keeps explicit image MIME types', () => {
    expect(inferFileAttachmentMetadata('clipboard', 'image/webp')).toEqual({
      type: 'image',
      mimeType: 'image/webp',
    });
  });

  it('does not reinterpret specific non-image MIME types as images', () => {
    expect(inferFileAttachmentMetadata('image.png', 'application/pdf')).toEqual(
      {
        type: 'pdf',
        mimeType: 'application/pdf',
      },
    );
  });
});
