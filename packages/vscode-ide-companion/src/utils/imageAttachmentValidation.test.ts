/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizeImageAttachment } from './imageAttachmentValidation.js';

describe('normalizeImageAttachment', () => {
  it('rejects attachments with unsupported image mime types on the extension host', () => {
    expect(
      normalizeImageAttachment({
        id: 'img-1',
        name: 'animated.gif',
        type: 'image/gif',
        size: 43,
        data: 'data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=',
        timestamp: Date.now(),
      }),
    ).toBeNull();
  });

  it('rejects attachments whose decoded payload exceeds the enforced byte limit', () => {
    expect(
      normalizeImageAttachment(
        {
          id: 'img-2',
          name: 'oversized.png',
          type: 'image/png',
          size: 1,
          data: 'data:image/png;base64,QUJDREU=',
          timestamp: Date.now(),
        },
        { maxBytes: 4 },
      ),
    ).toBeNull();
  });
});
