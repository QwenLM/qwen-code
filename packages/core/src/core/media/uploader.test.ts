/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../../config/config.js';
import type { MediaProbe } from '../../utils/media/types.js';
import { determineUploader, UploadNotConfiguredError } from './uploader.js';

const config = {} as Config;
const probe: MediaProbe = {
  path: '/tmp/big.mp4',
  hash: 'abc',
  modality: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 100_000_000,
};

describe('uploader', () => {
  it('always resolves to a terminal uploader (never undefined)', () => {
    const uploader = determineUploader(config);
    expect(uploader).toBeDefined();
    expect(uploader.id).toBe('default');
  });

  it('the default uploader fails closed with a remedy', async () => {
    const uploader = determineUploader(config);
    await expect(uploader.upload(probe)).rejects.toBeInstanceOf(
      UploadNotConfiguredError,
    );
    try {
      await uploader.upload(probe);
    } catch (err) {
      expect((err as UploadNotConfiguredError).remedy).toContain(
        'upload backend',
      );
    }
  });
});
