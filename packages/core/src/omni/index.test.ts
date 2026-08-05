/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { isOmniVideoDeliveryActive } from './index.js';

function stubConfig(overrides: {
  omniEnabled?: boolean;
  trusted?: boolean | undefined;
  cgc?: Record<string, unknown> | undefined;
}): Config {
  return {
    isOmniEnabled: vi.fn().mockReturnValue(overrides.omniEnabled ?? true),
    isTrustedFolder: vi.fn().mockReturnValue(overrides.trusted),
    getContentGeneratorConfig: vi.fn().mockReturnValue(overrides.cgc),
  } as unknown as Config;
}

const DASHSCOPE_CGC = {
  authType: AuthType.USE_OPENAI,
  apiKey: 'sk-real-key',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

afterEach(() => {
  delete process.env['QWEN_CODE_ENABLE_OMNI'];
});

describe('isOmniVideoDeliveryActive', () => {
  it('is active for a DashScope endpoint with a static API key in a trusted workspace', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: true, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(true);
  });

  it('is inactive when omni is disabled', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ omniEnabled: false, trusted: true, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(false);
  });

  it('is inactive in an untrusted workspace', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: false, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(false);
  });

  it('treats unknown trust (undefined) as trusted', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: undefined, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(true);
  });

  it('is inactive under Qwen OAuth even though a placeholder apiKey exists', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: {
            authType: AuthType.QWEN_OAUTH,
            apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive when the apiKey is the OAuth placeholder regardless of authType', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { ...DASHSCOPE_CGC, apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive without a baseUrl (never sends the key to a default origin)', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { authType: AuthType.USE_OPENAI, apiKey: 'sk-openai-key' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive for non-DashScope endpoints', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: {
            authType: AuthType.USE_OPENAI,
            apiKey: 'sk-openai-key',
            baseUrl: 'https://api.openai.com/v1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive without a content generator config', () => {
    expect(
      isOmniVideoDeliveryActive(stubConfig({ trusted: true, cgc: undefined })),
    ).toBe(false);
  });
});

describe('readMediaViaOmniDelivery result shape', () => {
  // Mock the leaf dependencies so the real pipeline runs end to end; the
  // branch under test (image gets a resolution hint part, everything else
  // gets a bare fileData) is otherwise never exercised.
  function deliveryConfig(): Config {
    return {
      isOmniEnabled: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getContentGeneratorConfig: vi.fn().mockReturnValue(DASHSCOPE_CGC),
      getModel: vi.fn().mockReturnValue('qwen3.5-omni-plus'),
      getOmniUploadMaxFileBytes: vi.fn().mockReturnValue(0),
      getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(0),
      storage: { getQwenDir: () => '/tmp/omni-test-qwen' },
    } as unknown as Config;
  }

  function mockRecognized(
    modality: 'image' | 'audio' | 'video',
    metadata: Record<string, unknown>,
  ) {
    return {
      modality,
      detectedMimeType:
        modality === 'image'
          ? 'image/png'
          : modality === 'audio'
            ? 'audio/mpeg'
            : 'video/mp4',
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
      metadata,
    };
  }

  // The static `import ... from './index.js'` at the top of this file loads
  // the real graph before any doMock runs, so the registry has to be dropped
  // for the per-test mocks below to be the ones index.js binds to.
  let tmpDir: string;
  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-index-'));
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.doUnmock('./ffmpeg.js');
    vi.doUnmock('./recognition.js');
    vi.doUnmock('./storage.js');
    vi.doUnmock('./upload.js');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The byte guard stats the real path before anything is mocked, so the
   * input has to exist on disk; its bytes are irrelevant because
   * recognizeMediaFile is stubbed. */
  async function realFile(name: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, 'not really media');
    return filePath;
  }

  it('adds a resolution + zoom_image hint part for images', async () => {
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi
        .fn()
        .mockResolvedValue(
          mockRecognized('image', { width: 1920, height: 1080 }),
        ),
      extensionForMime: vi.fn().mockReturnValue('.png'),
    }));
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        async putFile() {
          return { objectPath: '/tmp/obj.png', deduped: false };
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        async uploadFile() {
          return 'oss://bucket/key';
        }
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    const { readMediaViaOmniDelivery } = await import('./index.js');

    const result = await readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: deliveryConfig(),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });

    expect(Array.isArray(result.llmContent)).toBe(true);
    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!['text']).toContain('1920x1080');
    expect(parts[0]!['text']).toContain('zoom_image');
    expect(parts[1]).toEqual({
      fileData: {
        fileUri: 'oss://bucket/key',
        mimeType: 'image/png',
        displayName: 'pic.png',
      },
    });
  });

  it('returns a bare fileData part for audio (no zoom hint)', async () => {
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi
        .fn()
        .mockResolvedValue(mockRecognized('audio', { durationMs: 60_000 })),
      extensionForMime: vi.fn().mockReturnValue('.mp3'),
    }));
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        async putFile() {
          return { objectPath: '/tmp/obj.mp3', deduped: false };
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        async uploadFile() {
          return 'oss://bucket/audio';
        }
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    const { readMediaViaOmniDelivery } = await import('./index.js');

    const result = await readMediaViaOmniDelivery({
      filePath: await realFile('song.mp3'),
      config: deliveryConfig(),
      displayName: 'song.mp3',
      relativePathForDisplay: 'song.mp3',
      expectedModality: 'audio',
    });

    expect(Array.isArray(result.llmContent)).toBe(false);
    expect(result.llmContent).toEqual({
      fileData: {
        fileUri: 'oss://bucket/audio',
        mimeType: 'audio/mpeg',
        displayName: 'song.mp3',
      },
    });
    expect(result.returnDisplay).toContain('audio');
  });

  it('fails closed with an error result (never inline base64) on failure', async () => {
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(false),
      isFfprobeAvailable: vi.fn().mockResolvedValue(false),
    }));
    const { readMediaViaOmniDelivery } = await import('./index.js');

    const result = await readMediaViaOmniDelivery({
      filePath: '/tmp/clip.mp4',
      config: deliveryConfig(),
      displayName: 'clip.mp4',
      relativePathForDisplay: 'clip.mp4',
      expectedModality: 'video',
    });

    expect(result.error).toMatch(/Omni media delivery failed/);
    expect(result.llmContent).toContain('ffmpeg/ffprobe not available');
  });
});
