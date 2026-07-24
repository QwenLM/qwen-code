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

function configWithUpload(upload: unknown): Config {
  return {
    getMediaConfig: () => ({ upload }),
  } as unknown as Config;
}

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

  it('selects the command backend when configured', () => {
    const uploader = determineUploader(
      configWithUpload({
        backend: 'command',
        command: 'oss cp {path} && echo url',
      }),
    );
    expect(uploader.id).toBe('command');
  });

  it('selects the http backend when an endpoint/publicUrlBase is configured', () => {
    const uploader = determineUploader(
      configWithUpload({
        backend: 'http',
        publicUrlBase: 'https://cdn.example.com',
      }),
    );
    expect(uploader.id).toBe('http');
  });

  it('falls back to default when the backend is misconfigured', () => {
    expect(determineUploader(configWithUpload({ backend: 'command' })).id).toBe(
      'default',
    );
    expect(determineUploader(configWithUpload({ backend: 'http' })).id).toBe(
      'default',
    );
  });
});
