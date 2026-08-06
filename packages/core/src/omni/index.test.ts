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
import { isOmniDeliveryActive } from './index.js';
import { effectiveMaxDownloadFileBytes } from './index.js';
import { sanitizeErrorMessage } from './index.js';

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

describe('sanitizeErrorMessage', () => {
  it('scrubs known paths exactly, including segments with spaces', () => {
    // A space inside a segment defeats the pattern pass (segment classes
    // break at whitespace — '/Users/john doe/…' would surface 'john doe');
    // known-path exact replacement is the only mechanism immune to it.
    const spaced = '/Users/john doe/.qwen/omni/objects/ab/abcd1234deadbeef.png';
    const err = new Error(`EACCES: permission denied, open '${spaced}'`);
    const out = sanitizeErrorMessage(err, [spaced]);
    expect(out).not.toContain('john doe');
    expect(out).toContain('abcd1234deadbeef.png');
  });

  it('scrubs a known store ROOT even when the full object path is unknown', () => {
    // putFile can throw before objectPath is assigned; passing the store
    // root as a known path still removes the user-identifying prefix.
    const root = '/Users/john doe/.qwen/omni';
    const err = new Error(
      `ENOSPC: no space left on device, write '${root}/objects/cd/ef99.webm'`,
    );
    const out = sanitizeErrorMessage(err, [root]);
    expect(out).not.toContain('john doe');
    expect(out).toContain('ef99.webm');
  });

  it('pattern pass still collapses unknown space-free absolute paths', () => {
    const err = new Error(
      "ENOENT: no such file or directory, stat '/opt/data/media/clip.mp4'",
    );
    expect(sanitizeErrorMessage(err)).not.toContain('/opt/data');
    expect(sanitizeErrorMessage(err)).toContain('clip.mp4');
  });
});

describe('effectiveMaxDownloadFileBytes', () => {
  const capsConfig = (download?: number, upload?: number): Config =>
    ({
      getOmniDownloadMaxFileBytes: () => download,
      getOmniUploadMaxFileBytes: () => upload,
    }) as unknown as Config;

  it('never exceeds the upload cap, even when configured higher', () => {
    // Downloading more than the upload channel can deliver is pure waste:
    // the bytes would be fetched, then rejected by the byte guard.
    expect(effectiveMaxDownloadFileBytes(capsConfig(2_000, 1_000))).toBe(1_000);
    expect(effectiveMaxDownloadFileBytes(capsConfig(500, 1_000))).toBe(500);
    expect(effectiveMaxDownloadFileBytes(capsConfig(undefined, 1_000))).toBe(
      1_000,
    );
    expect(effectiveMaxDownloadFileBytes(capsConfig(0, 1_000))).toBe(1_000);
  });
});

describe('isOmniDeliveryActive', () => {
  it('is active for a DashScope endpoint with a static API key in a trusted workspace', () => {
    expect(
      isOmniDeliveryActive(stubConfig({ trusted: true, cgc: DASHSCOPE_CGC })),
    ).toBe(true);
  });

  it('is inactive when omni is disabled', () => {
    expect(
      isOmniDeliveryActive(
        stubConfig({ omniEnabled: false, trusted: true, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(false);
  });

  it('is inactive in an untrusted workspace', () => {
    expect(
      isOmniDeliveryActive(stubConfig({ trusted: false, cgc: DASHSCOPE_CGC })),
    ).toBe(false);
  });

  it('treats unknown trust (undefined) as trusted', () => {
    expect(
      isOmniDeliveryActive(
        stubConfig({ trusted: undefined, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(true);
  });

  it('is inactive under Qwen OAuth even though a placeholder apiKey exists', () => {
    expect(
      isOmniDeliveryActive(
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
      isOmniDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { ...DASHSCOPE_CGC, apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive without a baseUrl (never sends the key to a default origin)', () => {
    expect(
      isOmniDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { authType: AuthType.USE_OPENAI, apiKey: 'sk-openai-key' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive for non-DashScope endpoints', () => {
    expect(
      isOmniDeliveryActive(
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
      isOmniDeliveryActive(stubConfig({ trusted: true, cgc: undefined })),
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
      hashFileSha256: vi.fn().mockResolvedValue('a'.repeat(64)),
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
      hashFileSha256: vi.fn().mockResolvedValue('a'.repeat(64)),
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

  it('rejects with OmniTransportGuardError before storing or uploading when the token guard trips', async () => {
    // Every other pipeline test disables the guard (threshold 0); this one
    // pins the guard call itself: a positive threshold with an over-budget
    // estimate must reject BEFORE the hash/copy/upload stages run.
    const putFileMock = vi.fn();
    const uploadFileMock = vi.fn();
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi.fn().mockResolvedValue(
        // 852×480×(506s × 30fps) / 2048 ≈ 3M tokens — far above 100.
        mockRecognized('video', {
          width: 852,
          height: 480,
          durationMs: 506_000,
          frameRate: 30,
        }),
      ),
      hashFileSha256: vi.fn().mockResolvedValue('a'.repeat(64)),
      extensionForMime: vi.fn().mockReturnValue('.mp4'),
    }));
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        putFile = putFileMock;
        getOmniRootDir() {
          return '/tmp/omni-test-qwen/omni';
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        uploadFile = uploadFileMock;
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    const { processMediaForOmniDelivery, OmniTransportGuardError } =
      await import('./index.js');

    const config = {
      ...deliveryConfig(),
      getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(100),
    } as unknown as Config;
    await expect(
      processMediaForOmniDelivery(await realFile('long.mp4'), config, {
        expectedModality: 'video',
      }),
    ).rejects.toThrow(OmniTransportGuardError);
    expect(putFileMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('propagates an abort from uploadFile instead of returning a fail-closed result', async () => {
    // A user abort must surface to the caller's abort handling — wrapping it
    // in the error-result shape would report a cancellation as a failed read.
    const controller = new AbortController();
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi
        .fn()
        .mockResolvedValue(mockRecognized('audio', { durationMs: 60_000 })),
      hashFileSha256: vi.fn().mockResolvedValue('a'.repeat(64)),
      extensionForMime: vi.fn().mockReturnValue('.mp3'),
    }));
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        async putFile() {
          return { objectPath: '/tmp/obj.mp3', deduped: false };
        }
        getOmniRootDir() {
          return '/tmp/omni-test-qwen/omni';
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        async uploadFile() {
          controller.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    const { readMediaViaOmniDelivery } = await import('./index.js');

    await expect(
      readMediaViaOmniDelivery({
        filePath: await realFile('song.mp3'),
        config: deliveryConfig(),
        displayName: 'song.mp3',
        relativePathForDisplay: 'song.mp3',
        expectedModality: 'audio',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
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

  it('never leaks the absolute path through error or llmContent on failure', async () => {
    // Both fields reach the model: llmContent on success paths, `error` via
    // the scheduler's functionResponse on READ_CONTENT_FAILURE. The paths
    // here are the regex-hostile shapes from review: CJK segments, a
    // `~`-prefixed basename, parens/apostrophe, and a Windows drive path —
    // exact replacement of the known filePath must scrub all of them.
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    const { readMediaViaOmniDelivery } = await import('./index.js');

    for (const [filePath, parentFragment] of [
      ['/Users/张三/视频/clip.mp4', '/Users/张三'],
      ['/Users/a/videos/~draft.mp4', '/Users/a/videos'],
      ["/Users/a/it's (v2)+final@x/clip.mp4", "it's (v2)+final@x"],
      ['C:\\Users\\björn\\clip.mp4', 'C:\\Users'],
    ] as const) {
      const result = await readMediaViaOmniDelivery({
        filePath,
        config: deliveryConfig(),
        displayName: 'clip.mp4',
        relativePathForDisplay: 'clip.mp4',
        expectedModality: 'video',
      });
      // The stat fails (files don't exist) and the fs error embeds the path.
      expect(result.error).toMatch(/Omni media delivery failed/);
      for (const field of [result.error, result.llmContent]) {
        expect(String(field)).not.toContain(parentFragment);
      }
    }
  });
});
