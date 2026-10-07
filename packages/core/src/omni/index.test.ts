/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
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

let tmpDir: string;
const LEAF_MODULES = [
  './ffmpeg.js',
  './recognition.js',
  './storage.js',
  './upload.js',
];

/** Per-test temp omni root plus a module reset: the static imports above load
 * the real graph first, so per-test leaf doMocks only bind after a reset. */
function useFreshPipeline(prefix: string, ...extraMocked: string[]) {
  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    vi.resetAllMocks();
    for (const m of [...LEAF_MODULES, ...extraMocked]) vi.doUnmock(m);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}

/** The byte guard stats the real path, so inputs must exist on disk; their
 * bytes are irrelevant (recognition is stubbed). */
async function realFile(name: string): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, 'not really media');
  return filePath;
}

const MIME = { image: 'image/png', audio: 'audio/mpeg', video: 'video/mp4' };
function mockRecognized(
  modality: 'image' | 'audio' | 'video',
  metadata: Record<string, unknown>,
) {
  return {
    modality,
    detectedMimeType: MIME[modality],
    sizeBytes: 1234,
    metadata,
  };
}

const mockFfmpeg = (available: boolean) =>
  vi.doMock('./ffmpeg.js', () => ({
    isFfmpegAvailable: vi.fn().mockResolvedValue(available),
    isFfprobeAvailable: vi.fn().mockResolvedValue(available),
  }));

type Fn = (...args: never[]) => unknown;
const withObjectsDir = () => ({
  getObjectsDir: () => path.join(tmpDir, 'objects'),
});

/** Leaf mocks around the real pipeline, then a fresh index.js: ffmpeg up;
 * recognition -> `recognized`, `hash` (default 'a'×64), `ext`; a tmpDir store
 * with `putFile` + `store` methods (default getObjectsDir); an uploader with
 * `uploadFile`, its constructor options going to `onUploader`. */
async function armLeaves(o: {
  recognized: unknown;
  hash?: Fn;
  ext: string;
  putFile: Fn;
  uploadFile: Fn;
  store?: Record<string, Fn>;
  onUploader?: (options: unknown) => void;
}) {
  mockFfmpeg(true);
  vi.doMock('./recognition.js', () => ({
    recognizeMediaFile: vi.fn().mockResolvedValue(o.recognized),
    hashFileSha256: o.hash ?? vi.fn().mockResolvedValue('a'.repeat(64)),
    extensionForMime: vi.fn().mockReturnValue(o.ext),
  }));
  const store = o.store ?? withObjectsDir();
  vi.doMock('./storage.js', () => ({
    OmniObjectStore: class {
      putFile = o.putFile;
      constructor() {
        Object.assign(this, store);
      }
      getOmniRootDir() {
        return tmpDir;
      }
    },
  }));
  vi.doMock('./upload.js', () => ({
    DashScopeUploader: class {
      uploadFile = o.uploadFile;
      constructor(options: unknown) {
        o.onUploader?.(options);
      }
    },
    OSS_URL_PREFIX: 'oss://',
  }));
  return import('./index.js');
}

const MODALITY = { png: 'image', mp3: 'audio', mp4: 'video' } as const;

/** readMediaViaOmniDelivery of `filePath` displayed as `name`, expecting the
 * modality `name`'s extension implies. */
function readVia(
  mod: typeof import('./index.js'),
  filePath: string,
  config: Config,
  name = path.basename(filePath),
  extra?: { signal: AbortSignal },
) {
  const ext = path.extname(name).slice(1) as keyof typeof MODALITY;
  return mod.readMediaViaOmniDelivery({
    filePath,
    config,
    displayName: name,
    relativePathForDisplay: name,
    expectedModality: MODALITY[ext],
    ...extra,
  });
}

/** `config` with memory on and `registry` as the session resource registry. */
const withMemory = (config: Config, registry: unknown) =>
  ({
    ...config,
    getOmniMemoryConfig: () => ({ collection: { maxInlineTextBytes: 4096 } }),
    getOmniMediaResourceRegistry: () => registry,
  }) as unknown as Config;

const fileData = (fileUri: string, mimeType: string, displayName: string) => ({
  fileData: { fileUri, mimeType, displayName },
});

type Parts = Array<Record<string, unknown>>;

/** A registry from the current (post-reset) module graph. */
const freshRegistry = async () =>
  new (
    await import('../services/media-memory/index.js')
  ).MediaResourceRegistry();

describe('sanitizeErrorMessage', () => {
  it('scrubs known paths exactly, including segments with spaces', () => {
    // A space inside a segment defeats the pattern pass ('/Users/john doe/…'
    // would surface 'john doe'); exact known-path replacement is immune to it.
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

  it('scrubs a known path the filesystem re-spelled', () => {
    // Filesystems report the platform-resolved path (Windows: `/Users/a/…` ->
    // `C:\Users\a\…`) and the pattern pass stops at the first space or quote
    // in a segment, so verbatim replacement alone leaks the parent (#12082).
    for (const [known, parent, message] of [
      [
        "/Users/a/it's (v2)+final@x/clip.mp4",
        "it's (v2)+final@x",
        String.raw`ENOENT: no such file or directory, stat 'C:\Users\a\it's (v2)+final@x\clip.mp4'`,
      ],
      [
        '/Users/a/My Videos/clip.mp4',
        'My Videos',
        String.raw`ENOENT: no such file or directory, stat 'C:\Users\a\My Videos\clip.mp4'`,
      ],
      [
        'C:/Users/a/My Videos/clip.mp4',
        'My Videos',
        String.raw`ENOENT: no such file or directory, stat 'C:\Users\a\My Videos\clip.mp4'`,
      ],
    ] as const) {
      const out = sanitizeErrorMessage(new Error(message), [known]);
      expect(out).not.toContain(parent);
      expect(out).toContain('clip.mp4');
    }
  });

  it('collapses a sibling path that shares only the known path dirs', () => {
    // The known-path pass matches the whole path, never its dirs alone: those
    // would take the separator the pattern pass anchors on, and 'cache/' (which
    // the pattern pass removes if the known path is left in place) survives.
    const err = new Error(
      'ffmpeg: /home/user/media/cache/tmp.aac: No such file or directory',
    );
    const out = sanitizeErrorMessage(err, ['/home/user/media/clip.mp4']);
    expect(out).not.toContain('cache');
    expect(out).toContain('tmp.aac');
  });

  it('scrubs every occurrence of a re-spelled known path, drive included', () => {
    const err = new Error(
      String.raw`ffmpeg: C:\Users\a\My Videos\clip.mp4: Invalid data found when processing input (C:\Users\a\My Videos\clip.mp4)`,
    );
    expect(sanitizeErrorMessage(err, ['/Users/a/My Videos/clip.mp4'])).toBe(
      'ffmpeg: clip.mp4: Invalid data found when processing input (clip.mp4)',
    );
  });

  it('keeps a basename containing replacement patterns intact', () => {
    // Exact assertions catch replacement-string expansion of `$&` in both
    // the verbatim and re-spelling passes.
    const known = '/Users/a b/x$&y.mp4';
    for (const [message, expected] of [
      [
        String.raw`ENOENT: no such file or directory, stat '/Users/a b/x$&y.mp4'`,
        String.raw`ENOENT: no such file or directory, stat 'x$&y.mp4'`,
      ],
      [
        String.raw`ENOENT: no such file or directory, stat 'C:\Users\a b\x$&y.mp4'`,
        String.raw`ENOENT: no such file or directory, stat 'x$&y.mp4'`,
      ],
    ] as const) {
      expect(sanitizeErrorMessage(new Error(message), [known])).toBe(expected);
    }
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
  const active = (overrides: Parameters<typeof stubConfig>[0]) =>
    isOmniDeliveryActive(stubConfig(overrides));

  it('is active for a DashScope endpoint with a static API key in a trusted workspace', () => {
    expect(active({ trusted: true, cgc: DASHSCOPE_CGC })).toBe(true);
  });

  it('is inactive when omni is disabled', () => {
    expect(
      active({ omniEnabled: false, trusted: true, cgc: DASHSCOPE_CGC }),
    ).toBe(false);
  });

  it('is inactive in an untrusted workspace', () => {
    expect(active({ trusted: false, cgc: DASHSCOPE_CGC })).toBe(false);
  });

  it('treats unknown trust (undefined) as trusted', () => {
    expect(active({ trusted: undefined, cgc: DASHSCOPE_CGC })).toBe(true);
  });

  it('is inactive under Qwen OAuth even though a placeholder apiKey exists', () => {
    const cgc = {
      authType: AuthType.QWEN_OAUTH,
      apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    };
    expect(active({ trusted: true, cgc })).toBe(false);
  });

  it('is inactive when the apiKey is the OAuth placeholder regardless of authType', () => {
    const cgc = { ...DASHSCOPE_CGC, apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN' };
    expect(active({ trusted: true, cgc })).toBe(false);
  });

  it('is inactive without a baseUrl (never sends the key to a default origin)', () => {
    const cgc = { authType: AuthType.USE_OPENAI, apiKey: 'sk-openai-key' };
    expect(active({ trusted: true, cgc })).toBe(false);
  });

  it('is inactive for non-DashScope endpoints', () => {
    const cgc = {
      authType: AuthType.USE_OPENAI,
      apiKey: 'sk-openai-key',
      baseUrl: 'https://api.openai.com/v1',
    };
    expect(active({ trusted: true, cgc })).toBe(false);
  });

  it('is active for custom inference when a dedicated DashScope upload channel is configured', () => {
    const cgc = {
      authType: AuthType.USE_OPENAI,
      apiKey: 'inference-key',
      baseUrl: 'http://127.0.0.1:22002/v1',
    };
    const upload = {
      apiKey: 'upload-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.5-omni-plus',
    };
    expect(active({ trusted: true, cgc, upload })).toBe(true);
  });

  it('is inactive without a content generator config', () => {
    expect(active({ trusted: true, cgc: undefined })).toBe(false);
  });
});

describe('readMediaViaOmniDelivery result shape', () => {
  // Leaf deps mocked so the real pipeline runs end to end; otherwise the branch
  // under test (image -> resolution hint part, else bare fileData) never runs.
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

  useFreshPipeline('omni-index-');

  /** A 1920x1080 PNG stored at /tmp/obj.png (no getObjectsDir on the store)
   * and uploaded to oss://bucket/key. */
  const imageLeaves = () =>
    armLeaves({
      recognized: mockRecognized('image', { width: 1920, height: 1080 }),
      ext: '.png',
      putFile: async () => ({ objectPath: '/tmp/obj.png', deduped: false }),
      uploadFile: async () => 'oss://bucket/key',
      store: {},
    });

  /** A one-minute MP3 stored at /tmp/obj.mp3, uploaded by `uploadFile`. */
  const audioLeaves = (uploadFile: Fn) =>
    armLeaves({
      recognized: mockRecognized('audio', { durationMs: 60_000 }),
      ext: '.mp3',
      putFile: async () => ({ objectPath: '/tmp/obj.mp3', deduped: false }),
      uploadFile,
    });

  it('adds a resolution + zoom_image hint part for images', async () => {
    const mod = await imageLeaves();
    const filePath = await realFile('pic.png');
    const result = await readVia(mod, filePath, deliveryConfig());

    expect(Array.isArray(result.llmContent)).toBe(true);
    const parts = result.llmContent as Parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]!['text']).toContain('1920x1080');
    expect(parts[0]!['text']).toContain('zoom_image');
    expect(parts[1]).toEqual(
      fileData('oss://bucket/key', 'image/png', 'pic.png'),
    );
  });

  it('leads with the session resource handle when memory is on', async () => {
    const mod = await imageLeaves();
    const registry = await freshRegistry();

    const filePath = await realFile('pic.png');
    const config = withMemory(deliveryConfig(), registry);
    const result = await readVia(mod, filePath, config);

    const parts = result.llmContent as Parts;
    expect(parts).toHaveLength(3);
    // Resource part FIRST: the hint/disclosure chain stays adjacent to the
    // media (D8). A visible local source is its ABSOLUTE PATH, not an opaque
    // handle.
    const handleText = parts[0]!['text'] as string;
    expect(handleText).toContain('【媒体路径】');
    expect(handleText).toContain(filePath);
    expect(handleText).not.toContain('：media-');
    // The session handle is still registered and recoverable from the path.
    expect(registry.resolveByFileRef(filePath)).toMatchObject({
      mediaType: 'image',
    });
    // The part must be CONSUMABLE by both grammar readers: a writer change that
    // kept the substrings but broke the grammar (e.g. an unescaped separator)
    // would drop the annotation while substring checks stay green. Round-trip.
    const { parseResourcePathText, parseResourceHandleText } = await import(
      './disclosure.js'
    );
    const { extractRequestResourceIds } = await import(
      './memory-side-query.js'
    );
    expect(parseResourcePathText(handleText)).toBe(filePath);
    expect(parseResourceHandleText(handleText)).toBeUndefined();
    const registered = registry.resolveByFileRef(filePath)!;
    expect(
      extractRequestResourceIds(
        { getOmniMediaResourceRegistry: () => registry } as unknown as Config,
        [{ text: handleText }],
      ),
    ).toEqual([registered.resourceId]);
    expect(parts[1]!['text']).toContain('zoom_image');
    expect(parts[2]).toHaveProperty('fileData');
  });

  it.skipIf(process.platform === 'win32')(
    'falls back to the single-line handle form when the path has a newline (R3-3)',
    async () => {
      // A newline in a DIRECTORY component (basename clean): the path form
      // would be a MULTI-LINE 【媒体路径】 annotation that the passive selector's
      // line-based stripResourceAnnotationLines cannot remove, so its tail
      // would leak the local path. The writer's `!/[\r\n]/` guard falls back to
      // the single-line handle form. (Windows forbids newlines in paths, so the
      // guard and this witness are POSIX-only.)
      const mod = await imageLeaves();
      const registry = await freshRegistry();

      await fs.mkdir(path.join(tmpDir, 'dir\nsub'), { recursive: true });
      const filePath = await realFile(path.join('dir\nsub', 'pic.png'));

      const config = withMemory(deliveryConfig(), registry);
      const result = await readVia(mod, filePath, config);

      const leadText = (result.llmContent as Parts)[0]!['text'] as string;
      // Single-line HANDLE form, not the multi-line path form.
      expect(leadText).toContain('：media-');
      expect(leadText).not.toContain('【媒体路径】');
      expect(leadText).not.toMatch(/[\r\n]/);
      // The binding is still recoverable from the newline path.
      expect(registry.resolveByFileRef(filePath)).toMatchObject({
        mediaType: 'image',
      });
    },
  );

  it('keeps the handle form when the binding fileRef is not the read path', async () => {
    // Mirror of the path-form test: a path-less source (tool/URL media) binds
    // an internal object-store `fileRef` that is NOT the read path, so it keeps
    // the opaque handle (no model-visible path). The real pipeline never gives
    // a user read a divergent fileRef (sourceFileRef === filePath), so this
    // drives the fallback at the resolve() seam via a wrapper registry.
    const mod = await imageLeaves();
    const { parseResourceHandleText } = await import('./disclosure.js');
    const real = await freshRegistry();
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
    const config = withMemory(deliveryConfig(), registry);
    const result = await readVia(mod, filePath, config);

    const handleText = (result.llmContent as Parts)[0]!['text'] as string;
    // Handle form, NOT the path: the object-store fileRef is not the read
    // path, so the model gets the opaque handle it can still recall with.
    expect(handleText).toContain('：media-');
    expect(handleText).not.toContain(filePath);
    const resourceId = parseResourceHandleText(handleText);
    expect(resourceId).toBeDefined();
    expect(real.resolve(resourceId!)).toMatchObject({ mediaType: 'image' });
  });

  it('returns a bare fileData part for audio (no zoom hint)', async () => {
    const mod = await audioLeaves(async () => 'oss://bucket/audio');
    const filePath = await realFile('song.mp3');
    const result = await readVia(mod, filePath, deliveryConfig());

    expect(Array.isArray(result.llmContent)).toBe(false);
    expect(result.llmContent).toEqual(
      fileData('oss://bucket/audio', 'audio/mpeg', 'song.mp3'),
    );
    expect(result.returnDisplay).toContain('audio');
  });

  it('rejects with OmniTransportGuardError before storing or uploading when the token guard trips', async () => {
    // Every other pipeline test disables the guard (threshold 0); this one
    // pins the guard call itself: a positive threshold with an over-budget
    // estimate must reject BEFORE the hash/copy/upload stages run.
    const putFileMock = vi.fn();
    const uploadFileMock = vi.fn();
    const { processMediaForOmniDelivery, OmniTransportGuardError } =
      await armLeaves({
        // 852×480×(506s × 30fps) / 2048 ≈ 3M tokens — far above 100.
        recognized: mockRecognized('video', {
          width: 852,
          height: 480,
          durationMs: 506_000,
          frameRate: 30,
        }),
        ext: '.mp4',
        putFile: putFileMock,
        uploadFile: uploadFileMock,
      });

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
    const mod = await audioLeaves(async () => {
      controller.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const filePath = await realFile('song.mp3');
    const signal = controller.signal;
    await expect(
      readVia(mod, filePath, deliveryConfig(), 'song.mp3', { signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails closed with an error result (never inline base64) on failure', async () => {
    mockFfmpeg(false);
    const mod = await import('./index.js');

    const result = await readVia(mod, '/tmp/clip.mp4', deliveryConfig());

    expect(result.error).toMatch(/Omni media delivery failed/);
    expect(result.llmContent).toContain('ffmpeg/ffprobe not available');
  });

  /** Each path (none exist, so the stat fails and the fs error embeds the
   * path) reads as a failure naming neither field's parent fragment. */
  async function expectNoParentLeak(
    cases: ReadonlyArray<readonly [string, string]>,
  ) {
    mockFfmpeg(true);
    const mod = await import('./index.js');
    for (const [filePath, parentFragment] of cases) {
      const result = await readVia(mod, filePath, deliveryConfig(), 'clip.mp4');
      expect(result.error).toMatch(/Omni media delivery failed/);
      for (const field of [result.error, result.llmContent]) {
        expect(String(field)).not.toContain(parentFragment);
      }
    }
  }

  it('never leaks the absolute path through error or llmContent on failure', async () => {
    // Both fields reach the model (llmContent on success paths, `error` via the
    // scheduler's functionResponse on READ_CONTENT_FAILURE). Regex-hostile
    // shapes from review (CJK, a `~` basename, parens/apostrophe, a Windows
    // drive path): exact replacement of the known filePath must scrub all of
    // them. These are platform-native spellings; cross-spelling: the unit case
    // above, case below.
    const cases = [
      ['/Users/张三/视频/clip.mp4', '/Users/张三'],
      ['/Users/a/videos/~draft.mp4', '/Users/a/videos'],
      ["/Users/a/it's (v2)+final@x/clip.mp4", "it's (v2)+final@x"],
      ['C:\\Users\\björn\\clip.mp4', 'C:\\Users'],
    ] as const;
    await expectNoParentLeak(
      cases.map(([p, parent]) => [path.resolve(p), path.resolve(parent)]),
    );
  });

  // A path spelled differently from the way the filesystem reports it: the
  // error carries the resolved spelling, so the sanitizer matches the known
  // path with `/` and `\` interchangeable instead of only verbatim (#12082).
  it('never leaks the parent directory when the spelling differs from the fs report', async () => {
    await expectNoParentLeak([
      ["/Users/a/it's (v2)+final@x/clip.mp4", "it's (v2)+final@x"],
      // Separator-free so it detects a leaked parent under either spelling.
      ['/Users/a/My Videos/clip.mp4', 'My Videos'],
    ]);
  });
});

describe('processMediaForOmniDelivery upload cache integration', () => {
  // The REAL upload-cache.js and recovery.js run against a temp omni root;
  // only leaf deps are mocked. Pins the wiring: hit skips store+upload, miss
  // persists, ttl 0 disables, scope isolates credentials, recovery runs.
  useFreshPipeline('omni-cache-int-');

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

  /** Leaf mocks around shared spies, then a fresh song.mp3; the store roots
   * at tmpDir, so the real cache file lands at tmpDir/upload-cache.json. */
  async function armPipeline() {
    const putFileMock = vi
      .fn()
      .mockResolvedValue({ objectPath: '/tmp/obj.mp3', deduped: false });
    const uploadFileMock = vi.fn().mockResolvedValue('oss://bucket/cached');
    const uploaderOptionsMock = vi.fn();
    const mod = await armLeaves({
      recognized: mockRecognized('audio', { durationMs: 60_000 }),
      hash: vi.fn().mockResolvedValue('b'.repeat(64)),
      ext: '.mp3',
      putFile: putFileMock,
      uploadFile: uploadFileMock,
      onUploader: uploaderOptionsMock,
    });
    const filePath = await realFile('song.mp3');
    return { putFileMock, uploadFileMock, uploaderOptionsMock, mod, filePath };
  }

  const UPLOAD: OmniUploadConfig = {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'upload-key',
    model: 'dashscope-upload-model',
  };

  it('serves a repeat delivery from the cache: no second store copy or upload', async () => {
    const { putFileMock, uploadFileMock, mod, filePath } = await armPipeline();
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
    const { mod, filePath } = await armPipeline();
    await mod.processMediaForOmniDelivery(filePath, cacheConfig());
    const cacheFile = path.join(tmpDir, 'upload-cache.json');
    const raw = await fs.readFile(cacheFile, 'utf8');
    expect(raw).toContain('oss://bucket/cached');
    expect(raw).toContain('b'.repeat(64));
  });

  it('re-uploads every time when the cache TTL is configured to 0', async () => {
    const { uploadFileMock, mod, filePath } = await armPipeline();
    const config = cacheConfig({ ttlHours: 0 });

    const first = await mod.processMediaForOmniDelivery(filePath, config);
    const second = await mod.processMediaForOmniDelivery(filePath, config);
    expect(first.uploadCacheHit).toBe(false);
    expect(second.uploadCacheHit).toBe(false);
    expect(uploadFileMock).toHaveBeenCalledTimes(2);
  });

  it('never serves a URL cached under a different credential or endpoint', async () => {
    // An oss:// URL is minted for one (origin, apiKey) pair; switching accounts
    // must re-upload, not reuse a URL the new credential may not own.
    const { uploadFileMock, mod, filePath } = await armPipeline();

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
    const { uploadFileMock, uploaderOptionsMock, mod, filePath } =
      await armPipeline();
    await mod.processMediaForOmniDelivery(
      filePath,
      cacheConfig({
        cgc: {
          authType: AuthType.USE_OPENAI,
          apiKey: 'inference-key',
          baseUrl: 'http://127.0.0.1:22002/v1',
        },
        inferenceModel: 'qwen4-omni-120b-think',
        upload: UPLOAD,
      }),
    );

    expect(uploaderOptionsMock).toHaveBeenCalledWith({
      apiKey: UPLOAD.apiKey,
      baseUrl: UPLOAD.baseUrl,
    });
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: UPLOAD.model }),
    );
  });

  it('keeps a dedicated upload cache hit when only inference changes', async () => {
    const { uploadFileMock, mod, filePath } = await armPipeline();
    const viaInference = (id: 'a' | 'b') =>
      mod.processMediaForOmniDelivery(
        filePath,
        cacheConfig({
          cgc: {
            baseUrl: `http://inference-${id}/v1`,
            apiKey: `inference-${id}`,
          },
          inferenceModel: `custom-${id}`,
          upload: UPLOAD,
        }),
      );

    await viaInference('a');
    const second = await viaInference('b');

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

    const { mod, filePath } = await armPipeline();
    await mod.processMediaForOmniDelivery(filePath, cacheConfig());
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('processMediaForOmniDelivery fixed-policy integration', () => {
  // The orchestrator itself is unit-tested in policy/orchestrator.test.ts;
  // these tests pin the pipeline wiring around it: when it runs, what it
  // receives, how its output replaces the source, that the transport guard
  // judges the FINAL delivery (decision D1), and how failures surface.
  useFreshPipeline(
    'omni-policy-int-',
    './policy/orchestrator.js',
    './recovery.js',
  );

  const recognizedImage = (
    detectedMimeType: string,
    sizeBytes: number,
    width: number,
    height: number,
  ) => ({
    modality: 'image',
    detectedMimeType,
    sizeBytes,
    metadata: { width, height },
  });
  const SOURCE_RECOGNIZED = recognizedImage('image/png', 5000, 4000, 3000);
  const DEGRADED_RECOGNIZED = recognizedImage('image/jpeg', 100, 1568, 1176);
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

  type PolicyOverrides = {
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
  };

  function policyConfig(overrides?: PolicyOverrides): Config {
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
    vi.doMock('./policy/orchestrator.js', () => ({
      runFixedPolicies: runFixedPoliciesMock,
      OmniPolicyExecutionError: class extends Error {},
    }));
    const objectsDir = path.join(tmpDir, 'objects');
    const mod = await armLeaves({
      recognized: SOURCE_RECOGNIZED,
      hash: hashFileMock,
      ext: '.jpg',
      putFile: putFileMock,
      uploadFile: uploadFileMock,
      store: {
        getObjectsDir: () => objectsDir,
        objectPathFor: (sha256: string, extension: string) =>
          path.join(objectsDir, `${sha256}${extension}`),
      },
    });
    return { putFileMock, uploadFileMock, hashFileMock, mod };
  }

  /** Arms the pipeline around `runMock`, then processes a fresh pic.png
   * under policyConfig(overrides). */
  async function processPic(
    runMock: Mock,
    overrides?: PolicyOverrides,
    name = 'pic.png',
  ) {
    const arm = await armPipeline(runMock);
    const filePath = await realFile(name);
    const config = policyConfig(overrides);
    const result = await arm.mod.processMediaForOmniDelivery(filePath, config);
    return { ...arm, filePath, config, result };
  }

  /** The same through readMediaViaOmniDelivery (`name` picks the modality). */
  async function readPic(
    runMock: Mock,
    overrides?: PolicyOverrides,
    name = 'pic.png',
  ) {
    const { mod } = await armPipeline(runMock);
    return readVia(mod, await realFile(name), policyConfig(overrides));
  }

  /** A runFixedPolicies result: `deliveries`, no records, `fileDeliveries`. */
  const outcome = (deliveries: unknown[], fileDeliveries: unknown[] = []) => ({
    deliveries,
    records: [],
    fileDeliveries,
  });
  /** A runFixedPolicies mock resolving `outcome(...)` on every call. */
  const runReturning = (deliveries: unknown[], fileDeliveries?: unknown[]) =>
    vi.fn().mockResolvedValue(outcome(deliveries, fileDeliveries));
  /** A deliverable at objects/deadbeef.jpg recognized as DEGRADED_RECOGNIZED
   * under hash 'b'×64; `extra` adds keys or replaces them in place. */
  const derivative = (extra: Record<string, unknown> = {}) => ({
    filePath: path.join(tmpDir, 'objects', 'deadbeef.jpg'),
    recognized: DEGRADED_RECOGNIZED,
    sha256: 'b'.repeat(64),
    ...extra,
  });
  const DOWNSAMPLED = { disclosure: 'downsampled to 1568px', degraded: true };
  /** A derivative still over the 500-byte cap used below. */
  const OVER_CAP = {
    recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
    degraded: true,
  };

  /** The source resource the orchestrator receives, with user provenance. */
  const userSource = (filePath: string) => ({
    filePath,
    recognized: SOURCE_RECOGNIZED,
    displayName: 'pic.png',
    origin: 'user',
  });

  it('replaces the source with the policy derivative and carries its disclosure', async () => {
    const degradedPath = path.join(tmpDir, 'objects', 'deadbeef.jpg');
    const runMock = runReturning([derivative(DOWNSAMPLED)]);
    const { putFileMock, hashFileMock, filePath, config, result } =
      await processPic(runMock);

    // The orchestrator received the source resource with user provenance.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      config,
      userSource(filePath),
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
    const runMock = runReturning([]);
    await expect(processPic(runMock)).rejects.toThrow();
    // Window size and prompt count are unknown on the stub config: ONLY the
    // reserved-output limit; absent fields read `unavailable`, never zero.
    expect(runMock.mock.calls[0][2].conditionContext).toEqual({
      session: { reservedOutputTokens: 8192 },
    });
  });

  it('snapshots the full session namespace once and reuses it for the guard pass', async () => {
    const preprocessedPath = path.join(tmpDir, 'objects', 'pre.jpg');
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = vi
      .fn()
      .mockResolvedValueOnce(
        outcome([derivative({ filePath: preprocessedPath, ...OVER_CAP })]),
      )
      .mockResolvedValueOnce(
        outcome([
          derivative({
            filePath: guardedPath,
            sha256: 'c'.repeat(64),
            degraded: true,
          }),
        ]),
      );
    await processPic(runMock, {
      maxUploadFileBytes: 500,
      transportGuardPolicies: [{ id: 'img-guard', mediaTypes: ['image'] }],
      contextWindowSize: 131072,
      lastPromptTokenCount: 20000,
    });

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
    const { result } = await processPic(runMock, { policies: [] });
    expect(runMock).not.toHaveBeenCalled();
    expect(result.disclosure).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });

  it('judges the transport byte guard on the FINAL delivery, not the source', async () => {
    // Source 5000 bytes, cap 500: without policies this would be rejected; the
    // reordered pipeline (D1) must accept the 100-byte derivative.
    const runMock = runReturning([derivative(DOWNSAMPLED)]);
    const { result } = await processPic(runMock, { maxUploadFileBytes: 500 });
    expect(result.degraded).toBe(true);
  });

  it('explicitly omits an over-cap FINAL delivery when no guard policy matches its modality', async () => {
    // Stage B (policy design §10.2): with a processing config present, a
    // persisting violation is an explicit OMISSION, not a throw. The audio
    // guard policy does not match an image, so no guard pass runs.
    const runMock = runReturning([derivative(OVER_CAP)]);
    const { putFileMock, uploadFileMock, result } = await processPic(runMock, {
      maxUploadFileBytes: 500,
      transportGuardPolicies: [{ id: 'guard-audio', mediaTypes: ['audio'] }],
    });
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
    await expect(
      processPic(runMock, {
        maxUploadFileBytes: 500,
        noProcessingConfig: true,
      }),
    ).rejects.toMatchObject({ name: 'OmniTransportGuardError' });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('wraps orchestrator failures into a sanitized OmniDeliveryError', async () => {
    const runMock = vi.fn().mockRejectedValue(new Error('policy blew up'));
    await expect(processPic(runMock)).rejects.toMatchObject({
      name: 'OmniDeliveryError',
      message: 'Fixed-policy processing failed for pic.png: policy blew up',
    });
  });

  it('rejects a delivery set that is not exactly one resource', async () => {
    await expect(processPic(runReturning([]))).rejects.toMatchObject({
      name: 'OmniDeliveryError',
      message:
        'Fixed policies produced 0 media deliverables for pic.png; exactly one is supported.',
    });
  });

  // ── Multi-output fixed policies (#8187 多产物投递) ───────────────────
  const FRAME_2_RECOGNIZED = recognizedImage('image/jpeg', 120, 640, 360);
  const FRAME_3_RECOGNIZED = { ...FRAME_2_RECOGNIZED, sizeBytes: 130 };

  function keyframeDeliveries(tmp: string) {
    const frame = (n: number, recognized: unknown, hashChar: string) => ({
      filePath: path.join(tmp, 'objects', `frame${n}.jpg`),
      recognized,
      sha256: hashChar.repeat(64),
      disclosure: `帧 ${n}/3`,
      degraded: true,
    });
    return [
      frame(1, DEGRADED_RECOGNIZED, 'b'),
      frame(2, FRAME_2_RECOGNIZED, 'd'),
      frame(3, FRAME_3_RECOGNIZED, 'e'),
    ];
  }

  const uploadFrames = (uploadFileMock: Mock) =>
    uploadFileMock
      .mockResolvedValueOnce('oss://bucket/frame1')
      .mockResolvedValueOnce('oss://bucket/frame2')
      .mockResolvedValueOnce('oss://bucket/frame3');

  it('uploads every deliverable of a multi-output policy and carries the extras in additionalMedia', async () => {
    const runMock = runReturning(keyframeDeliveries(tmpDir));
    const { putFileMock, uploadFileMock, hashFileMock, mod } =
      await armPipeline(runMock);
    uploadFrames(uploadFileMock);

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
    const { putFileMock, uploadFileMock, result } = await processPic(
      runReturning(deliveries),
      { maxUploadFileBytes: 500 },
      'vid.mp4',
    );

    // The violating extra becomes an explicit omission (policy design §10.2, no
    // re-derivation of derivatives); its neighbors and the primary are
    // unaffected.
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
    const runMock = runReturning(keyframeDeliveries(tmpDir), [
      {
        filePath: '/tmp/objects/t.txt',
        role: 'transcript',
        mimeType: 'text/plain',
        text: '你好，世界',
        sha256: 'c'.repeat(64),
        sizeBytes: 15,
      },
    ]);
    const { uploadFileMock, mod } = await armPipeline(runMock);
    uploadFrames(uploadFileMock);

    const filePath = await realFile('vid.mp4');
    const result = await readVia(mod, filePath, policyConfig());

    const parts = result.llmContent as Parts;
    // [zoom hint, primary disclosure+fileData (M = media part), extra1
    //  disclosure+fileData, extra2 disclosure+fileData, transcript]: D8
    //  adjacency per pair, transcripts last.
    const kinds = parts.map((p) => ('fileData' in p ? 'M' : 'T')).join('');
    expect(kinds).toBe('TTMTMTMT');
    expect(parts[3]!['text']).toBe('【媒体降质】vid.mp4：帧 2/3');
    expect(parts[4]).toEqual(
      fileData('oss://bucket/frame2', 'image/jpeg', 'vid.mp4'),
    );
    expect(parts[5]!['text']).toBe('【媒体降质】vid.mp4：帧 3/3');
    expect(parts[6]).toEqual(
      fileData('oss://bucket/frame3', 'image/jpeg', 'vid.mp4'),
    );
    expect(parts[7]!['text']).toBe('【媒体转写】vid.mp4：你好，世界');
  });

  it('readMediaViaOmniDelivery still materializes extras when the PRIMARY is omitted', async () => {
    const deliveries = keyframeDeliveries(tmpDir).slice(0, 2);
    deliveries[0] = {
      ...deliveries[0],
      recognized: { ...DEGRADED_RECOGNIZED, sizeBytes: 900 },
    };
    const result = await readPic(
      runReturning(deliveries),
      { maxUploadFileBytes: 500 },
      'vid.mp4',
    );

    const parts = result.llmContent as Parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]!['text']).toContain('【媒体省略】vid.mp4');
    expect(parts[1]!['text']).toBe('【媒体降质】vid.mp4：帧 2/3');
    expect(parts[2]).toEqual(
      fileData('oss://bucket/degraded', 'image/jpeg', 'vid.mp4'),
    );
  });

  it('readMediaViaOmniDelivery places the disclosure immediately before the fileData part', async () => {
    const result = await readPic(runReturning([derivative(DOWNSAMPLED)]));
    const parts = result.llmContent as Parts;
    expect(parts).toHaveLength(3);
    // Zoom hint shows the DELIVERED (derivative) resolution and must not say
    // "full resolution": that contradicts the disclosure below and steers the
    // model away from zoom_image (the remedy that reads the original from
    // disk).
    expect(parts[0]!['text']).toContain('delivered at 1568x1176 px');
    expect(parts[0]!['text']).toContain('after degradation');
    expect(parts[0]!['text']).not.toContain('full resolution');
    expect(parts[1]!['text']).toBe(
      '【媒体降质】pic.png：downsampled to 1568px',
    );
    expect(parts[2]).toEqual(
      fileData('oss://bucket/degraded', 'image/jpeg', 'pic.png'),
    );
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
    const { putFileMock, uploadFileMock, result } = await processPic(
      runReturning([], [TRANSCRIPT_FILE_DELIVERY]),
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
    const { result } = await processPic(
      runReturning([derivative(DOWNSAMPLED)], [TRANSCRIPT_FILE_DELIVERY]),
    );
    expect(result.fileUri).toBe('oss://bucket/degraded');
    expect(result.transcripts).toEqual([
      { text: '你好，世界', disclosure: '原 63s 音频 → 转写文本 5 字' },
    ]);
  });

  it('readMediaViaOmniDelivery renders a pure-transcript delivery as text parts only', async () => {
    const result = await readPic(runReturning([], [TRANSCRIPT_FILE_DELIVERY]));
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
    const result = await readPic(
      runReturning([derivative(DOWNSAMPLED)], [TRANSCRIPT_FILE_DELIVERY]),
    );
    const parts = result.llmContent as Parts;
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
    const result = await readPic(
      runReturning([derivative(OVER_CAP)], [TRANSCRIPT_FILE_DELIVERY]),
      { maxUploadFileBytes: 500 },
    );
    const parts = result.llmContent as Parts;
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
  /** Guard stage only: no fixed policies, cap 500, IMG_GUARD. */
  const guardOnly = (extra?: PolicyOverrides) => ({
    policies: [],
    maxUploadFileBytes: 500,
    transportGuardPolicies: [IMG_GUARD],
    ...extra,
  });

  it('runs a matching guard policy on a violation and delivers the compliant result', async () => {
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = runReturning([
      derivative({ filePath: guardedPath, ...DOWNSAMPLED }),
    ]);
    const { filePath, config, result } = await processPic(runMock, guardOnly());

    // One guard pass over the SOURCE, restricted to the matching policies.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      config,
      userSource(filePath),
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
    // Preprocessing degrades once (disclosure A), still over the byte cap; the
    // guard degrades AGAIN (B). Both lossy steps must reach the model; a
    // replaced disclosure would silently hide the first degradation.
    const preprocessedPath = path.join(tmpDir, 'objects', 'pre.jpg');
    const guardedPath = path.join(tmpDir, 'objects', 'guarded.jpg');
    const runMock = vi
      .fn()
      .mockResolvedValueOnce(
        outcome([
          derivative({
            filePath: preprocessedPath,
            ...OVER_CAP,
            disclosure: 'downsampled to 1568px',
          }),
        ]),
      )
      .mockResolvedValueOnce(
        outcome([
          derivative({
            filePath: guardedPath,
            sha256: 'c'.repeat(64),
            disclosure: 're-encoded at quality 60',
            degraded: true,
          }),
        ]),
      );
    const { result } = await processPic(runMock, {
      maxUploadFileBytes: 500,
      transportGuardPolicies: [IMG_GUARD],
    });

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
      return outcome([
        derivative({
          // A NEW path every pass: progress is being made, so only the
          // pass counter can end the loop.
          filePath: path.join(tmpDir, 'objects', `pass-${call}.jpg`),
          ...OVER_CAP,
          sha256: String(call).repeat(64).slice(0, 64),
        }),
      ]);
    });
    const { result } = await processPic(
      runMock,
      guardOnly({ maxTransportPasses: 2 }),
    );
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(result.omission?.reason).toContain('900 bytes > 500 bytes');
    expect(result.fileUri).toBe('');
  });

  it('breaks out of the guard loop when a pass makes no progress', async () => {
    // Every guard policy no_op'd: the delivery IS the input resource. A
    // second pass would repeat identical work forever.
    const runMock = vi
      .fn()
      .mockImplementation(async (_config, resource) =>
        outcome([
          { filePath: resource.filePath, recognized: resource.recognized },
        ]),
      );
    const { result } = await processPic(runMock, guardOnly());
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(result.omission?.reason).toContain('5000 bytes > 500 bytes');
  });

  it('fails closed when a guard pass itself fails', async () => {
    // A guard configuration error must never degrade into sending over-limit
    // media (§10.2). OmniTransportGuardError tells inline-fallback consumers
    // (the tool-result funnel) to WITHHOLD the bytes; a generic delivery error
    // would fall back to delivering exactly what the guard rejected.
    const runMock = vi.fn().mockRejectedValue(new Error('guard blew up'));
    await expect(processPic(runMock, guardOnly())).rejects.toMatchObject({
      name: 'OmniTransportGuardError',
      message: 'Transport-guard processing failed for pic.png: guard blew up',
    });
  });

  it('re-filters guard policies by modality after a pass changes it', async () => {
    // Pass 1 turns the over-limit image into an over-limit AUDIO derivative;
    // pass 2 must run the AUDIO guard policy. A pre-loop (image-only) filter
    // would omit a resource the audio policy can still fix.
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
    const audioPass = (filePath: string, size: number, hashChar: string) =>
      outcome([
        {
          filePath,
          recognized: audioRecognized(size),
          sha256: hashChar.repeat(64),
          degraded: true,
        },
      ]);
    const runMock = vi
      .fn()
      .mockResolvedValueOnce(audioPass(bigAudioPath, 900, 'c'))
      .mockResolvedValueOnce(audioPass(smallAudioPath, 400, 'd'));
    const { result } = await processPic(runMock, {
      policies: [],
      maxUploadFileBytes: 500,
      transportGuardPolicies: [imageGuard, audioGuard],
      maxTransportPasses: 3,
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    // Pass 1 ran the image policy set; pass 2 must have run the AUDIO set.
    expect(runMock.mock.calls[0][2].policies).toEqual([imageGuard]);
    expect(runMock.mock.calls[1][2].policies).toEqual([audioGuard]);
    expect(result.omission).toBeUndefined();
    expect(result.fileUri).not.toBe('');
  });

  it('readMediaViaOmniDelivery renders an omission as the notice text, not an error', async () => {
    const result = await readPic(runReturning([derivative(OVER_CAP)]), {
      maxUploadFileBytes: 500,
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
    // The omission branch puts NO media part in front of the model; without a
    // leading reference the withheld resource has no nameable identity (no
    // recall, no reprocessing by a policy tool). A model-visible local source
    // is referenced by absolute path (recall resolves it via resolveByFileRef);
    // a path-less source would keep an opaque handle (M §5.2).
    const { mod } = await armPipeline(runReturning([derivative(OVER_CAP)]));
    const registry = await freshRegistry();

    const filePath = await realFile('pic.png');
    const config = withMemory(
      policyConfig({ maxUploadFileBytes: 500 }),
      registry,
    );
    const result = await readVia(mod, filePath, config);

    // With memory off this collapses to a bare notice string (test above); a
    // bound resource makes it a part array led by the absolute-path reference,
    // the notice standing in for the media behind it.
    const parts = result.llmContent as Parts;
    expect(parts).toHaveLength(2);
    const handleText = parts[0]!['text'] as string;
    expect(handleText).toContain('【媒体路径】');
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
    const { mod } = await armPipeline(runReturning([derivative()]));
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

  /** Delivers a staging file (memory on, no fixed policies) with `options`;
   * its binding must anchor to the content-addressed object, not the file. */
  async function expectAnchoredToStore(
    stagingName: string,
    options: Record<string, unknown>,
  ) {
    const { mod } = await armPipeline(runReturning([]));
    const registry = new MediaResourceRegistry();
    const stagingPath = await realFile(stagingName);
    const config = withMemory(policyConfig({ policies: [] }), registry);

    const delivery = await mod.processMediaForOmniDelivery(
      stagingPath,
      config,
      options,
    );

    const binding = registry.resolve(delivery.resourceId!);
    expect(binding).toBeDefined();
    expect(binding!.fileRef).toBe(
      path.join(tmpDir, 'objects', `${'a'.repeat(64)}.jpg`),
    );
    expect(binding!.fileRef).not.toBe(stagingPath);
    return { mod, config };
  }

  it('anchors tool-result media to the object store, not its staging file', async () => {
    // The tool-result funnel deletes its staging `.part` in `finally` the same
    // turn while this delivery promotes the bytes into the content-addressed
    // store. Binding the staging path handed the model a handle to a deleted
    // file (ENOENT for any policy tool) and made recall report
    // `artifact_unavailable` for an artifact that persists.
    const { mod, config } = await expectAnchoredToStore('tool-media.part', {
      origin: 'tool',
    });
    // A user file keeps its own path (its bytes stay in place, S §4).
    const userRegistry = new MediaResourceRegistry();
    const userDelivery = await mod.processMediaForOmniDelivery(
      await realFile('photo.png'),
      withMemory(config, userRegistry),
    );
    expect(userRegistry.resolve(userDelivery.resourceId!)!.fileRef).toContain(
      'photo.png',
    );
  });

  it('anchors URL media to the object store and records the URL as its source', async () => {
    // The URL funnel's staged download (opaque temp name) is deleted in
    // `finally` the same turn, like tool-result media, but was missed when C9
    // fixed that funnel: binding it gave a handle resolving to ENOENT for the
    // session and cross-session `artifact_unavailable` for bytes still stored.
    await expectAnchoredToStore('dl-3f9a.part', {
      displayName: 'clip.mp4',
      sourceUrl: 'https://example.com/media/clip.mp4',
    });
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
    const runMock = runReturning([
      derivative({
        filePath: degradedPath,
        degraded: true,
        memoryBinding: derivedBinding,
      }),
    ]);
    const { mod } = await armPipeline(runMock);
    const registry = new MediaResourceRegistry();
    const filePath = await realFile('pic.png');
    const config = withMemory(policyConfig(), registry);

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
