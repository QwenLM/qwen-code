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
import {
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import { AuthType } from '../core/contentGenerator.js';
import { isOmniDeliveryActive } from './index.js';
import { effectiveMaxDownloadFileBytes } from './index.js';
import { sanitizeErrorMessage } from './index.js';
import type { OmniUploadConfig } from './upload-config.js';

function stubConfig(overrides: {
  omniEnabled?: boolean;
  trusted?: boolean | undefined;
  cgc?: Record<string, unknown> | undefined;
  upload?: OmniUploadConfig;
}): Config {
  return {
    isOmniEnabled: vi.fn().mockReturnValue(overrides.omniEnabled ?? true),
    isTrustedFolder: vi.fn().mockReturnValue(overrides.trusted),
    getContentGeneratorConfig: vi.fn().mockReturnValue(overrides.cgc),
    getModel: vi.fn().mockReturnValue('qwen3.5-omni-plus'),
    getOmniUploadConfig: vi.fn().mockReturnValue(overrides.upload),
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
      getOmniUrlDownloadMaxFileBytes: () => download,
      getOmniMaxUploadFileBytes: () => upload,
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

  it('is active for custom inference when a dedicated DashScope upload channel is configured', () => {
    expect(
      isOmniDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: {
            authType: AuthType.USE_OPENAI,
            apiKey: 'inference-key',
            baseUrl: 'http://127.0.0.1:22002/v1',
          },
          upload: {
            apiKey: 'upload-key',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            model: 'qwen3.5-omni-plus',
          },
        }),
      ),
    ).toBe(true);
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
      getOmniMaxUploadFileBytes: vi.fn().mockReturnValue(0),
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
        getOmniRootDir() {
          return tmpDir;
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

  it('leads with the session resource handle when memory is on', async () => {
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
        getOmniRootDir() {
          return tmpDir;
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
    const { MediaResourceRegistry } = await import(
      '../services/media-memory/index.js'
    );
    const registry = new MediaResourceRegistry();

    const filePath = await realFile('pic.png');
    const result = await readMediaViaOmniDelivery({
      filePath,
      config: {
        ...deliveryConfig(),
        getOmniMemoryConfig: () => ({
          collection: { maxInlineTextBytes: 4096 },
        }),
        getOmniMediaResourceRegistry: () => registry,
      } as unknown as Config,
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });

    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    // Resource part FIRST — the hint/disclosure chain keeps its adjacency
    // to the media part (D8). A model-visible local source is referenced by
    // its ABSOLUTE PATH, not an opaque handle.
    const handleText = parts[0]!['text'] as string;
    expect(handleText).toContain('【媒体资源】');
    expect(handleText).toContain(filePath);
    expect(handleText).not.toContain('：media-');
    // The session handle is still registered and recoverable from the path.
    expect(registry.resolveByFileRef(filePath)).toMatchObject({
      mediaType: 'image',
    });
    expect(parts[1]!['text']).toContain('zoom_image');
    expect(parts[2]).toHaveProperty('fileData');
  });

  it('keeps the handle form when the binding fileRef is not the read path', async () => {
    // Mirror image of the path-form test above: a path-less source (tool /
    // URL media) binds with an internal object-store `fileRef` that is NOT
    // the path the model read, so it must keep the opaque handle — there is
    // no model-visible path to show. The real pipeline never produces a
    // divergent fileRef for a user read (sourceFileRef === filePath), so the
    // fallback is exercised at the resolve() seam via a wrapper registry.
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
        getOmniRootDir() {
          return tmpDir;
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
    const { MediaResourceRegistry } = await import(
      '../services/media-memory/index.js'
    );
    const { parseResourceHandleText } = await import('./disclosure.js');
    const real = new MediaResourceRegistry();
    // bind() delegates; resolve() reports a fileRef that differs from the
    // read path (as an object-store locator would), forcing the handle form.
    const registry = {
      bind: (input: Parameters<MediaResourceRegistry['bind']>[0]) =>
        real.bind(input),
      resolve: (id: string) => {
        const b = real.resolve(id);
        return b ? { ...b, fileRef: `${b.fileRef}.object-store` } : undefined;
      },
      resolveByFileRef: (ref: string) => real.resolveByFileRef(ref),
      resolveVersion: (v: string) => real.resolveVersion(v),
      activeFileRefs: () => real.activeFileRefs(),
    } as unknown as InstanceType<typeof MediaResourceRegistry>;

    const filePath = await realFile('pic.png');
    const result = await readMediaViaOmniDelivery({
      filePath,
      config: {
        ...deliveryConfig(),
        getOmniMemoryConfig: () => ({
          collection: { maxInlineTextBytes: 4096 },
        }),
        getOmniMediaResourceRegistry: () => registry,
      } as unknown as Config,
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });

    const parts = result.llmContent as Array<Record<string, unknown>>;
    const handleText = parts[0]!['text'] as string;
    // Handle form, NOT the path: the object-store fileRef is not the read
    // path, so the model gets the opaque handle it can still recall with.
    expect(handleText).toContain('：media-');
    expect(handleText).not.toContain(filePath);
    const resourceId = parseResourceHandleText(handleText);
    expect(resourceId).toBeDefined();
    expect(real.resolve(resourceId!)).toMatchObject({ mediaType: 'image' });
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
        getOmniRootDir() {
          return tmpDir;
        }
        getObjectsDir() {
          return path.join(tmpDir, 'objects');
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
          return tmpDir;
        }
        getObjectsDir() {
          return path.join(tmpDir, 'objects');
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
          return tmpDir;
        }
        getObjectsDir() {
          return path.join(tmpDir, 'objects');
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

describe('processMediaForOmniDelivery upload cache integration', () => {
  // The REAL upload-cache.js and recovery.js modules run against a temp omni
  // root; only the leaf deps (ffmpeg/recognition/storage/upload) are mocked.
  // This pins the wiring itself: hit skips store+upload, miss persists,
  // ttl 0 disables, scope isolates credentials, recovery runs.
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-cache-int-'));
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.doUnmock('./ffmpeg.js');
    vi.doUnmock('./recognition.js');
    vi.doUnmock('./storage.js');
    vi.doUnmock('./upload.js');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function cacheConfig(overrides?: {
    cgc?: Record<string, unknown>;
    ttlHours?: number;
    inferenceModel?: string;
    upload?: OmniUploadConfig;
  }): Config {
    return {
      isOmniEnabled: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue(overrides?.cgc ?? DASHSCOPE_CGC),
      getModel: vi
        .fn()
        .mockReturnValue(overrides?.inferenceModel ?? 'qwen3.5-omni-plus'),
      getOmniUploadConfig: vi.fn().mockReturnValue(overrides?.upload),
      getOmniMaxUploadFileBytes: vi.fn().mockReturnValue(0),
      getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(0),
      getOmniUploadUrlTtlHours: vi.fn().mockReturnValue(overrides?.ttlHours),
      storage: { getQwenDir: () => tmpDir },
    } as unknown as Config;
  }

  /** Installs leaf mocks around a shared pair of spies and imports the
   * pipeline. The mocked store roots at tmpDir, so the real cache file
   * lands at tmpDir/upload-cache.json. */
  async function armPipeline() {
    const putFileMock = vi
      .fn()
      .mockResolvedValue({ objectPath: '/tmp/obj.mp3', deduped: false });
    const uploadFileMock = vi.fn().mockResolvedValue('oss://bucket/cached');
    const uploaderOptionsMock = vi.fn();
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi
        .fn()
        .mockResolvedValue(mockRecognizedFor('audio', { durationMs: 60_000 })),
      hashFileSha256: vi.fn().mockResolvedValue('b'.repeat(64)),
      extensionForMime: vi.fn().mockReturnValue('.mp3'),
    }));
    const objectsDir = path.join(tmpDir, 'objects');
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        putFile = putFileMock;
        getOmniRootDir() {
          return tmpDir;
        }
        getObjectsDir() {
          return objectsDir;
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        constructor(options: unknown) {
          uploaderOptionsMock(options);
        }
        uploadFile = uploadFileMock;
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    const mod = await import('./index.js');
    return { putFileMock, uploadFileMock, uploaderOptionsMock, mod };
  }

  function mockRecognizedFor(
    modality: 'audio',
    metadata: Record<string, unknown>,
  ) {
    return {
      modality,
      detectedMimeType: 'audio/mpeg',
      sizeBytes: 1234,
      metadata,
    };
  }

  async function realFile(name: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, 'not really media');
    return filePath;
  }

  it('serves a repeat delivery from the cache: no second store copy or upload', async () => {
    const { putFileMock, uploadFileMock, mod } = await armPipeline();
    const filePath = await realFile('song.mp3');
    const config = cacheConfig();

    const first = await mod.processMediaForOmniDelivery(filePath, config);
    expect(first.uploadCacheHit).toBe(false);
    expect(putFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);

    const second = await mod.processMediaForOmniDelivery(filePath, config);
    expect(second.uploadCacheHit).toBe(true);
    expect(second.fileUri).toBe(first.fileUri);
    expect(second.deduped).toBe(true);
    // Hit path must run BEFORE store promotion and upload.
    expect(putFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });

  it('persists the miss: the oss URL lands in upload-cache.json on disk', async () => {
    const { mod } = await armPipeline();
    await mod.processMediaForOmniDelivery(
      await realFile('song.mp3'),
      cacheConfig(),
    );
    const raw = await fs.readFile(
      path.join(tmpDir, 'upload-cache.json'),
      'utf8',
    );
    expect(raw).toContain('oss://bucket/cached');
    expect(raw).toContain('b'.repeat(64));
  });

  it('re-uploads every time when the cache TTL is configured to 0', async () => {
    const { uploadFileMock, mod } = await armPipeline();
    const filePath = await realFile('song.mp3');
    const config = cacheConfig({ ttlHours: 0 });

    const first = await mod.processMediaForOmniDelivery(filePath, config);
    const second = await mod.processMediaForOmniDelivery(filePath, config);
    expect(first.uploadCacheHit).toBe(false);
    expect(second.uploadCacheHit).toBe(false);
    expect(uploadFileMock).toHaveBeenCalledTimes(2);
  });

  it('never serves a URL cached under a different credential or endpoint', async () => {
    // An oss:// URL is minted for one (origin, apiKey) pair; switching
    // accounts must re-upload rather than reuse a URL the new credential
    // may not own.
    const { uploadFileMock, mod } = await armPipeline();
    const filePath = await realFile('song.mp3');

    await mod.processMediaForOmniDelivery(filePath, cacheConfig());
    const otherKey = await mod.processMediaForOmniDelivery(
      filePath,
      cacheConfig({ cgc: { ...DASHSCOPE_CGC, apiKey: 'sk-other-key' } }),
    );
    expect(otherKey.uploadCacheHit).toBe(false);
    expect(uploadFileMock).toHaveBeenCalledTimes(2);

    // Same credential again: both prior entries coexist; still a hit.
    const back = await mod.processMediaForOmniDelivery(filePath, cacheConfig());
    expect(back.uploadCacheHit).toBe(true);
    expect(uploadFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses only the dedicated upload endpoint, key, and model', async () => {
    const { uploadFileMock, uploaderOptionsMock, mod } = await armPipeline();
    const upload: OmniUploadConfig = {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'upload-key',
      model: 'dashscope-upload-model',
    };
    await mod.processMediaForOmniDelivery(
      await realFile('song.mp3'),
      cacheConfig({
        cgc: {
          authType: AuthType.USE_OPENAI,
          apiKey: 'inference-key',
          baseUrl: 'http://127.0.0.1:22002/v1',
        },
        inferenceModel: 'qwen4-omni-120b-think',
        upload,
      }),
    );

    expect(uploaderOptionsMock).toHaveBeenCalledWith({
      apiKey: upload.apiKey,
      baseUrl: upload.baseUrl,
    });
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: upload.model }),
    );
  });

  it('keeps a dedicated upload cache hit when only inference changes', async () => {
    const { uploadFileMock, mod } = await armPipeline();
    const upload: OmniUploadConfig = {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'upload-key',
      model: 'dashscope-upload-model',
    };
    const filePath = await realFile('song.mp3');

    await mod.processMediaForOmniDelivery(
      filePath,
      cacheConfig({
        cgc: { baseUrl: 'http://inference-a/v1', apiKey: 'inference-a' },
        inferenceModel: 'custom-a',
        upload,
      }),
    );
    const second = await mod.processMediaForOmniDelivery(
      filePath,
      cacheConfig({
        cgc: { baseUrl: 'http://inference-b/v1', apiKey: 'inference-b' },
        inferenceModel: 'custom-b',
        upload,
      }),
    );

    expect(second.uploadCacheHit).toBe(true);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });

  it('runs startup recovery: an expired download .part is swept on first delivery', async () => {
    const downloadsDir = path.join(tmpDir, 'downloads');
    await fs.mkdir(downloadsDir, { recursive: true });
    const expired = path.join(downloadsDir, 'stale.part');
    await fs.writeFile(expired, 'partial');
    const old = new Date(Date.now() - 49 * 3600_000);
    await fs.utimes(expired, old, old);

    const { mod } = await armPipeline();
    await mod.processMediaForOmniDelivery(
      await realFile('song.mp3'),
      cacheConfig(),
    );
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('processMediaForOmniDelivery fixed-policy integration', () => {
  // The orchestrator itself is unit-tested in policy/orchestrator.test.ts;
  // these tests pin the pipeline wiring around it: when it runs, what it
  // receives, how its output replaces the source, that the transport guard
  // judges the FINAL delivery (decision D1), and how failures surface.
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-policy-int-'));
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.doUnmock('./ffmpeg.js');
    vi.doUnmock('./recognition.js');
    vi.doUnmock('./storage.js');
    vi.doUnmock('./upload.js');
    vi.doUnmock('./policy/orchestrator.js');
    vi.doUnmock('./recovery.js');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const SOURCE_RECOGNIZED = {
    modality: 'image',
    detectedMimeType: 'image/png',
    sizeBytes: 5000,
    metadata: { width: 4000, height: 3000 },
  };
  const DEGRADED_RECOGNIZED = {
    modality: 'image',
    detectedMimeType: 'image/jpeg',
    sizeBytes: 100,
    metadata: { width: 1568, height: 1176 },
  };
  // Only `.length > 0` matters to the pipeline; the mocked orchestrator
  // never reads the entries.
  const POLICY_STUB = [{ id: 'img-downsample' }];
  // Mirrors DEFAULT_OMNI_PROCESSING_LIMITS (normalization is unit-tested
  // in policy/config.test.ts; the pipeline dereferences maxTransportPasses
  // and forwards the object to the orchestrator).
  const LIMITS_STUB = {
    maxConcurrentResources: 1,
    reservedOutputTokens: 8192,
    maxLineageDepth: 8,
    maxPolicyRunsPerRoot: 64,
    maxArtifactsPerRoot: 256,
    maxDerivedBytesPerRoot: 1073741824,
    maxTransportPasses: 3,
  };

  function policyConfig(overrides?: {
    maxUploadFileBytes?: number;
    policies?: unknown[];
    transportGuardPolicies?: unknown[];
    maxTransportPasses?: number;
    /** Simulates a stub/embedder config without the accessor. */
    noProcessingConfig?: boolean;
    /** Resolved model window for the session.* snapshot. */
    contextWindowSize?: number;
    /** Current chat's last prompt token count for the session.* snapshot. */
    lastPromptTokenCount?: number;
  }): Config {
    return {
      isOmniEnabled: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getContentGeneratorConfig: vi.fn().mockReturnValue(
        overrides?.contextWindowSize !== undefined
          ? {
              ...DASHSCOPE_CGC,
              contextWindowSize: overrides.contextWindowSize,
            }
          : DASHSCOPE_CGC,
      ),
      ...(overrides?.lastPromptTokenCount !== undefined
        ? {
            getGeminiClient: () => ({
              getChat: () => ({
                getLastPromptTokenCount: () => overrides.lastPromptTokenCount,
              }),
            }),
          }
        : {}),
      getModel: vi.fn().mockReturnValue('qwen3.5-omni-plus'),
      getOmniMaxUploadFileBytes: vi
        .fn()
        .mockReturnValue(overrides?.maxUploadFileBytes ?? 0),
      getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(0),
      getOmniProcessingConfig: vi.fn().mockReturnValue(
        overrides?.noProcessingConfig
          ? undefined
          : {
              fixedPolicies: overrides?.policies ?? POLICY_STUB,
              transportGuardPolicies: overrides?.transportGuardPolicies ?? [],
              limits: {
                ...LIMITS_STUB,
                ...(overrides?.maxTransportPasses !== undefined
                  ? { maxTransportPasses: overrides.maxTransportPasses }
                  : {}),
              },
            },
      ),
      storage: { getQwenDir: () => tmpDir },
    } as unknown as Config;
  }

  async function armPipeline(runFixedPoliciesMock: ReturnType<typeof vi.fn>) {
    const putFileMock = vi
      .fn()
      .mockResolvedValue({ objectPath: '/tmp/obj.jpg', deduped: false });
    const uploadFileMock = vi.fn().mockResolvedValue('oss://bucket/degraded');
    const hashFileMock = vi.fn().mockResolvedValue('a'.repeat(64));
    vi.doMock('./ffmpeg.js', () => ({
      isFfmpegAvailable: vi.fn().mockResolvedValue(true),
      isFfprobeAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./recognition.js', () => ({
      recognizeMediaFile: vi.fn().mockResolvedValue(SOURCE_RECOGNIZED),
      hashFileSha256: hashFileMock,
      extensionForMime: vi.fn().mockReturnValue('.jpg'),
    }));
    const objectsDir = path.join(tmpDir, 'objects');
    vi.doMock('./storage.js', () => ({
      OmniObjectStore: class {
        putFile = putFileMock;
        getOmniRootDir() {
          return tmpDir;
        }
        getObjectsDir() {
          return objectsDir;
        }
        objectPathFor(sha256: string, extension: string) {
          return path.join(objectsDir, `${sha256}${extension}`);
        }
      },
    }));
    vi.doMock('./upload.js', () => ({
      DashScopeUploader: class {
        uploadFile = uploadFileMock;
      },
      OSS_URL_PREFIX: 'oss://',
    }));
    vi.doMock('./policy/orchestrator.js', () => ({
      runFixedPolicies: runFixedPoliciesMock,
      OmniPolicyExecutionError: class extends Error {},
    }));
    const mod = await import('./index.js');
    return { putFileMock, uploadFileMock, hashFileMock, mod };
  }

  async function realFile(name: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, 'not really media');
    return filePath;
  }

  it('replaces the source with the policy derivative and carries its disclosure', async () => {
    const degradedPath = path.join(tmpDir, 'objects', 'deadbeef.jpg');
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: degradedPath,
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { putFileMock, hashFileMock, mod } = await armPipeline(runMock);
    const filePath = await realFile('pic.png');
    const config = policyConfig();

    const result = await mod.processMediaForOmniDelivery(filePath, config);

    // The orchestrator received the source resource with user provenance.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      config,
      {
        filePath,
        recognized: SOURCE_RECOGNIZED,
        displayName: 'pic.png',
        origin: 'user',
      },
      expect.objectContaining({ policies: POLICY_STUB }),
    );
    // Storage/upload operate on the DERIVATIVE under its promotion hash;
    // the source is never re-hashed (the derivative arrived with one).
    expect(putFileMock).toHaveBeenCalledWith(
      degradedPath,
      'b'.repeat(64),
      '.jpg',
      undefined,
    );
    expect(hashFileMock).not.toHaveBeenCalled();
    expect(result.fileUri).toBe('oss://bucket/degraded');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sha256).toBe('b'.repeat(64));
    expect(result.recognized).toBe(DEGRADED_RECOGNIZED);
    expect(result.disclosure).toBe('downsampled to 1568px');
    expect(result.degraded).toBe(true);
  });

  // ── session.* condition namespace snapshot (policy design §8.3) ───────
  it('threads a stub-config session snapshot (reserved tokens only) into the orchestrator', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    await expect(
      mod.processMediaForOmniDelivery(
        await realFile('pic.png'),
        policyConfig(),
      ),
    ).rejects.toThrow();
    // Window size and prompt count are unknown on the stub config: the
    // snapshot must carry ONLY the reserved-output limit — absent fields
    // read as `unavailable`, never as zero.
    expect(runMock.mock.calls[0][2].conditionContext).toEqual({
      session: { reservedOutputTokens: 8192 },
    });
  });

  it('snapshots the full session namespace once and reuses it for the guard pass', async () => {
    const preprocessedPath = path.join(tmpDir, 'objects', 'pre.jpg');
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: preprocessedPath,
            recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
            sha256: 'b'.repeat(64),
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      })
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: guardedPath,
            recognized: DEGRADED_RECOGNIZED,
            sha256: 'c'.repeat(64),
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      });
    const { mod } = await armPipeline(runMock);
    await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        maxUploadFileBytes: 500,
        transportGuardPolicies: [{ id: 'img-guard', mediaTypes: ['image'] }],
        contextWindowSize: 131072,
        lastPromptTokenCount: 20000,
      }),
    );

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[0][2].conditionContext).toEqual({
      session: {
        reservedOutputTokens: 8192,
        contextWindowTokens: 131072,
        promptTokenCount: 20000,
        availableContextTokens: 131072 - 20000 - 8192,
      },
    });
    // The guard pass receives the SAME snapshot object — taken once per
    // delivery, constant across every pass of that delivery.
    expect(runMock.mock.calls[1][2].conditionContext).toBe(
      runMock.mock.calls[0][2].conditionContext,
    );
  });

  it('skips the orchestrator entirely when no fixed policies are configured', async () => {
    const runMock = vi.fn();
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({ policies: [] }),
    );
    expect(runMock).not.toHaveBeenCalled();
    expect(result.disclosure).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });

  it('judges the transport byte guard on the FINAL delivery, not the source', async () => {
    // Source 5000 bytes, cap 500: without policies this delivery would be
    // rejected. The derivative is 100 bytes — the reordered pipeline (D1)
    // must accept it.
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({ maxUploadFileBytes: 500 }),
    );
    expect(result.degraded).toBe(true);
  });

  it('explicitly omits an over-cap FINAL delivery when no guard policy matches its modality', async () => {
    // Stage B (policy design §10.2): with a processing config present, a
    // persisting violation is an explicit OMISSION, not a throw. The audio
    // guard policy does not match an image, so no guard pass runs.
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
          sha256: 'b'.repeat(64),
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { putFileMock, uploadFileMock, mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        maxUploadFileBytes: 500,
        transportGuardPolicies: [{ id: 'guard-audio', mediaTypes: ['audio'] }],
      }),
    );
    // Only the fixed-policy stage ran — never a guard pass.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      fileUri: '',
      sha256: 'b'.repeat(64),
      deduped: false,
      uploadCacheHit: false,
      degraded: true,
    });
    expect(result.omission?.reason).toContain('900 bytes > 500 bytes');
    // Nothing was stored or uploaded for an omitted resource.
    expect(putFileMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('keeps the fail-closed throw when there is no processing config at all', async () => {
    // Stub configs / embedders skipping initialize have no normalized
    // processing config; the Stage A guard behavior must survive for them.
    const runMock = vi.fn();
    const { mod } = await armPipeline(runMock);
    await expect(
      mod.processMediaForOmniDelivery(
        await realFile('pic.png'),
        policyConfig({ maxUploadFileBytes: 500, noProcessingConfig: true }),
      ),
    ).rejects.toMatchObject({ name: 'OmniTransportGuardError' });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('wraps orchestrator failures into a sanitized OmniDeliveryError', async () => {
    const runMock = vi.fn().mockRejectedValue(new Error('policy blew up'));
    const { mod } = await armPipeline(runMock);
    await expect(
      mod.processMediaForOmniDelivery(
        await realFile('pic.png'),
        policyConfig(),
      ),
    ).rejects.toMatchObject({
      name: 'OmniDeliveryError',
      message: 'Fixed-policy processing failed for pic.png: policy blew up',
    });
  });

  it('rejects a delivery set that is not exactly one resource', async () => {
    const runMock = vi
      .fn()
      .mockResolvedValue({ deliveries: [], records: [], fileDeliveries: [] });
    const { mod } = await armPipeline(runMock);
    await expect(
      mod.processMediaForOmniDelivery(
        await realFile('pic.png'),
        policyConfig(),
      ),
    ).rejects.toMatchObject({
      name: 'OmniDeliveryError',
      message:
        'Fixed policies produced 0 media deliverables for pic.png; exactly one is supported.',
    });
  });

  // ── Multi-output fixed policies (#8187 多产物投递) ───────────────────
  const FRAME_2_RECOGNIZED = {
    modality: 'image',
    detectedMimeType: 'image/jpeg',
    sizeBytes: 120,
    metadata: { width: 640, height: 360 },
  };
  const FRAME_3_RECOGNIZED = { ...FRAME_2_RECOGNIZED, sizeBytes: 130 };

  function keyframeDeliveries(tmp: string) {
    return [
      {
        filePath: path.join(tmp, 'objects', 'frame1.jpg'),
        recognized: DEGRADED_RECOGNIZED,
        sha256: 'b'.repeat(64),
        disclosure: '帧 1/3',
        degraded: true,
      },
      {
        filePath: path.join(tmp, 'objects', 'frame2.jpg'),
        recognized: FRAME_2_RECOGNIZED,
        sha256: 'd'.repeat(64),
        disclosure: '帧 2/3',
        degraded: true,
      },
      {
        filePath: path.join(tmp, 'objects', 'frame3.jpg'),
        recognized: FRAME_3_RECOGNIZED,
        sha256: 'e'.repeat(64),
        disclosure: '帧 3/3',
        degraded: true,
      },
    ];
  }

  it('uploads every deliverable of a multi-output policy and carries the extras in additionalMedia', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: keyframeDeliveries(tmpDir),
      records: [],
      fileDeliveries: [],
    });
    const { putFileMock, uploadFileMock, hashFileMock, mod } =
      await armPipeline(runMock);
    uploadFileMock
      .mockResolvedValueOnce('oss://bucket/frame1')
      .mockResolvedValueOnce('oss://bucket/frame2')
      .mockResolvedValueOnce('oss://bucket/frame3');

    const result = await mod.processMediaForOmniDelivery(
      await realFile('vid.mp4'),
      policyConfig(),
    );

    // Primary = first deliverable; the rest ride in additionalMedia, in
    // orchestrator order, each with its own URL/hash/disclosure.
    expect(result.fileUri).toBe('oss://bucket/frame1');
    expect(result.sha256).toBe('b'.repeat(64));
    expect(result.additionalMedia).toEqual([
      {
        fileUri: 'oss://bucket/frame2',
        mimeType: 'image/jpeg',
        sha256: 'd'.repeat(64),
        disclosure: '帧 2/3',
      },
      {
        fileUri: 'oss://bucket/frame3',
        mimeType: 'image/jpeg',
        sha256: 'e'.repeat(64),
        disclosure: '帧 3/3',
      },
    ]);
    // Every deliverable went through the SAME store→upload pipeline.
    expect(putFileMock).toHaveBeenCalledTimes(3);
    expect(uploadFileMock).toHaveBeenCalledTimes(3);
    // All arrived with promotion hashes — nothing is re-hashed.
    expect(hashFileMock).not.toHaveBeenCalled();
  });

  it('explicitly omits an over-cap ADDITIONAL deliverable while the rest deliver', async () => {
    const deliveries = keyframeDeliveries(tmpDir);
    deliveries[1] = {
      ...deliveries[1],
      recognized: { ...FRAME_2_RECOGNIZED, sizeBytes: 900 },
    };
    const runMock = vi.fn().mockResolvedValue({
      deliveries,
      records: [],
      fileDeliveries: [],
    });
    const { putFileMock, uploadFileMock, mod } = await armPipeline(runMock);

    const result = await mod.processMediaForOmniDelivery(
      await realFile('vid.mp4'),
      policyConfig({ maxUploadFileBytes: 500 }),
    );

    // The violating extra becomes an explicit omission entry (policy
    // design §10.2 — no re-derivation of derivatives); its neighbors and
    // the primary are unaffected.
    expect(result.fileUri).toBe('oss://bucket/degraded');
    expect(result.additionalMedia).toHaveLength(2);
    expect(result.additionalMedia![0]).toMatchObject({
      fileUri: '',
      sha256: 'd'.repeat(64),
      disclosure: '帧 2/3',
    });
    expect(result.additionalMedia![0].omission?.reason).toContain(
      '900 bytes > 500 bytes',
    );
    expect(result.additionalMedia![1]).toMatchObject({
      fileUri: 'oss://bucket/degraded',
      sha256: 'e'.repeat(64),
    });
    // The omitted extra never touched the store or the upload channel.
    expect(putFileMock).toHaveBeenCalledTimes(2);
    expect(uploadFileMock).toHaveBeenCalledTimes(2);
  });

  it('readMediaViaOmniDelivery materializes extras as [disclosure, fileData] pairs after the primary and before transcripts', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: keyframeDeliveries(tmpDir),
      records: [],
      fileDeliveries: [
        {
          filePath: '/tmp/objects/t.txt',
          role: 'transcript',
          mimeType: 'text/plain',
          text: '你好，世界',
          sha256: 'c'.repeat(64),
          sizeBytes: 15,
        },
      ],
    });
    const { uploadFileMock, mod } = await armPipeline(runMock);
    uploadFileMock
      .mockResolvedValueOnce('oss://bucket/frame1')
      .mockResolvedValueOnce('oss://bucket/frame2')
      .mockResolvedValueOnce('oss://bucket/frame3');

    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('vid.mp4'),
      config: policyConfig(),
      displayName: 'vid.mp4',
      relativePathForDisplay: 'vid.mp4',
      expectedModality: 'video',
    });

    const parts = result.llmContent as Array<Record<string, unknown>>;
    // [zoom hint, primary disclosure, primary fileData,
    //  extra1 disclosure, extra1 fileData, extra2 disclosure,
    //  extra2 fileData, transcript] — D8 adjacency per pair, transcripts
    // last.
    expect(parts.map((p) => ('fileData' in p ? 'media' : 'text'))).toEqual([
      'text',
      'text',
      'media',
      'text',
      'media',
      'text',
      'media',
      'text',
    ]);
    expect(parts[3]!['text']).toBe('【媒体降质】vid.mp4：帧 2/3');
    expect(parts[4]).toEqual({
      fileData: {
        fileUri: 'oss://bucket/frame2',
        mimeType: 'image/jpeg',
        displayName: 'vid.mp4',
      },
    });
    expect(parts[5]!['text']).toBe('【媒体降质】vid.mp4：帧 3/3');
    expect(parts[6]).toEqual({
      fileData: {
        fileUri: 'oss://bucket/frame3',
        mimeType: 'image/jpeg',
        displayName: 'vid.mp4',
      },
    });
    expect(parts[7]!['text']).toBe('【媒体转写】vid.mp4：你好，世界');
  });

  it('readMediaViaOmniDelivery still materializes extras when the PRIMARY is omitted', async () => {
    const deliveries = keyframeDeliveries(tmpDir).slice(0, 2);
    deliveries[0] = {
      ...deliveries[0],
      recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
    };
    const runMock = vi.fn().mockResolvedValue({
      deliveries,
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);

    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('vid.mp4'),
      config: policyConfig({ maxUploadFileBytes: 500 }),
      displayName: 'vid.mp4',
      relativePathForDisplay: 'vid.mp4',
      expectedModality: 'video',
    });

    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0]!['text']).toContain('【媒体省略】vid.mp4');
    expect(parts[1]!['text']).toBe('【媒体降质】vid.mp4：帧 2/3');
    expect(parts[2]).toEqual({
      fileData: {
        fileUri: 'oss://bucket/degraded',
        mimeType: 'image/jpeg',
        displayName: 'vid.mp4',
      },
    });
  });

  it('readMediaViaOmniDelivery places the disclosure immediately before the fileData part', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: policyConfig(),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });
    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    // Zoom hint shows the DELIVERED image's resolution (the derivative) —
    // and must not call it "full resolution", which would contradict the
    // degradation disclosure right below and steer the model away from
    // zoom_image (the remedy that reads the original from disk).
    expect(parts[0]!['text']).toContain('delivered at 1568x1176 px');
    expect(parts[0]!['text']).toContain('after degradation');
    expect(parts[0]!['text']).not.toContain('full resolution');
    expect(parts[1]!['text']).toBe(
      '【媒体降质】pic.png：downsampled to 1568px',
    );
    expect(parts[2]).toEqual({
      fileData: {
        fileUri: 'oss://bucket/degraded',
        mimeType: 'image/jpeg',
        displayName: 'pic.png',
      },
    });
  });

  // ── Transcript delivery (§6.2) ────────────────────────────────────────
  const TRANSCRIPT_FILE_DELIVERY = {
    filePath: '/tmp/objects/t.txt',
    role: 'transcript',
    mimeType: 'text/plain',
    text: '你好，世界',
    sha256: 'c'.repeat(64),
    sizeBytes: 15,
    disclosure: '原 63s 音频 → 转写文本 5 字',
  };

  it('returns a pure-transcript delivery without storing or uploading anything', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [],
      records: [],
      fileDeliveries: [TRANSCRIPT_FILE_DELIVERY],
    });
    const { putFileMock, uploadFileMock, mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig(),
    );

    // No media deliverable → nothing enters objects/ or the upload channel.
    expect(putFileMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(result.fileUri).toBe('');
    expect(result.sha256).toBe('');
    expect(result.mimeType).toBe('image/png');
    expect(result.degraded).toBe(true);
    expect(result.transcripts).toEqual([
      { text: '你好，世界', disclosure: '原 63s 音频 → 转写文本 5 字' },
    ]);
  });

  it('threads transcripts alongside a media deliverable into the upload result', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [TRANSCRIPT_FILE_DELIVERY],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig(),
    );
    expect(result.fileUri).toBe('oss://bucket/degraded');
    expect(result.transcripts).toEqual([
      { text: '你好，世界', disclosure: '原 63s 音频 → 转写文本 5 字' },
    ]);
  });

  it('readMediaViaOmniDelivery renders a pure-transcript delivery as text parts only', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [],
      records: [],
      fileDeliveries: [TRANSCRIPT_FILE_DELIVERY],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: policyConfig(),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });
    // Disclosure precedes its transcript (D8 adjacency); no fileData part.
    expect(result.llmContent).toEqual([
      { text: '【媒体降质】pic.png：原 63s 音频 → 转写文本 5 字' },
      { text: '【媒体转写】pic.png：你好，世界' },
    ]);
    expect(result.returnDisplay).toBe(
      'Read image as transcript (omni policy): pic.png',
    );
    expect(result.error).toBeUndefined();
  });

  it('readMediaViaOmniDelivery appends transcript parts after the media part', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [TRANSCRIPT_FILE_DELIVERY],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: policyConfig(),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });
    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(5);
    expect(parts[0]!['text']).toContain('1568x1176'); // zoom hint
    expect(parts[1]!['text']).toBe(
      '【媒体降质】pic.png：downsampled to 1568px',
    );
    expect(parts[2]!['fileData']).toBeDefined();
    expect(parts[3]!['text']).toBe(
      '【媒体降质】pic.png：原 63s 音频 → 转写文本 5 字',
    );
    expect(parts[4]!['text']).toBe('【媒体转写】pic.png：你好，世界');
  });

  it('readMediaViaOmniDelivery keeps transcripts when the media itself is omitted', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
          sha256: 'b'.repeat(64),
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [TRANSCRIPT_FILE_DELIVERY],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: policyConfig({ maxUploadFileBytes: 500 }),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });
    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0]!['text']).toMatch(/^【媒体省略】pic\.png：/);
    expect(parts[1]!['text']).toBe(
      '【媒体降质】pic.png：原 63s 音频 → 转写文本 5 字',
    );
    expect(parts[2]!['text']).toBe('【媒体转写】pic.png：你好，世界');
    expect(result.error).toBeUndefined();
  });

  // ── Stage B transport-guard pass loop ────────────────────────────────
  // With `policies: []` the fixed-policy stage is skipped entirely, so
  // every runFixedPolicies call in these tests is a GUARD pass on the
  // 5000-byte source (cap 500 → violation).
  const IMG_GUARD = { id: 'img-guard', mediaTypes: ['image'] };

  it('runs a matching guard policy on a violation and delivers the compliant result', async () => {
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: guardedPath,
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          disclosure: 'downsampled to 1568px',
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const filePath = await realFile('pic.png');
    const config = policyConfig({
      policies: [],
      maxUploadFileBytes: 500,
      transportGuardPolicies: [IMG_GUARD],
    });

    const result = await mod.processMediaForOmniDelivery(filePath, config);

    // One guard pass over the SOURCE, restricted to the matching policies.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      config,
      {
        filePath,
        recognized: SOURCE_RECOGNIZED,
        displayName: 'pic.png',
        origin: 'user',
      },
      expect.objectContaining({
        policies: [IMG_GUARD],
        limits: expect.objectContaining({ maxTransportPasses: 3 }),
      }),
    );
    expect(result.fileUri).toBe('oss://bucket/degraded');
    expect(result.omission).toBeUndefined();
    expect(result.degraded).toBe(true);
    expect(result.disclosure).toBe('downsampled to 1568px');
  });

  it('chains preprocessing and guard disclosures instead of replacing (D8)', async () => {
    // Preprocessing degrades once (disclosure A) but the derivative is
    // still over the byte cap; the guard degrades AGAIN (disclosure B).
    // Both lossy steps must reach the model — a replaced disclosure would
    // silently hide the first degradation.
    const preprocessedPath = path.join(tmpDir, 'objects', 'pre.jpg');
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: preprocessedPath,
            recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
            sha256: 'b'.repeat(64),
            disclosure: 'downsampled to 1568px',
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      })
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: guardedPath,
            recognized: DEGRADED_RECOGNIZED,
            sha256: 'c'.repeat(64),
            disclosure: 're-encoded at quality 60',
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      });
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        maxUploadFileBytes: 500,
        transportGuardPolicies: [IMG_GUARD],
      }),
    );

    expect(runMock).toHaveBeenCalledTimes(2);
    // Guard pass ran on the PREPROCESSED derivative, not the source.
    expect(runMock.mock.calls[1][1]).toMatchObject({
      filePath: preprocessedPath,
    });
    expect(result.omission).toBeUndefined();
    expect(result.disclosure).toBe(
      'downsampled to 1568px；re-encoded at quality 60',
    );
    expect(result.degraded).toBe(true);
    expect(result.sha256).toBe('c'.repeat(64));
  });

  it('stops after maxTransportPasses passes and omits when still violating', async () => {
    let call = 0;
    const runMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return {
        deliveries: [
          {
            // A NEW path every pass: progress is being made, so only the
            // pass counter can end the loop.
            filePath: path.join(tmpDir, 'objects', `pass-${call}.jpg`),
            recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
            sha256: String(call).repeat(64).slice(0, 64),
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      };
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        policies: [],
        maxUploadFileBytes: 500,
        maxTransportPasses: 2,
        transportGuardPolicies: [IMG_GUARD],
      }),
    );
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(result.omission?.reason).toContain('900 bytes > 500 bytes');
    expect(result.fileUri).toBe('');
  });

  it('breaks out of the guard loop when a pass makes no progress', async () => {
    // Every guard policy no_op'd: the delivery IS the input resource. A
    // second pass would repeat identical work forever.
    const runMock = vi.fn().mockImplementation(async (_config, resource) => ({
      deliveries: [
        { filePath: resource.filePath, recognized: resource.recognized },
      ],
      records: [],
      fileDeliveries: [],
    }));
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        policies: [],
        maxUploadFileBytes: 500,
        transportGuardPolicies: [IMG_GUARD],
      }),
    );
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result.omission?.reason).toContain('5000 bytes > 500 bytes');
  });

  it('fails closed when a guard pass itself fails', async () => {
    // A guard configuration error must never degrade into sending
    // over-limit media (policy design §10.2). The error class matters:
    // OmniTransportGuardError is what tells consumers with an inline
    // fallback (the tool-result funnel) to WITHHOLD the bytes — a generic
    // delivery error would fall back to delivering exactly what the guard
    // rejected.
    const runMock = vi.fn().mockRejectedValue(new Error('guard blew up'));
    const { mod } = await armPipeline(runMock);
    await expect(
      mod.processMediaForOmniDelivery(
        await realFile('pic.png'),
        policyConfig({
          policies: [],
          maxUploadFileBytes: 500,
          transportGuardPolicies: [IMG_GUARD],
        }),
      ),
    ).rejects.toMatchObject({
      name: 'OmniTransportGuardError',
      message: 'Transport-guard processing failed for pic.png: guard blew up',
    });
  });

  it('re-filters guard policies by modality after a pass changes it', async () => {
    // Pass 1 transforms the over-limit image into an over-limit AUDIO
    // derivative (modality change); pass 2 must run the AUDIO guard policy
    // against it. A pre-loop filter (image only) would find no matching
    // policy and omit a resource the audio policy can still fix.
    const imageGuard = { id: 'img-guard', mediaTypes: ['image'] };
    const audioGuard = { id: 'audio-guard', mediaTypes: ['audio'] };
    const bigAudioPath = path.join(tmpDir, 'objects', 'audio-big.mp3');
    await fs.mkdir(path.dirname(bigAudioPath), { recursive: true });
    await fs.writeFile(bigAudioPath, Buffer.alloc(900));
    const smallAudioPath = path.join(tmpDir, 'objects', 'audio-small.mp3');
    await fs.writeFile(smallAudioPath, Buffer.alloc(400));
    const audioRecognized = (sizeBytes: number) => ({
      modality: 'audio',
      detectedMimeType: 'audio/mpeg',
      sizeBytes,
      metadata: { durationMs: 60000 },
    });
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: bigAudioPath,
            recognized: audioRecognized(900),
            sha256: 'c'.repeat(64),
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      })
      .mockResolvedValueOnce({
        deliveries: [
          {
            filePath: smallAudioPath,
            recognized: audioRecognized(400),
            sha256: 'd'.repeat(64),
            degraded: true,
          },
        ],
        records: [],
        fileDeliveries: [],
      });
    const { mod } = await armPipeline(runMock);
    const result = await mod.processMediaForOmniDelivery(
      await realFile('pic.png'),
      policyConfig({
        policies: [],
        maxUploadFileBytes: 500,
        transportGuardPolicies: [imageGuard, audioGuard],
        maxTransportPasses: 3,
      }),
    );
    expect(runMock).toHaveBeenCalledTimes(2);
    // Pass 1 ran the image policy set; pass 2 must have run the AUDIO set.
    expect(runMock.mock.calls[0][2].policies).toEqual([imageGuard]);
    expect(runMock.mock.calls[1][2].policies).toEqual([audioGuard]);
    expect(result.omission).toBeUndefined();
    expect(result.fileUri).not.toBe('');
  });

  it('readMediaViaOmniDelivery renders an omission as the notice text, not an error', async () => {
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
          sha256: 'b'.repeat(64),
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const result = await mod.readMediaViaOmniDelivery({
      filePath: await realFile('pic.png'),
      config: policyConfig({ maxUploadFileBytes: 500 }),
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });
    expect(typeof result.llmContent).toBe('string');
    expect(result.llmContent).toMatch(/^【媒体省略】pic\.png：/);
    expect(result.llmContent).toContain('900 bytes > 500 bytes');
    expect(result.returnDisplay).toBe(
      'Media omitted by the omni transport guard: pic.png',
    );
    expect(result.error).toBeUndefined();
    expect(result.errorType).toBeUndefined();
  });

  it('readMediaViaOmniDelivery keeps the recall reference on an omitted media', async () => {
    // The omission branch is the one shape that puts NO media part in front
    // of the model. Without a reference leading it, the withheld resource has
    // no identity the model can name — it can neither recall what memory
    // knows about it nor ask a policy tool to reprocess it into something
    // deliverable. For a model-visible local source that reference is the
    // absolute path (recall still resolves it via resolveByFileRef); a
    // path-less source would keep an opaque handle (M §5.2).
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
          sha256: 'b'.repeat(64),
          degraded: true,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const { MediaResourceRegistry } = await import(
      '../services/media-memory/index.js'
    );
    const registry = new MediaResourceRegistry();

    const filePath = await realFile('pic.png');
    const result = await mod.readMediaViaOmniDelivery({
      filePath,
      config: {
        ...policyConfig({ maxUploadFileBytes: 500 }),
        getOmniMemoryConfig: () => ({
          collection: { maxInlineTextBytes: 4096 },
        }),
        getOmniMediaResourceRegistry: () => registry,
      } as unknown as Config,
      displayName: 'pic.png',
      relativePathForDisplay: 'pic.png',
      expectedModality: 'image',
    });

    // With memory off this branch collapses to a bare notice string (test
    // above); a bound resource must turn it into a part array led by the
    // resource reference, with the notice standing in for the media behind
    // it. The local source is referenced by its absolute path.
    const parts = result.llmContent as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    const handleText = parts[0]!['text'] as string;
    expect(handleText).toContain('【媒体资源】');
    expect(handleText).toContain(filePath);
    expect(handleText).not.toContain('：media-');
    expect(registry.resolveByFileRef(filePath)).toMatchObject({
      mediaType: 'image',
    });
    expect(parts[1]!['text']).toMatch(/^【媒体省略】pic\.png：/);
    expect(result.returnDisplay).toBe(
      'Media omitted by the omni transport guard: pic.png',
    );
  });

  it('threads the quarantine retention settings into startup recovery', async () => {
    const recoveryMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./recovery.js', () => ({
      runStartupRecoveryOnce: recoveryMock,
      resetRecoveryLatchForTests: vi.fn(),
    }));
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const config = {
      ...policyConfig(),
      getOmniQuarantineRetentionDays: () => 3,
      getOmniQuarantineMaxBytes: () => 1024,
    } as unknown as Config;

    await mod.processMediaForOmniDelivery(await realFile('pic.png'), config);

    expect(recoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        quarantineRetentionDays: 3,
        quarantineMaxBytes: 1024,
        // Corrupt-object deletion cascades into the degradation cache.
        // (Structural match: armPipeline's fresh module graph makes the
        // class identity differ from this file's static import.)
        degradationCache: expect.objectContaining({
          removeByOriginalSha256: expect.any(Function),
          removeByDegradedSha256: expect.any(Function),
        }),
      },
    );
  });

  it('anchors tool-result media to the object store, not its staging file', async () => {
    // The tool-result funnel writes bytes to a staging `.part` and deletes
    // it in `finally` the same turn, while this delivery promotes the same
    // bytes into the content-addressed store. Recording the staging path
    // as the persistent identity handed the model a handle resolving to a
    // deleted file (ENOENT for any policy tool pointed at it) and made
    // recall report `artifact_unavailable` for an artifact that persists.
    const runMock = vi
      .fn()
      .mockResolvedValue({ deliveries: [], records: [], fileDeliveries: [] });
    const { mod } = await armPipeline(runMock);
    const registry = new MediaResourceRegistry();
    const stagingPath = await realFile('tool-media.part');
    const config = {
      ...policyConfig({ policies: [] }),
      getOmniMemoryConfig: () => ({ collection: { maxInlineTextBytes: 4096 } }),
      getOmniMediaResourceRegistry: () => registry,
    } as unknown as Config;

    const delivery = await mod.processMediaForOmniDelivery(
      stagingPath,
      config,
      { origin: 'tool' },
    );

    const binding = registry.resolve(delivery.resourceId!);
    expect(binding).toBeDefined();
    // Content-addressed location derived from the hash — survives the
    // funnel's cleanup of the staging file.
    expect(binding!.fileRef).toBe(
      path.join(tmpDir, 'objects', `${'a'.repeat(64)}.jpg`),
    );
    expect(binding!.fileRef).not.toBe(stagingPath);
    // A user file keeps its own path (its bytes stay in place, S §4).
    const userRegistry = new MediaResourceRegistry();
    const userDelivery = await mod.processMediaForOmniDelivery(
      await realFile('photo.png'),
      {
        ...config,
        getOmniMediaResourceRegistry: () => userRegistry,
      } as unknown as Config,
    );
    expect(userRegistry.resolve(userDelivery.resourceId!)!.fileRef).toContain(
      'photo.png',
    );
  });

  it('anchors URL media to the object store and records the URL as its source', async () => {
    // The URL funnel stages its download under an opaque temp name and
    // deletes it in `finally` the same turn — the same lifetime as
    // tool-result media, missed when C9 fixed that funnel. Binding the
    // staging path handed the model a handle that resolves to ENOENT for
    // the rest of the session, and made cross-session recall report
    // `artifact_unavailable` for bytes the object store still holds.
    const runMock = vi
      .fn()
      .mockResolvedValue({ deliveries: [], records: [], fileDeliveries: [] });
    const { mod } = await armPipeline(runMock);
    const registry = new MediaResourceRegistry();
    const stagingPath = await realFile('dl-3f9a.part');
    const config = {
      ...policyConfig({ policies: [] }),
      getOmniMemoryConfig: () => ({ collection: { maxInlineTextBytes: 4096 } }),
      getOmniMediaResourceRegistry: () => registry,
    } as unknown as Config;

    const delivery = await mod.processMediaForOmniDelivery(
      stagingPath,
      config,
      {
        displayName: 'clip.mp4',
        sourceUrl: 'https://example.com/media/clip.mp4',
      },
    );

    const binding = registry.resolve(delivery.resourceId!);
    expect(binding).toBeDefined();
    expect(binding!.fileRef).toBe(
      path.join(tmpDir, 'objects', `${'a'.repeat(64)}.jpg`),
    );
    expect(binding!.fileRef).not.toBe(stagingPath);
    // The durable identity of URL media is the URL itself — recorded as
    // the version's source so provenance names where the bytes came from.
    const snapshot = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'memory.json'), 'utf8'),
    );
    const version = Object.values(
      snapshot.versions as Record<string, { source: unknown }>,
    ).find(
      (v) =>
        JSON.stringify(v.source) ===
        JSON.stringify({
          protocol: 'url',
          locator: 'https://example.com/media/clip.mp4',
        }),
    );
    expect(version).toBeDefined();
  });

  it('mounts memory-known deliveries into the session resource registry', async () => {
    const degradedPath = path.join(tmpDir, 'objects', 'deadbeef.jpg');
    const derivedBinding = {
      fileId: 'f-derived',
      fileVersionId: 'v-derived',
      rootFileId: 'f-root',
    };
    const runMock = vi.fn().mockResolvedValue({
      deliveries: [
        {
          filePath: degradedPath,
          recognized: DEGRADED_RECOGNIZED,
          sha256: 'b'.repeat(64),
          degraded: true,
          memoryBinding: derivedBinding,
        },
      ],
      records: [],
      fileDeliveries: [],
    });
    const { mod } = await armPipeline(runMock);
    const registry = new MediaResourceRegistry();
    const filePath = await realFile('pic.png');
    const config = {
      ...policyConfig(),
      getOmniMemoryConfig: () => ({ collection: { maxInlineTextBytes: 4096 } }),
      getOmniMediaResourceRegistry: () => registry,
    } as unknown as Config;

    const delivery = await mod.processMediaForOmniDelivery(filePath, config);

    // The derivative the model actually received is session-addressable,
    // resolving back to its harness-side locator and memory identity.
    const derived = registry.resolveVersion('v-derived');
    expect(derived).toMatchObject({
      ...derivedBinding,
      fileRef: degradedPath,
      mediaType: 'image',
    });
    expect(registry.resolve(derived!.resourceId)).toBe(derived);
    // The original source stays addressable too, under the version the
    // collection pass recorded for its content hash.
    const memory = new MediaMemoryService(tmpDir);
    const sourceBinding = await memory.findBindingBySha256('a'.repeat(64));
    expect(sourceBinding).toBeDefined();
    const source = registry.resolveVersion(sourceBinding!.fileVersionId);
    expect(source?.fileRef).toBe(filePath);
    expect(source?.mediaType).toBe('image');
    // The delivery discloses the SOURCE handle (M §5.2): the model's way
    // into recall is the source identity, not the derivative's.
    expect(delivery.resourceId).toBe(source!.resourceId);
  });
});
