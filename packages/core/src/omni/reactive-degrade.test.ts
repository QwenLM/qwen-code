/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaMemoryService,
} from '../services/media-memory/index.js';
import { MEDIA_MEMORY_FILE_NAME } from '../services/media-memory/store.js';
import type { MediaMemorySnapshot } from '../services/media-memory/types.js';
import type { RecognizedMedia } from './recognition.js';
import { OmniObjectStore } from './storage.js';
import { OmniUploadCache } from './upload-cache.js';
import type {
  NormalizedFixedPolicy,
  NormalizedOmniProcessingLimits,
} from './policy/types.js';
import {
  applyOssMediaReplacements,
  buildLadderPolicy,
  collectOssMediaRefs,
  contentsHaveOssMedia,
  degradeOmniMediaAfterServerReject,
  getObservedServerInputLimit,
  recordObservedServerInputLimit,
  resetObservedServerInputLimitsForTests,
  type OssMediaReplacement,
} from './reactive-degrade.js';
import { OMNI_DISCLOSURE_TEXT_PREFIX } from './disclosure.js';

// The ladder re-runs the REAL policy orchestrator (that wiring is what the
// memory tests below are about), so only the two true externals are
// stubbed: the tool process and the uploads endpoint.
const executeToolCallMock = vi.hoisted(() => vi.fn());
vi.mock('../core/nonInteractiveToolExecutor.js', () => ({
  executeToolCall: executeToolCallMock,
}));

// Partial mock: recognizeMediaFile would need ffprobe; hashFileSha256 and
// extensionForMime stay real (the store re-hashes for real).
const recognizeMediaFileMock = vi.hoisted(() => vi.fn());
vi.mock('./recognition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recognition.js')>()),
  recognizeMediaFile: recognizeMediaFileMock,
}));

const uploadFileMock = vi.hoisted(() => vi.fn());
const uploaderOptionsMock = vi.hoisted(() => vi.fn());
vi.mock('./upload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./upload.js')>()),
  DashScopeUploader: class {
    constructor(options: unknown) {
      uploaderOptionsMock(options);
    }
    uploadFile = uploadFileMock;
  },
}));

afterEach(() => {
  resetObservedServerInputLimitsForTests();
});

function videoGuardPolicy(
  overrides?: Partial<NormalizedFixedPolicy>,
): NormalizedFixedPolicy {
  return {
    id: 'video-downscale',
    priority: 0,
    mediaTypes: ['video'],
    origins: ['user', 'tool', 'policy'],
    onConditionUnavailable: 'skip',
    toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
    arguments: {},
    maxRunsPerLineage: 1,
    onFailure: 'continue',
    output: {
      reprocessMedia: false,
      source: 'omit',
      artifacts: { '*': 'include' },
    },
    stage: 'transport_guard',
    ...overrides,
  };
}

function ossContents(): Content[] {
  return [
    {
      role: 'user',
      parts: [
        { text: 'analyze this' },
        {
          fileData: {
            fileUri: 'oss://bucket/clip',
            mimeType: 'video/mp4',
            displayName: 'movie.mkv',
          },
        },
        {
          fileData: {
            fileUri: 'oss://bucket/frame1',
            mimeType: 'image/jpeg',
            displayName: 'frame1.jpg',
          },
        },
      ],
    },
    {
      role: 'model',
      parts: [{ text: 'ok' }],
    },
  ];
}

/** A tool result carrying media (and a text sibling) on
 * `functionResponse.parts` — qwen-code's extension to the \@google/genai
 * schema (see `coreToolScheduler.createFunctionResponsePart`), which is
 * why the nested array is typed as `Part[]` and cast on assembly. */
function nestedToolResultPart(): Part {
  const nestedParts: Part[] = [
    { text: 'tool output' },
    {
      fileData: {
        fileUri: 'oss://bucket/nested',
        mimeType: 'video/mp4',
        displayName: 'nested.mp4',
      },
    },
  ];
  const functionResponse = {
    name: 'some_tool',
    response: {},
    parts: nestedParts,
  };
  return { functionResponse } as Part;
}

describe('collectOssMediaRefs', () => {
  it('collects distinct oss:// media parts with display names', () => {
    const refs = collectOssMediaRefs(ossContents());
    expect(refs).toEqual([
      {
        fileUri: 'oss://bucket/clip',
        mimeType: 'video/mp4',
        displayName: 'movie.mkv',
      },
      {
        fileUri: 'oss://bucket/frame1',
        mimeType: 'image/jpeg',
        displayName: 'frame1.jpg',
      },
    ]);
  });

  it('dedups repeated URIs and skips non-oss fileData', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: 'oss://bucket/a', mimeType: 'video/mp4' } },
          { fileData: { fileUri: 'oss://bucket/a', mimeType: 'video/mp4' } },
          {
            fileData: {
              fileUri: 'https://example.com/x.mp4',
              mimeType: 'video/mp4',
            },
          },
        ],
      },
    ];
    const refs = collectOssMediaRefs(contents);
    expect(refs).toHaveLength(1);
    expect(refs[0].fileUri).toBe('oss://bucket/a');
    // No displayName on the part: falls back to the URI basename.
    expect(refs[0].displayName).toBe('a');
  });

  it('contentsHaveOssMedia mirrors the collector', () => {
    expect(contentsHaveOssMedia(ossContents())).toBe(true);
    expect(
      contentsHaveOssMedia([{ role: 'user', parts: [{ text: 'hi' }] }]),
    ).toBe(false);
  });

  it('sees media nested in functionResponse.parts (tool-result deliveries)', () => {
    const contents: Content[] = [
      { role: 'user', parts: [nestedToolResultPart()] },
    ];
    expect(contentsHaveOssMedia(contents)).toBe(true);
    expect(collectOssMediaRefs(contents)).toEqual([
      {
        fileUri: 'oss://bucket/nested',
        mimeType: 'video/mp4',
        displayName: 'nested.mp4',
      },
    ]);
  });
});

describe('buildLadderPolicy', () => {
  it('merges the rung over the configured arguments for the default tool', () => {
    const policy = buildLadderPolicy(
      videoGuardPolicy({ arguments: { crf: 30 } }),
      'video',
      1,
    );
    expect(policy.arguments).toEqual({ crf: 30, maxHeight: 360, fps: 0.5 });
    expect(policy.id).toBe('video-downscale.reactive-1');
    expect(policy.when).toBeUndefined();
    expect(policy.output.source).toBe('omit');
    expect(policy.output.reprocessMedia).toBe(false);
  });

  it('escalates fps down the rungs and clamps past the last rung', () => {
    const fpsAt = (attempt: number) =>
      buildLadderPolicy(videoGuardPolicy(), 'video', attempt).arguments['fps'];
    expect(fpsAt(0)).toBe(2);
    expect(fpsAt(1)).toBe(0.5);
    expect(fpsAt(2)).toBe(0.25);
    expect(fpsAt(7)).toBe(0.25); // clamped: upstream no-progress check stops the loop
  });

  it('keeps a custom guard tool untouched (no foreign arguments injected)', () => {
    const custom = videoGuardPolicy({
      toolName: ToolNames.OMNI_EXTRACT_KEYFRAMES,
      arguments: { maxFrames: 4 },
    });
    const policy = buildLadderPolicy(custom, 'video', 1);
    expect(policy.arguments).toEqual({ maxFrames: 4 });
  });
});

describe('applyOssMediaReplacements', () => {
  it('swaps fileUri/mimeType in place and inserts the disclosure before the media', () => {
    const contents = ossContents();
    const replacements = new Map<string, OssMediaReplacement>([
      [
        'oss://bucket/clip',
        {
          fileUri: 'oss://bucket/clip-degraded',
          mimeType: 'video/mp4',
          disclosureText: `${OMNI_DISCLOSURE_TEXT_PREFIX}movie.mkv：降质重试`,
        },
      ],
    ]);
    const replaced = applyOssMediaReplacements(contents, replacements);
    expect(replaced).toBe(1);
    const parts = contents[0].parts!;
    // [text, disclosure, degraded clip, untouched frame]
    expect(parts).toHaveLength(4);
    expect(parts[1].text).toContain(OMNI_DISCLOSURE_TEXT_PREFIX);
    expect(parts[2].fileData?.fileUri).toBe('oss://bucket/clip-degraded');
    expect(parts[2].fileData?.displayName).toBe('movie.mkv'); // preserved
    expect(parts[3].fileData?.fileUri).toBe('oss://bucket/frame1'); // untouched
    // Model content untouched.
    expect(contents[1].parts).toEqual([{ text: 'ok' }]);
  });

  it('replaces every occurrence of the same URI across contents', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ fileData: { fileUri: 'oss://bucket/a', mimeType: 'v' } }],
      },
      {
        role: 'user',
        parts: [{ fileData: { fileUri: 'oss://bucket/a', mimeType: 'v' } }],
      },
    ];
    const replaced = applyOssMediaReplacements(
      contents,
      new Map([
        [
          'oss://bucket/a',
          {
            fileUri: 'oss://bucket/a2',
            mimeType: 'video/mp4',
            disclosureText: 'd',
          },
        ],
      ]),
    );
    expect(replaced).toBe(2);
    for (const content of contents) {
      expect(content.parts![1].fileData?.fileUri).toBe('oss://bucket/a2');
    }
  });

  it('is a no-op when nothing matches', () => {
    const contents = ossContents();
    const before = JSON.parse(JSON.stringify(contents));
    expect(applyOssMediaReplacements(contents, new Map())).toBe(0);
    expect(contents).toEqual(before);
  });

  it('swaps nested tool-result media inside the SAME functionResponse.parts array (D8)', () => {
    const contents: Content[] = [
      { role: 'user', parts: [nestedToolResultPart()] },
    ];
    const replaced = applyOssMediaReplacements(
      contents,
      new Map([
        [
          'oss://bucket/nested',
          {
            fileUri: 'oss://bucket/nested-degraded',
            mimeType: 'video/mp4',
            disclosureText: 'd',
          },
        ],
      ]),
    );
    expect(replaced).toBe(1);
    // Top level still holds exactly the functionResponse wrapper — the
    // swap must not hoist nested media out of the tool result.
    expect(contents[0].parts).toHaveLength(1);
    const nested = contents[0].parts![0].functionResponse?.parts as Part[];
    expect(nested).toHaveLength(3);
    expect(nested[0]).toEqual({ text: 'tool output' });
    expect(nested[1]).toEqual({ text: 'd' }); // disclosure directly before the media
    expect(nested[2].fileData?.fileUri).toBe('oss://bucket/nested-degraded');
    expect(nested[2].fileData?.displayName).toBe('nested.mp4'); // preserved
  });
});

describe('observed server input limits', () => {
  it('records the tightest observed limit per model', () => {
    recordObservedServerInputLimit('m', 262144);
    recordObservedServerInputLimit('m', 196608);
    recordObservedServerInputLimit('m', 250000); // looser: ignored
    expect(getObservedServerInputLimit('m')).toBe(196608);
    expect(getObservedServerInputLimit('other')).toBeUndefined();
  });

  it('ignores invalid limits', () => {
    recordObservedServerInputLimit('m', 0);
    recordObservedServerInputLimit('m', Number.NaN);
    expect(getObservedServerInputLimit('m')).toBeUndefined();
  });
});

describe('degradeOmniMediaAfterServerReject memory wiring (S5)', () => {
  const INFERENCE_MODEL = 'qwen4-omni-120b-think';
  const UPLOAD_MODEL = 'qwen3-omni-plus';
  const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const API_KEY = 'test-key';
  const SOURCE_BYTES = 'original-video-bytes';
  const DEGRADED_BYTES = 'reactively-degraded-video-bytes';
  const OSS_URL = 'oss://bucket/clip';

  const SOURCE_RECOGNIZED: RecognizedMedia = {
    modality: 'video',
    detectedMimeType: 'video/mp4',
    sizeBytes: SOURCE_BYTES.length,
    metadata: { durationMs: 60_000, width: 1920, height: 1080 },
  };
  const DEGRADED_RECOGNIZED: RecognizedMedia = {
    modality: 'video',
    detectedMimeType: 'video/mp4',
    sizeBytes: DEGRADED_BYTES.length,
    metadata: { durationMs: 60_000, width: 640, height: 360 },
  };
  const VIDEO_DESCRIPTOR: MediaPolicyToolDescriptor = {
    kind: 'media_policy',
    inputMediaTypes: ['video'],
    outputs: [
      { kind: 'media', mimeTypes: ['video/mp4'], required: true, lossy: true },
    ],
  };
  const LIMITS: NormalizedOmniProcessingLimits = {
    maxConcurrentResources: 1,
    reservedOutputTokens: 8192,
    maxLineageDepth: 8,
    maxPolicyRunsPerRoot: 64,
    maxArtifactsPerRoot: 256,
    maxDerivedBytesPerRoot: 1073741824,
    maxTransportPasses: 3,
  };

  let tmpDir: string;
  let store: OmniObjectStore;
  let sourceSha256: string;
  let objectPath: string;

  function sha256Of(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  function degradeConfig(): Config {
    return {
      isOmniEnabled: () => true,
      isTrustedFolder: () => true,
      getContentGeneratorConfig: () => ({
        apiKey: 'inference-key',
        baseUrl: 'http://127.0.0.1:22002/v1',
      }),
      getModel: () => INFERENCE_MODEL,
      getOmniUploadConfig: () => ({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        model: UPLOAD_MODEL,
      }),
      storage: { getQwenDir: () => path.join(tmpDir, '.qwen') },
      getOmniProcessingConfig: () => ({
        transportGuardPolicies: [videoGuardPolicy()],
        limits: LIMITS,
      }),
      getOmniMemoryConfig: () => DEFAULT_OMNI_MEMORY_CONFIG,
      getToolRegistry: () => ({
        getTool: (name: string) =>
          name === ToolNames.OMNI_DOWNSCALE_VIDEO
            ? { mediaPolicyDescriptor: VIDEO_DESCRIPTOR }
            : undefined,
      }),
      getOmniPolicyToolsSettings: () => undefined,
    } as unknown as Config;
  }

  function rejectedContents(): Content[] {
    return [
      {
        role: 'user',
        parts: [
          { text: 'summarize this' },
          {
            fileData: {
              fileUri: OSS_URL,
              mimeType: 'video/mp4',
              displayName: 'movie.mkv',
            },
          },
        ],
      },
    ];
  }

  async function readSnapshot(): Promise<MediaMemorySnapshot> {
    return JSON.parse(
      await fs.readFile(
        path.join(store.getOmniRootDir(), MEDIA_MEMORY_FILE_NAME),
        'utf8',
      ),
    ) as MediaMemorySnapshot;
  }

  /** Record a video file into memory the way the delivery pipeline does,
   * returning the binding the ladder is supposed to rediscover by hash. */
  async function recordInMemory(fileRef: string, sha256: string) {
    const service = new MediaMemoryService(store.getOmniRootDir());
    const binding = await service.recordFileRecognized({
      fileRef,
      sha256,
      mediaType: 'video',
      metadata: SOURCE_RECOGNIZED.metadata,
      sizeBytes: SOURCE_RECOGNIZED.sizeBytes,
      mimeType: 'video/mp4',
      origin: 'user',
      source: { protocol: 'local', locator: 'movie.mkv' },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });
    return binding!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-reactive-'));
    store = new OmniObjectStore(path.join(tmpDir, '.qwen'));
    // The object the rejected oss:// URL maps back to, reachable through
    // the upload cache's reverse lookup exactly as in production.
    const stagedSource = path.join(tmpDir, 'movie.mkv');
    await fs.writeFile(stagedSource, SOURCE_BYTES);
    sourceSha256 = sha256Of(SOURCE_BYTES);
    objectPath = (await store.putFile(stagedSource, sourceSha256, '.mp4'))
      .objectPath;
    const scope = createHash('sha256')
      .update(`${BASE_URL}|${API_KEY}`)
      .digest('hex')
      .slice(0, 16);
    await new OmniUploadCache(store.getOmniRootDir(), undefined, scope).put(
      sourceSha256,
      UPLOAD_MODEL,
      OSS_URL,
    );

    recognizeMediaFileMock.mockImplementation(async (filePath: string) =>
      filePath === objectPath ? SOURCE_RECOGNIZED : DEGRADED_RECOGNIZED,
    );
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => {
        const outputDir = request.args['outputDir'] as string;
        await fs.writeFile(path.join(outputDir, 'out.mp4'), DEGRADED_BYTES);
        return {
          callId: request.callId,
          responseParts: [],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          policyArtifacts: {
            toolName: request.name,
            invocationId: request.callId,
            executionOrigin: request.executionOrigin,
            artifacts: [
              {
                kind: 'video',
                storage: 'workspace',
                title: 'out.mp4',
                workspacePath: 'out.mp4',
                mimeType: 'video/mp4',
                metadata: { omniDisclosure: 'Downscaled to 360p/0.5fps.' },
              },
            ],
          },
        };
      },
    );
    uploadFileMock.mockResolvedValue('oss://bucket/clip-rung-1');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('commits the re-derivation onto the binding found by content hash', async () => {
    // The ladder only ever holds an oss:// URL and the bytes behind it —
    // never a memory identity. Losing the sha256 → binding lookup does not
    // break the retry, so nothing goes red: the request is degraded, sent,
    // and accepted, while the derivative silently becomes a rootless
    // orphan. Recall would then report the user's video as never having
    // been degraded, and the next rung would re-transcode from scratch.
    const rootBinding = await recordInMemory(objectPath, sourceSha256);
    const contents = rejectedContents();

    const outcome = await degradeOmniMediaAfterServerReject(
      degradeConfig(),
      contents,
      1,
    );
    expect(outcome).toEqual({ replacedParts: 1, degradedResources: 1 });

    const snapshot = await readSnapshot();
    const executions = Object.values(snapshot.executions);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      sourceVersionId: rootBinding.fileVersionId,
      rootFileId: rootBinding.rootFileId,
      toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
      // The rung's escalated arguments are what actually ran, so they are
      // what the record must carry — rung 1 of the video ladder.
      finalArguments: { maxHeight: 360, fps: 0.5 },
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: 'video-downscale.reactive-1',
        stage: 'transport_guard',
      },
    });

    const derivedVersion = Object.values(snapshot.versions).find(
      (version) => version.sha256 === sha256Of(DEGRADED_BYTES),
    );
    expect(derivedVersion).toBeDefined();
    expect(derivedVersion!.parentVersionId).toBe(rootBinding.fileVersionId);
    expect(snapshot.files[derivedVersion!.fileId].rootFileId).toBe(
      rootBinding.rootFileId,
    );
  });

  it('degrades normally when memory has never seen the bytes', async () => {
    // Memory is best-effort here: a session that degraded media before
    // memory was switched on (or after the store was wiped) still has to
    // retry. And the commit must not fall back to SOME other binding —
    // attaching this derivative to an unrelated lineage would be a
    // fabricated provenance claim, which is worse than no record.
    await recordInMemory(path.join(tmpDir, 'other.mkv'), sha256Of('unrelated'));
    const contents = rejectedContents();

    const outcome = await degradeOmniMediaAfterServerReject(
      degradeConfig(),
      contents,
      1,
    );
    expect(outcome).toEqual({ replacedParts: 1, degradedResources: 1 });
    expect(contents[0].parts![2].fileData?.fileUri).toBe(
      'oss://bucket/clip-rung-1',
    );

    const snapshot = await readSnapshot();
    expect(Object.values(snapshot.executions)).toEqual([]);
    expect(
      Object.values(snapshot.versions).map((version) => version.sha256),
    ).toEqual([sha256Of('unrelated')]);
  });

  it('uses the dedicated upload channel for the reactive replacement', async () => {
    await degradeOmniMediaAfterServerReject(
      degradeConfig(),
      rejectedContents(),
      1,
    );

    expect(uploaderOptionsMock).toHaveBeenCalledWith({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: UPLOAD_MODEL,
    });
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: UPLOAD_MODEL }),
    );
  });
});
