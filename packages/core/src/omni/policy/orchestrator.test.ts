/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { ToolCallRequestInfo } from '../../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type { MediaMemoryService } from '../../services/media-memory/index.js';
import { MEDIA_MEMORY_FILE_NAME } from '../../services/media-memory/store.js';
import type { MediaMemorySnapshot } from '../../services/media-memory/types.js';
import type { RecognizedMedia } from '../recognition.js';
import { OmniObjectStore } from '../storage.js';
import {
  computePolicyFingerprint,
  OmniDegradationCache,
} from './degradation-cache.js';
import {
  MAX_FILE_ARTIFACT_BYTES,
  OmniPolicyExecutionError,
  runFixedPolicies,
  type PolicySourceResource,
} from './orchestrator.js';
import type {
  FixedPolicyCondition,
  NormalizedFixedPolicy,
  NormalizedOmniProcessingLimits,
} from './types.js';

// The orchestrator resolves the executor with a dynamic import; vitest
// intercepts it the same as a static one.
const executeToolCallMock = vi.hoisted(() => vi.fn());
vi.mock('../../core/nonInteractiveToolExecutor.js', () => ({
  executeToolCall: executeToolCallMock,
}));

// Partial mock: recognizeMediaFile would need ffprobe; everything else
// (hashFileSha256 in particular — putFile re-hashes for real) stays real.
const recognizeMediaFileMock = vi.hoisted(() => vi.fn());
vi.mock('../recognition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recognition.js')>()),
  recognizeMediaFile: recognizeMediaFileMock,
}));

const SOURCE_BYTES = 'original-image-bytes';
const DEGRADED_BYTES = 'degraded-image-bytes';

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function recognizedImage(
  overrides: Partial<RecognizedMedia> = {},
): RecognizedMedia {
  return {
    modality: 'image',
    detectedMimeType: 'image/png',
    sizeBytes: SOURCE_BYTES.length,
    metadata: { width: 4000, height: 3000 },
    ...overrides,
  };
}

const DEGRADED_RECOGNIZED: RecognizedMedia = {
  modality: 'image',
  detectedMimeType: 'image/jpeg',
  sizeBytes: DEGRADED_BYTES.length,
  metadata: { width: 1568, height: 1176 },
};

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['image'],
  outputs: [
    { kind: 'media', mimeTypes: ['image/jpeg'], required: true, lossy: true },
    { kind: 'text', role: 'disclosure', required: true },
  ],
};

function makePolicy(
  overrides: Partial<NormalizedFixedPolicy> = {},
): NormalizedFixedPolicy {
  return {
    id: 'img-downsample',
    priority: 0,
    mediaTypes: ['image'],
    origins: ['user', 'tool'],
    onConditionUnavailable: 'skip',
    toolName: 'omni_downsample_image',
    arguments: { maxDimension: 1568 },
    maxRunsPerLineage: 1,
    onFailure: 'continue',
    output: {
      reprocessMedia: false,
      source: 'omit',
      artifacts: { '*': 'include' },
    },
    stage: 'preprocessing',
    ...overrides,
  };
}

function makeConfig(
  descriptorByTool: Record<string, MediaPolicyToolDescriptor>,
  policyToolsSettings?: unknown,
) {
  return {
    getToolRegistry: () => ({
      getTool: (name: string) =>
        descriptorByTool[name]
          ? { mediaPolicyDescriptor: descriptorByTool[name] }
          : undefined,
    }),
    getOmniPolicyToolsSettings: () => policyToolsSettings,
  } as unknown as Config;
}

/** System defaults (P §12.2) with per-test overrides. */
function limitsWith(
  overrides: Partial<NormalizedOmniProcessingLimits>,
): NormalizedOmniProcessingLimits {
  return {
    maxConcurrentResources: 1,
    reservedOutputTokens: 8192,
    maxLineageDepth: 8,
    maxPolicyRunsPerRoot: 64,
    maxArtifactsPerRoot: 256,
    maxDerivedBytesPerRoot: 1073741824,
    maxTransportPasses: 3,
    ...overrides,
  };
}

describe('runFixedPolicies', () => {
  let tmpDir: string;
  let store: OmniObjectStore;
  let sourcePath: string;
  let source: PolicySourceResource;
  let config: Config;

  /** Default success behavior: write a degraded artifact into the staging
   * dir and return it as a workspace policy artifact with a disclosure. */
  function mockToolSuccess(
    options: {
      bytes?: string;
      disclosure?: string | undefined;
      fileName?: string;
    } = {},
  ): void {
    const bytes = options.bytes ?? DEGRADED_BYTES;
    const fileName = options.fileName ?? 'out.jpg';
    const disclosure =
      'disclosure' in options
        ? options.disclosure
        : 'Downsampled from 4000x3000 to 1568x1176.';
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => {
        const outputDir = request.args['outputDir'] as string;
        await fs.writeFile(path.join(outputDir, fileName), bytes);
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
                kind: 'image',
                storage: 'workspace',
                title: fileName,
                workspacePath: fileName,
                mimeType: 'image/jpeg',
                ...(disclosure !== undefined
                  ? { metadata: { omniDisclosure: disclosure } }
                  : {}),
              },
            ],
          },
        };
      },
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-orchestrator-'));
    store = new OmniObjectStore(path.join(tmpDir, '.qwen'));
    sourcePath = path.join(tmpDir, 'photo.png');
    await fs.writeFile(sourcePath, SOURCE_BYTES);
    source = {
      filePath: sourcePath,
      recognized: recognizedImage(),
      displayName: 'photo.png',
      origin: 'user',
    };
    config = makeConfig({ omni_downsample_image: DESCRIPTOR });
    recognizeMediaFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.jpg')) return DEGRADED_RECOGNIZED;
      return recognizedImage();
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers the source untouched when no policy matches its modality', async () => {
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy({ mediaTypes: ['video'] })],
    });
    expect(deliveries).toEqual([
      {
        filePath: sourcePath,
        recognized: recognizedImage(),
        sha256: undefined,
        disclosure: undefined,
        degraded: undefined,
      },
    ]);
    expect(records).toEqual([]);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('skips policies whose origins exclude the resource provenance', async () => {
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy({ origins: ['tool'] })],
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].filePath).toBe(sourcePath);
    expect(records).toEqual([]);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('executes a matching policy via the executor protocol and promotes the artifact', async () => {
    mockToolSuccess();
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });

    // Exact executor protocol (the "complete minimal protocol" contract).
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    const [calledConfig, request, signal, opts] =
      executeToolCallMock.mock.calls[0];
    expect(calledConfig).toBe(config);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(opts).toEqual({ recordToolResult: false });
    const req = request as ToolCallRequestInfo;
    expect(req.name).toBe('omni_downsample_image');
    expect(req.isClientInitiated).toBe(true);
    expect(req.callId).toMatch(/^[0-9a-f]{16}$/);
    expect(req.prompt_id).toBe(`omni-fixed-policy-${req.callId}`);
    expect(req.executionOrigin).toEqual({
      kind: 'fixed_policy',
      policyId: 'img-downsample',
      stage: 'preprocessing',
    });
    const stagingDir = path.join(store.getStagingDir(), req.callId);
    expect(req.args).toEqual({
      maxDimension: 1568,
      inputPath: sourcePath,
      outputDir: stagingDir,
    });

    // Derivative promoted into objects/, source omitted.
    const degradedSha = sha256Of(DEGRADED_BYTES);
    const objectPath = store.objectPathFor(degradedSha, '.jpg');
    expect(deliveries).toEqual([
      {
        filePath: objectPath,
        recognized: DEGRADED_RECOGNIZED,
        sha256: degradedSha,
        disclosure: 'Downsampled from 4000x3000 to 1568x1176.',
        degraded: true,
      },
    ]);
    await expect(fs.readFile(objectPath, 'utf8')).resolves.toBe(DEGRADED_BYTES);

    // Staging cleaned up; degradation cache written.
    await expect(fs.readdir(store.getStagingDir())).resolves.toEqual([]);
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    const entry = await cache.get(
      sha256Of(SOURCE_BYTES),
      computePolicyFingerprint('omni_downsample_image', { maxDimension: 1568 }),
    );
    expect(entry).toMatchObject({
      degradedSha256: degradedSha,
      extension: '.jpg',
      disclosure: 'Downsampled from 4000x3000 to 1568x1176.',
      mimeType: 'image/jpeg',
    });

    expect(records).toEqual([
      {
        policyId: 'img-downsample',
        toolName: 'omni_downsample_image',
        outcome: 'succeeded',
        resource: 'photo.png',
      },
    ]);
  });

  it('keeps the source alongside the derivative when output.source is keep', async () => {
    mockToolSuccess();
    const { deliveries } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
      ],
    });
    expect(deliveries.map((d) => d.filePath)).toEqual([
      sourcePath,
      store.objectPathFor(sha256Of(DEGRADED_BYTES), '.jpg'),
    ]);
  });

  it('reuses a degradation-cache hit without invoking the tool', async () => {
    const degradedSha = sha256Of(DEGRADED_BYTES);
    const objectPath = store.objectPathFor(degradedSha, '.jpg');
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, DEGRADED_BYTES);
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    await cache.put(
      sha256Of(SOURCE_BYTES),
      computePolicyFingerprint('omni_downsample_image', { maxDimension: 1568 }),
      {
        degradedSha256: degradedSha,
        extension: '.jpg',
        disclosure: 'cached disclosure',
        mimeType: 'image/jpeg',
      },
    );

    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(deliveries).toEqual([
      {
        filePath: objectPath,
        recognized: DEGRADED_RECOGNIZED,
        sha256: degradedSha,
        disclosure: 'cached disclosure',
        degraded: true,
      },
    ]);
    expect(records[0]).toMatchObject({ outcome: 'cache_hit' });
  });

  it('drops a stale cache entry (object missing) and re-executes', async () => {
    const staleSha = sha256Of('stale-derivative');
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    const fingerprint = computePolicyFingerprint('omni_downsample_image', {
      maxDimension: 1568,
    });
    await cache.put(sha256Of(SOURCE_BYTES), fingerprint, {
      degradedSha256: staleSha,
      extension: '.jpg',
      disclosure: 'stale disclosure',
      mimeType: 'image/jpeg',
    });
    mockToolSuccess();

    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'succeeded' });
    expect(deliveries[0].sha256).toBe(sha256Of(DEGRADED_BYTES));
    // The stale entry was replaced by the fresh derivative's identity.
    const entry = await cache.get(sha256Of(SOURCE_BYTES), fingerprint);
    expect(entry?.degradedSha256).toBe(sha256Of(DEGRADED_BYTES));
  });

  it('drops an unverifiable cache entry (probe throws) and re-executes instead of failing', async () => {
    const plantedBytes = 'previously-degraded-bytes';
    const plantedSha = sha256Of(plantedBytes);
    const plantedPath = store.objectPathFor(plantedSha, '.jpg');
    await fs.mkdir(path.dirname(plantedPath), { recursive: true });
    await fs.writeFile(plantedPath, plantedBytes);
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    const fingerprint = computePolicyFingerprint('omni_downsample_image', {
      maxDimension: 1568,
    });
    await cache.put(sha256Of(SOURCE_BYTES), fingerprint, {
      degradedSha256: plantedSha,
      extension: '.jpg',
      disclosure: 'cached disclosure',
      mimeType: 'image/jpeg',
    });
    // The cached derivative's bytes hash correctly but its probe fails
    // (corrupted container, ffprobe I/O race). Verification must drop the
    // entry and fall through to a fresh transcode — not abort the run.
    recognizeMediaFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === plantedPath) throw new Error('probe failed');
      if (filePath.endsWith('.jpg')) return DEGRADED_RECOGNIZED;
      return recognizedImage();
    });
    mockToolSuccess();

    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'succeeded' }),
    ]);
    expect(deliveries[0].sha256).toBe(sha256Of(DEGRADED_BYTES));
    // Self-heal: the unverifiable entry was dropped and re-written with
    // the fresh derivative's identity.
    const entry = await cache.get(sha256Of(SOURCE_BYTES), fingerprint);
    expect(entry?.degradedSha256).toBe(sha256Of(DEGRADED_BYTES));
  });

  it('keys the degradation cache with the descriptor version (D2)', async () => {
    config = makeConfig({
      omni_downsample_image: { ...DESCRIPTOR, version: '7' },
    });
    mockToolSuccess();
    await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    // The entry lives under the versioned fingerprint only: bumping the
    // tool version must invalidate derivatives produced by older code.
    await expect(
      cache.get(
        sha256Of(SOURCE_BYTES),
        computePolicyFingerprint(
          'omni_downsample_image',
          { maxDimension: 1568 },
          '7',
        ),
      ),
    ).resolves.toMatchObject({ degradedSha256: sha256Of(DEGRADED_BYTES) });
    await expect(
      cache.get(
        sha256Of(SOURCE_BYTES),
        computePolicyFingerprint('omni_downsample_image', {
          maxDimension: 1568,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('excludes animated images (frameCount > 1) from policy matching (D9)', async () => {
    source = {
      ...source,
      recognized: recognizedImage({
        metadata: { width: 4000, height: 3000, frameCount: 12 },
      }),
    };
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].filePath).toBe(sourcePath);
    expect(deliveries[0].degraded).toBeUndefined();
  });

  it('still matches a single-frame image with an explicit frameCount of 1', async () => {
    source = {
      ...source,
      recognized: recognizedImage({
        metadata: { width: 4000, height: 3000, frameCount: 1 },
      }),
    };
    mockToolSuccess();
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('treats a hash-identical output as a no-op: source delivered, nothing cached', async () => {
    mockToolSuccess({ bytes: SOURCE_BYTES });
    // Identical bytes hash identically even though the mock labels the
    // artifact image/jpeg — the fixed-point check runs on content hashes.
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()], // source: 'omit' must NOT apply on no-op
    });
    expect(records[0]).toMatchObject({ outcome: 'no_op' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].filePath).toBe(sourcePath);
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    await expect(
      cache.get(
        sha256Of(SOURCE_BYTES),
        computePolicyFingerprint('omni_downsample_image', {
          maxDimension: 1568,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('silently skips a policy whose `when` does not match', async () => {
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          when: ['>', ['field', 'resource.width'], 5000],
        }),
      ],
    });
    expect(records).toEqual([]);
    expect(deliveries[0].filePath).toBe(sourcePath);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('records condition_unavailable with the missing fields when skipping', async () => {
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          when: ['>', ['field', 'resource.durationMs'], 1000],
        }),
      ],
    });
    expect(records).toEqual([
      {
        policyId: 'img-downsample',
        toolName: 'omni_downsample_image',
        outcome: 'condition_unavailable',
        resource: 'photo.png',
        missingFields: ['resource.durationMs'],
      },
    ]);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('runs anyway on an undecidable condition when onConditionUnavailable is run', async () => {
    mockToolSuccess();
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          onConditionUnavailable: 'run',
          when: ['>', ['field', 'resource.durationMs'], 1000],
        }),
      ],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'succeeded' });
  });

  describe('condition namespaces (request./session., policy design §8.3)', () => {
    // The 4000×3000 root estimates to ceil(4000*3000/2048) = 5860 tokens;
    // the 1568×1176 derivative to ceil(1568*1176/2048) = 901.
    const requestWhen = (
      operator: '>' | '==',
      value: number,
    ): FixedPolicyCondition => [
      operator,
      ['field', 'request.totalEstimatedMediaTokens'],
      value,
    ];

    it('computes request.totalEstimatedMediaTokens from the pending delivery set', async () => {
      mockToolSuccess();
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ when: requestWhen('>', 5859) })],
      });
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });
    });

    it('does not match when the pending total is not above the threshold', async () => {
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ when: requestWhen('>', 5860) })],
      });
      expect(records).toEqual([]);
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it('prefers a caller-supplied request namespace over the internal sum', async () => {
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ when: requestWhen('>', 5859) })],
        conditionContext: { request: { totalEstimatedMediaTokens: 1 } },
      });
      expect(records).toEqual([]);
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it('reads unavailable (never a partial sum) when a pending resource is unestimable', async () => {
      source = { ...source, recognized: recognizedImage({ metadata: {} }) };
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ when: requestWhen('>', 0) })],
      });
      expect(records).toEqual([
        {
          policyId: 'img-downsample',
          toolName: 'omni_downsample_image',
          outcome: 'condition_unavailable',
          resource: 'photo.png',
          missingFields: ['request.totalEstimatedMediaTokens'],
        },
      ]);
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it('recomputes the request namespace as derivatives enter the next pass', async () => {
      mockToolSuccess();
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [
          makePolicy({
            id: 'a-derive',
            output: {
              reprocessMedia: true,
              source: 'omit',
              artifacts: { '*': 'include' },
            },
          }),
          // Runs only on the derivative pass: eq 901 is the DERIVATIVE
          // total after the root left the delivery set — the root pass
          // total was 5860, so a start-of-run snapshot would never match.
          makePolicy({
            id: 'b-on-derivative',
            origins: ['policy'],
            arguments: { maxDimension: 800 },
            when: requestWhen('==', 901),
          }),
        ],
      });
      expect(executeToolCallMock).toHaveBeenCalledTimes(2);
      // b-on-derivative EXECUTED (its `when` matched the recomputed total);
      // the mock returns bytes identical to its input, so the run records
      // as a no-op rather than a degradation — execution is the assertion.
      expect(records.map((r) => [r.policyId, r.outcome])).toEqual([
        ['a-derive', 'succeeded'],
        ['b-on-derivative', 'no_op'],
      ]);
    });

    it('evaluates session.* from the caller-supplied per-delivery snapshot', async () => {
      mockToolSuccess();
      const sessionWhen: FixedPolicyCondition = [
        '<=',
        ['field', 'session.availableContextTokens'],
        700,
      ];
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ when: sessionWhen })],
        conditionContext: { session: { availableContextTokens: 700 } },
      });
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });
    });

    it('reads session.* as unavailable when no snapshot was supplied', async () => {
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [
          makePolicy({
            when: ['<=', ['field', 'session.availableContextTokens'], 700],
          }),
        ],
      });
      expect(records).toEqual([
        {
          policyId: 'img-downsample',
          toolName: 'omni_downsample_image',
          outcome: 'condition_unavailable',
          resource: 'photo.png',
          missingFields: ['session.availableContextTokens'],
        },
      ]);
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });
  });

  it('caps re-derivation per lineage via maxRunsPerLineage', async () => {
    mockToolSuccess();
    const { deliveries } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          origins: ['user', 'tool', 'policy'],
          maxRunsPerLineage: 1,
          output: {
            reprocessMedia: true,
            source: 'omit',
            artifacts: { '*': 'include' },
          },
        }),
      ],
    });
    // The derivative re-enters matching but the lineage already spent the
    // policy's single run — exactly one execution, derivative delivered.
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].degraded).toBe(true);
  });

  it('keeps the source and continues on failure when onFailure is continue', async () => {
    executeToolCallMock.mockResolvedValue({
      callId: 'x',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('ffmpeg exploded'),
      errorType: undefined,
    });
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].filePath).toBe(sourcePath);
    expect(records).toEqual([
      {
        policyId: 'img-downsample',
        toolName: 'omni_downsample_image',
        outcome: 'failed',
        resource: 'photo.png',
        error: 'ffmpeg exploded',
      },
    ]);
    // Failure never leaves partial staging state (D10 Stage A).
    await expect(fs.readdir(store.getStagingDir())).resolves.toEqual([]);
  });

  it('throws OmniPolicyExecutionError when onFailure is abort', async () => {
    executeToolCallMock.mockResolvedValue({
      callId: 'x',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('ffmpeg exploded'),
      errorType: undefined,
    });
    await expect(
      runFixedPolicies(config, source, {
        store,
        policies: [makePolicy({ onFailure: 'abort' })],
      }),
    ).rejects.toMatchObject({
      name: 'OmniPolicyExecutionError',
      policyId: 'img-downsample',
      message: 'Fixed policy img-downsample failed: ffmpeg exploded',
    });
  });

  it('fails closed on transport_guard-stage failures regardless of onFailure', async () => {
    executeToolCallMock.mockResolvedValue({
      callId: 'x',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('guard tool crashed'),
      errorType: undefined,
    });
    await expect(
      runFixedPolicies(config, source, {
        store,
        policies: [
          makePolicy({ onFailure: 'continue', stage: 'transport_guard' }),
        ],
      }),
    ).rejects.toBeInstanceOf(OmniPolicyExecutionError);
  });

  it('rejects an artifact whose workspacePath escapes the staging directory', async () => {
    const evilPath = path.join(tmpDir, 'evil.jpg');
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => {
        await fs.writeFile(evilPath, DEGRADED_BYTES);
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
                kind: 'image',
                storage: 'workspace',
                title: 'evil.jpg',
                workspacePath: path.relative(
                  path.join(store.getStagingDir(), request.callId),
                  evilPath,
                ),
                metadata: { omniDisclosure: 'x' },
              },
            ],
          },
        };
      },
    );
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain('escapes the staging directory');
    expect(deliveries[0].filePath).toBe(sourcePath);
  });

  it('rejects a lossy artifact that carries no omniDisclosure', async () => {
    mockToolSuccess({ disclosure: undefined });
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain('lossy but carries no omniDisclosure');
  });

  it('fails the run when the tool succeeds but returns no policy artifacts', async () => {
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => ({
        callId: request.callId,
        responseParts: [],
        resultDisplay: undefined,
        error: undefined,
        errorType: undefined,
        // No policyArtifacts at all — e.g. a tool that "succeeded" without
        // emitting through the artifact protocol.
        policyArtifacts: undefined,
      }),
    );
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain('produced no policy artifacts');
    expect(deliveries[0].filePath).toBe(sourcePath);
  });

  it('rejects an artifact whose recognized media type is not declared by the descriptor', async () => {
    // The tool writes a GIF, but the descriptor only declares image/jpeg
    // outputs. Recognition of the actual bytes is authoritative — the
    // artifact's own declared mimeType never enters the check.
    recognizeMediaFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.gif')) {
        return {
          modality: 'image' as const,
          detectedMimeType: 'image/gif',
          sizeBytes: DEGRADED_BYTES.length,
          metadata: {},
        };
      }
      return recognizedImage();
    });
    mockToolSuccess({ fileName: 'out.gif' });
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain('undeclared media type image/gif');
    expect(deliveries[0].filePath).toBe(sourcePath);
  });

  it('rejects an artifact whose declared kind mismatches the recognized content', async () => {
    // Bytes recognize as image/jpeg (declared by the descriptor), but the
    // artifact claims to be audio — the cross-check must fail closed.
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => {
        const outputDir = request.args['outputDir'] as string;
        await fs.writeFile(path.join(outputDir, 'out.jpg'), DEGRADED_BYTES);
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
                kind: 'audio',
                storage: 'workspace',
                title: 'out.jpg',
                workspacePath: 'out.jpg',
                metadata: { omniDisclosure: 'x' },
              },
            ],
          },
        };
      },
    );
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain(
      'declares kind audio but contains image content',
    );
  });

  it('fails the run when a required media output was not produced (§5 completeness)', async () => {
    // Descriptor: jpeg is required, png is an optional lossless extra. The
    // tool only produces the png — it validates fine on its own, so only
    // assertRequiredOutputsPresent can catch the missing jpeg.
    const twoOutputDescriptor: MediaPolicyToolDescriptor = {
      kind: 'media_policy',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['image/jpeg'],
          required: true,
          lossy: true,
        },
        { kind: 'media', mimeTypes: ['image/png'], required: false },
      ],
    };
    const twoOutputConfig = makeConfig({
      omni_downsample_image: twoOutputDescriptor,
    });
    mockToolSuccess({ fileName: 'out.png', disclosure: undefined });
    const { deliveries, records } = await runFixedPolicies(
      twoOutputConfig,
      source,
      { store, policies: [makePolicy()] },
    );
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain(
      'did not produce its required media image/jpeg output',
    );
    expect(deliveries[0].filePath).toBe(sourcePath);
  });

  it('rejects a tool without a media-policy descriptor', async () => {
    const { records } = await runFixedPolicies(makeConfig({}), source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({ outcome: 'failed' });
    expect(records[0].error).toContain('not a registered media-policy tool');
  });

  it('executes policies in priority order, ties broken by id', async () => {
    mockToolSuccess();
    // Distinct arguments per policy: identical arguments would fingerprint
    // identically and turn the later runs into degradation-cache hits.
    await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          id: 'b-low',
          priority: 1,
          arguments: { maxDimension: 100 },
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
        makePolicy({
          id: 'a-high',
          priority: 10,
          arguments: { maxDimension: 300 },
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
        makePolicy({
          id: 'a-low',
          priority: 1,
          arguments: { maxDimension: 200 },
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
      ],
    });
    const order = executeToolCallMock.mock.calls.map((call) => {
      const origin = (call[1] as ToolCallRequestInfo).executionOrigin;
      return origin?.kind === 'fixed_policy' ? origin.policyId : undefined;
    });
    expect(order).toEqual(['a-high', 'a-low', 'b-low']);
  });

  it('stops BEFORE executing once maxPolicyRunsPerRoot is spent, recording budget_exhausted', async () => {
    mockToolSuccess();
    // Distinct arguments: identical ones would fingerprint identically and
    // make the second policy a (budget-free) degradation-cache hit.
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          id: 'a-first',
          arguments: { maxDimension: 100 },
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
        makePolicy({
          id: 'b-second',
          arguments: { maxDimension: 200 },
          output: {
            reprocessMedia: false,
            source: 'keep',
            artifacts: { '*': 'include' },
          },
        }),
      ],
      limits: limitsWith({ maxPolicyRunsPerRoot: 1 }),
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      {
        policyId: 'a-first',
        toolName: 'omni_downsample_image',
        outcome: 'succeeded',
        resource: 'photo.png',
      },
      {
        policyId: 'b-second',
        toolName: 'omni_downsample_image',
        outcome: 'budget_exhausted',
        resource: 'photo.png',
        error: 'maxPolicyRunsPerRoot (1) reached',
      },
    ]);
    // The committed delivery stands (no rollback): source + derivative.
    expect(deliveries.map((d) => d.filePath)).toEqual([
      sourcePath,
      store.objectPathFor(sha256Of(DEGRADED_BYTES), '.jpg'),
    ]);
  });

  it('stops deriving when maxArtifactsPerRoot is exceeded but keeps the committed delivery', async () => {
    mockToolSuccess();
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy(),
        makePolicy({ id: 'never-runs', arguments: { maxDimension: 300 } }),
      ],
      limits: limitsWith({ maxArtifactsPerRoot: 0 }),
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      {
        policyId: 'img-downsample',
        toolName: 'omni_downsample_image',
        outcome: 'succeeded',
        resource: 'photo.png',
      },
      {
        policyId: 'img-downsample',
        toolName: 'omni_downsample_image',
        outcome: 'budget_exhausted',
        resource: 'photo.png',
        error: 'maxArtifactsPerRoot (0) exceeded',
      },
    ]);
    // source: 'omit' already applied — the derivative alone is delivered.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].degraded).toBe(true);
  });

  it('stops deriving when maxDerivedBytesPerRoot is exceeded', async () => {
    mockToolSuccess(); // DEGRADED_BYTES is 20 bytes > the 10-byte budget
    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy(),
        makePolicy({ id: 'never-runs', arguments: { maxDimension: 300 } }),
      ],
      limits: limitsWith({ maxDerivedBytesPerRoot: 10 }),
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[1]).toEqual({
      policyId: 'img-downsample',
      toolName: 'omni_downsample_image',
      outcome: 'budget_exhausted',
      resource: 'photo.png',
      error: 'maxDerivedBytesPerRoot (10) exceeded',
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].degraded).toBe(true);
  });

  it('clamps reprocessing at maxLineageDepth even when lineage runs remain', async () => {
    // Distinct bytes per run: identical output would end the chain as a
    // no_op fixed point before the depth clamp could matter.
    let round = 0;
    executeToolCallMock.mockImplementation(
      async (_config: Config, request: ToolCallRequestInfo) => {
        round++;
        const outputDir = request.args['outputDir'] as string;
        await fs.writeFile(path.join(outputDir, 'out.jpg'), `round-${round}`);
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
                kind: 'image',
                storage: 'workspace',
                title: 'out.jpg',
                workspacePath: 'out.jpg',
                mimeType: 'image/jpeg',
                metadata: { omniDisclosure: `round ${round}` },
              },
            ],
          },
        };
      },
    );
    const { deliveries } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          origins: ['user', 'tool', 'policy'],
          maxRunsPerLineage: 10,
          output: {
            reprocessMedia: true,
            source: 'omit',
            artifacts: { '*': 'include' },
          },
        }),
      ],
      limits: limitsWith({ maxLineageDepth: 2 }),
    });
    // root(depth 0) → run 1 → depth-1 child re-enters → run 2 → the
    // depth-2 child delivers but does NOT re-enter (2 is not < 2). The
    // lineage cap alone (10) would have allowed further runs.
    expect(executeToolCallMock).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].sha256).toBe(sha256Of('round-2'));
  });

  it('quarantines the staging dir with a reason.json when the invocation fails (D10 Stage B)', async () => {
    executeToolCallMock.mockResolvedValue({
      callId: 'x',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('ffmpeg exploded'),
      errorType: undefined,
    });
    await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    await expect(fs.readdir(store.getStagingDir())).resolves.toEqual([]);
    const quarantined = await fs.readdir(store.getQuarantineDir());
    expect(quarantined).toHaveLength(1);
    const reason = JSON.parse(
      await fs.readFile(
        path.join(store.getQuarantineDir(), quarantined[0], 'reason.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(reason).toMatchObject({
      policyId: 'img-downsample',
      toolName: 'omni_downsample_image',
      reason: 'ffmpeg exploded',
    });
    expect(typeof reason['failedAt']).toBe('string');
  });

  it('removes (not quarantines) staging when the failure is a user abort', async () => {
    const controller = new AbortController();
    executeToolCallMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-flight');
    });
    await expect(
      runFixedPolicies(config, source, {
        store,
        policies: [makePolicy()],
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted mid-flight');
    await expect(fs.readdir(store.getStagingDir())).resolves.toEqual([]);
    await expect(
      fs.readdir(store.getQuarantineDir()).catch(() => []),
    ).resolves.toEqual([]);
  });

  it('falls back to plain staging removal when quarantining itself fails', async () => {
    vi.spyOn(store, 'quarantineInvocation').mockRejectedValue(
      new Error('quarantine disk full'),
    );
    executeToolCallMock.mockResolvedValue({
      callId: 'x',
      responseParts: [],
      resultDisplay: undefined,
      error: new Error('ffmpeg exploded'),
      errorType: undefined,
    });
    const { records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });
    expect(records[0]).toMatchObject({
      outcome: 'failed',
      error: 'ffmpeg exploded',
    });
    // The failed invocation still never leaves live staging state behind.
    await expect(fs.readdir(store.getStagingDir())).resolves.toEqual([]);
  });

  describe('tool-level settings defaults (omni.processing.policyTools.<tool>.settings)', () => {
    it('merges settings under policy arguments in BOTH the tool call and the cache fingerprint', async () => {
      mockToolSuccess();
      const configured = makeConfig(
        { omni_downsample_image: DESCRIPTOR },
        { omni_downsample_image: { settings: { quality: 60 } } },
      );
      await runFixedPolicies(configured, source, {
        store,
        policies: [makePolicy()],
      });

      const req = executeToolCallMock.mock.calls[0][1] as ToolCallRequestInfo;
      expect(req.args).toMatchObject({ maxDimension: 1568, quality: 60 });

      // Fingerprint must include the merged tunables — otherwise editing
      // settings would keep serving derivatives made under the old values.
      const cache = new OmniDegradationCache(store.getOmniRootDir());
      await expect(
        cache.get(
          sha256Of(SOURCE_BYTES),
          computePolicyFingerprint('omni_downsample_image', {
            maxDimension: 1568,
            quality: 60,
          }),
        ),
      ).resolves.not.toBeNull();
      await expect(
        cache.get(
          sha256Of(SOURCE_BYTES),
          computePolicyFingerprint('omni_downsample_image', {
            maxDimension: 1568,
          }),
        ),
      ).resolves.toBeNull();
    });

    it('policy arguments override colliding settings keys', async () => {
      mockToolSuccess();
      const configured = makeConfig(
        { omni_downsample_image: DESCRIPTOR },
        { omni_downsample_image: { settings: { maxDimension: 99 } } },
      );
      await runFixedPolicies(configured, source, {
        store,
        policies: [makePolicy()], // arguments: { maxDimension: 1568 }
      });
      const req = executeToolCallMock.mock.calls[0][1] as ToolCallRequestInfo;
      expect(req.args['maxDimension']).toBe(1568);
    });

    it.each([
      ['null tombstone', { omni_downsample_image: null }],
      ['non-object settings', { omni_downsample_image: { settings: 'evil' } }],
      ['array settings', { omni_downsample_image: { settings: [1, 2] } }],
      ['absent map', undefined],
    ])('ignores malformed settings entries: %s', async (_label, settings) => {
      mockToolSuccess();
      const configured = makeConfig(
        { omni_downsample_image: DESCRIPTOR },
        settings,
      );
      await runFixedPolicies(configured, source, {
        store,
        policies: [makePolicy()],
      });
      const req = executeToolCallMock.mock.calls[0][1] as ToolCallRequestInfo;
      expect(req.args).toEqual({
        maxDimension: 1568,
        inputPath: sourcePath,
        outputDir: expect.stringContaining(store.getStagingDir()),
      });
    });
  });

  it('re-hashes a cache hit before reuse: poisoned object bytes trigger re-transcode (D2 integrity)', async () => {
    const degradedSha = sha256Of(DEGRADED_BYTES);
    const objectPath = store.objectPathFor(degradedSha, '.jpg');
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    // A file EXISTS at the addressed path but its bytes do not hash to the
    // entry's identity — planted via a crafted policy-cache.json plus a
    // foreign object (or plain store corruption).
    await fs.writeFile(objectPath, 'not-the-degraded-bytes');
    const cache = new OmniDegradationCache(store.getOmniRootDir());
    const fingerprint = computePolicyFingerprint('omni_downsample_image', {
      maxDimension: 1568,
    });
    await cache.put(sha256Of(SOURCE_BYTES), fingerprint, {
      degradedSha256: degradedSha,
      extension: '.jpg',
      disclosure: 'poisoned disclosure',
      mimeType: 'image/jpeg',
    });
    mockToolSuccess();

    const { deliveries, records } = await runFixedPolicies(config, source, {
      store,
      policies: [makePolicy()],
    });

    // The mismatching object was never served: the tool re-ran and the
    // store now holds verified bytes under the hash.
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'succeeded' });
    expect(deliveries[0].sha256).toBe(degradedSha);
    expect(deliveries[0].disclosure).toBe(
      'Downsampled from 4000x3000 to 1568x1176.',
    );
    await expect(fs.readFile(objectPath, 'utf8')).resolves.toBe(DEGRADED_BYTES);
  });

  describe('file artifacts (transcript protocol, §6.2)', () => {
    const TRANSCRIPT_TEXT = '你好，世界';
    const TRANSCRIPT_DISCLOSURE = '原 63s 音频 → 转写文本 5 字';

    const TRANSCRIPT_DESCRIPTOR: MediaPolicyToolDescriptor = {
      kind: 'media_policy',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'file',
          role: 'transcript',
          mimeTypes: ['text/plain'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
    };

    /** Tool mock producing one `kind: 'file'` artifact. */
    function mockFileArtifact(
      options: {
        bytes?: Buffer | string;
        mimeType?: string;
        role?: string;
        disclosure?: string | undefined;
      } = {},
    ): void {
      const bytes = options.bytes ?? TRANSCRIPT_TEXT;
      const mimeType = options.mimeType ?? 'text/plain';
      const role = options.role ?? 'transcript';
      const disclosure =
        'disclosure' in options ? options.disclosure : TRANSCRIPT_DISCLOSURE;
      executeToolCallMock.mockImplementation(
        async (_config: Config, request: ToolCallRequestInfo) => {
          const outputDir = request.args['outputDir'] as string;
          await fs.writeFile(path.join(outputDir, 'transcript.txt'), bytes);
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
                  kind: 'file',
                  storage: 'workspace',
                  title: 'Audio transcript',
                  workspacePath: 'transcript.txt',
                  mimeType,
                  metadata: {
                    ...(disclosure !== undefined
                      ? { omniDisclosure: disclosure }
                      : {}),
                    omniRole: role,
                  },
                },
              ],
            },
          };
        },
      );
    }

    function transcriptPolicy(
      overrides: Partial<NormalizedFixedPolicy> = {},
    ): NormalizedFixedPolicy {
      return makePolicy({
        id: 'img-transcribe',
        toolName: 'omni_transcribe_stub',
        arguments: {},
        output: {
          reprocessMedia: false,
          source: 'omit',
          artifacts: { 'role:transcript': 'include' },
        },
        ...overrides,
      });
    }

    beforeEach(() => {
      config = makeConfig({ omni_transcribe_stub: TRANSCRIPT_DESCRIPTOR });
    });

    it('reuses a TEXT product on the second run without re-running the tool', async () => {
      // Text products carry no derived version node, so their object path
      // must be reconstructed from the content hash. A real-run probe caught
      // this: audio/keyframe reuse hit while the transcript re-ran the entire
      // ASR pass — the single most expensive thing #8189 exists to avoid.
      const { MediaMemoryService } = await import(
        '../../services/media-memory/index.js'
      );
      const service = new MediaMemoryService(store.getOmniRootDir());
      const sha256 = createHash('sha256')
        .update(await fs.readFile(sourcePath))
        .digest('hex');
      const sourceBinding = await service.recordFileRecognized({
        fileRef: sourcePath,
        sha256,
        mediaType: 'image',
        metadata: recognizedImage().metadata,
        sizeBytes: recognizedImage().sizeBytes,
        mimeType: 'image/png',
        origin: 'user',
        source: { protocol: 'local', locator: 'photo.png' },
        recognition: {
          ingestionConfigHash: '',
          detectorVersion: 'omni-sniff-ffprobe/1',
          probeStatus: 'complete',
        },
      });
      const options = {
        store,
        policies: [transcriptPolicy()],
        memory: { service, sourceBinding },
      };

      mockFileArtifact();
      const first = await runFixedPolicies(config, source, options);
      expect(first.fileDeliveries[0]?.text).toBe(TRANSCRIPT_TEXT);
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);

      const second = await runFixedPolicies(config, source, options);
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      // Full text comes back from the promoted object, not from the
      // entry's truncated inlineText copy.
      expect(second.fileDeliveries[0]?.text).toBe(TRANSCRIPT_TEXT);
      expect(second.fileDeliveries[0]?.disclosure).toBe(TRANSCRIPT_DISCLOSURE);
    });

    it('validates and promotes the transcript into fileDeliveries with text + disclosure', async () => {
      mockFileArtifact();
      const { deliveries, fileDeliveries, records } = await runFixedPolicies(
        config,
        source,
        { store, policies: [transcriptPolicy()] },
      );

      // source omitted, no media derivative — pure-transcript outcome.
      expect(deliveries).toEqual([]);
      expect(records).toEqual([
        {
          policyId: 'img-transcribe',
          toolName: 'omni_transcribe_stub',
          outcome: 'succeeded',
          resource: 'photo.png',
        },
      ]);
      const transcriptSha = sha256Of(TRANSCRIPT_TEXT);
      expect(fileDeliveries).toEqual([
        {
          filePath: store.objectPathFor(transcriptSha, '.txt'),
          role: 'transcript',
          mimeType: 'text/plain',
          text: TRANSCRIPT_TEXT,
          sha256: transcriptSha,
          sizeBytes: Buffer.byteLength(TRANSCRIPT_TEXT, 'utf-8'),
          disclosure: TRANSCRIPT_DISCLOSURE,
        },
      ]);
      // Promoted (content-addressed, immutable) — not left in staging.
      await expect(
        fs.readFile(store.objectPathFor(transcriptSha, '.txt'), 'utf-8'),
      ).resolves.toBe(TRANSCRIPT_TEXT);
    });

    it('a retain selector keeps the transcript out of fileDeliveries', async () => {
      mockFileArtifact();
      const { fileDeliveries, records } = await runFixedPolicies(
        config,
        source,
        {
          store,
          policies: [
            transcriptPolicy({
              output: {
                reprocessMedia: false,
                source: 'omit',
                artifacts: { 'role:transcript': 'retain', '*': 'include' },
              },
            }),
          ],
        },
      );
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });
      expect(fileDeliveries).toEqual([]);
    });

    describe('memory.* condition namespace (§4.1/4.4)', () => {
      /** A transcript-producing policy gated on "no transcript in memory". */
      const MEMORY_GATED_WHEN = [
        'all',
        ['==', ['field', 'memory.hasTranscript'], 0],
      ] as unknown as NormalizedFixedPolicy['when'];

      async function memoryServiceWithBinding() {
        const { MediaMemoryService } = await import(
          '../../services/media-memory/index.js'
        );
        const service = new MediaMemoryService(store.getOmniRootDir());
        const sha256 = createHash('sha256')
          .update(await fs.readFile(sourcePath))
          .digest('hex');
        const sourceBinding = await service.recordFileRecognized({
          fileRef: sourcePath,
          sha256,
          mediaType: 'image',
          metadata: recognizedImage().metadata,
          sizeBytes: recognizedImage().sizeBytes,
          mimeType: 'image/png',
          origin: 'user',
          source: { protocol: 'local', locator: 'photo.png' },
          recognition: {
            ingestionConfigHash: '',
            detectorVersion: 'omni-sniff-ffprobe/1',
            probeStatus: 'complete',
          },
        });
        return { service, sourceBinding };
      }

      it('runs the policy when memory holds no transcript, skips the second run', async () => {
        const { service, sourceBinding } = await memoryServiceWithBinding();
        mockFileArtifact();
        const options = {
          store,
          policies: [transcriptPolicy({ when: MEMORY_GATED_WHEN })],
          memory: { service, sourceBinding },
        };

        const first = await runFixedPolicies(config, source, options);
        expect(first.records[0]).toMatchObject({ outcome: 'succeeded' });
        expect(executeToolCallMock).toHaveBeenCalledTimes(1);

        // Second run: memory now holds the transcript — the condition
        // reads it and the policy is skipped WITHOUT a tool call or a
        // run record (a `no_match` is a non-event). (The S4 reuse path
        // would also have skipped the execution; the memory gate is what
        // spares even the reuse bookkeeping and the delivery churn.)
        const second = await runFixedPolicies(config, source, options);
        expect(second.records).toEqual([]);
        expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      });

      it('evaluates unavailable (and honors onConditionUnavailable) when memory is off', async () => {
        mockFileArtifact();
        const { records } = await runFixedPolicies(config, source, {
          store,
          // No `memory` option: the namespace cannot be resolved, the
          // condition is unavailable, and 'skip' records it.
          policies: [transcriptPolicy({ when: MEMORY_GATED_WHEN })],
        });
        expect(records[0]).toMatchObject({
          outcome: 'condition_unavailable',
          missingFields: ['memory.hasTranscript'],
        });
        expect(executeToolCallMock).not.toHaveBeenCalled();
      });
    });

    it('an artifact no selector matches defaults to retain (no "*" entry)', async () => {
      mockFileArtifact();
      const { fileDeliveries, records } = await runFixedPolicies(
        config,
        source,
        {
          store,
          policies: [
            transcriptPolicy({
              output: { reprocessMedia: false, source: 'omit', artifacts: {} },
            }),
          ],
        },
      );
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });
      expect(fileDeliveries).toEqual([]);
    });

    it('rejects a file artifact that is not valid UTF-8', async () => {
      mockFileArtifact({ bytes: Buffer.from([0xff, 0xfe, 0x80, 0x00]) });
      const { fileDeliveries, records } = await runFixedPolicies(
        config,
        source,
        { store, policies: [transcriptPolicy()] },
      );
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining('is not valid UTF-8 text'),
      });
      expect(fileDeliveries).toEqual([]);
    });

    it('rejects a file artifact over MAX_FILE_ARTIFACT_BYTES', async () => {
      mockFileArtifact({ bytes: 'a'.repeat(MAX_FILE_ARTIFACT_BYTES + 1) });
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining(
          `exceeds the file-artifact size budget (${MAX_FILE_ARTIFACT_BYTES + 1} > ${MAX_FILE_ARTIFACT_BYTES} bytes)`,
        ),
      });
    });

    it('rejects a lossy file artifact without omniDisclosure', async () => {
      mockFileArtifact({ disclosure: undefined });
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining(
          'is lossy but carries no omniDisclosure',
        ),
      });
    });

    it('rejects a file artifact whose mimeType matches no declared file output', async () => {
      mockFileArtifact({ mimeType: 'text/markdown' });
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining('matches no declared file output'),
      });
    });

    it('fails the run when the required file output was not produced (§5 completeness)', async () => {
      // Descriptor requires BOTH a media and a transcript output; the tool
      // only produces the media derivative.
      config = makeConfig({
        omni_transcribe_stub: {
          kind: 'media_policy',
          inputMediaTypes: ['image'],
          outputs: [
            {
              kind: 'media',
              mimeTypes: ['image/jpeg'],
              required: true,
              lossy: true,
            },
            {
              kind: 'file',
              role: 'transcript',
              mimeTypes: ['text/plain'],
              required: true,
              lossy: true,
            },
            { kind: 'text', role: 'disclosure', required: true },
          ],
        },
      });
      mockToolSuccess();
      const { records } = await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining(
          'did not produce its required file text/plain output',
        ),
      });
    });

    it('never serves file artifacts from the degradation cache (re-runs the tool)', async () => {
      mockFileArtifact();
      await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      const second = await runFixedPolicies(config, source, {
        store,
        policies: [transcriptPolicy()],
      });
      expect(executeToolCallMock).toHaveBeenCalledTimes(2);
      expect(second.records[0]).toMatchObject({ outcome: 'succeeded' });
      expect(second.fileDeliveries).toHaveLength(1);
    });

    it('counts file artifacts toward maxArtifactsPerRoot', async () => {
      mockFileArtifact();
      const { records, fileDeliveries } = await runFixedPolicies(
        config,
        source,
        {
          store,
          policies: [
            transcriptPolicy({ id: 'transcribe-a' }),
            transcriptPolicy({ id: 'transcribe-b' }),
          ],
          limits: limitsWith({ maxArtifactsPerRoot: 1 }),
        },
      );
      // The second run tips the count over the budget: its delivery stands
      // but derivation stops with an explicit budget_exhausted record.
      expect(records.map((r) => r.outcome)).toEqual([
        'succeeded',
        'succeeded',
        'budget_exhausted',
      ]);
      expect(fileDeliveries).toHaveLength(2);
    });
  });

  describe('maxConcurrentResources gates concurrent runs per omni root', () => {
    /** Tool mock that parks each invocation on a caller-released latch,
     * recording how many invocations are in flight simultaneously. */
    function mockGatedTool() {
      let inFlight = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      executeToolCallMock.mockImplementation(
        async (_config: Config, request: ToolCallRequestInfo) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight--;
          const outputDir = request.args['outputDir'] as string;
          const bytes = `degraded-${request.callId}`;
          await fs.writeFile(path.join(outputDir, 'out.jpg'), bytes);
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
                  kind: 'image',
                  storage: 'workspace',
                  title: 'out.jpg',
                  workspacePath: 'out.jpg',
                  mimeType: 'image/jpeg',
                  metadata: { omniDisclosure: 'gated' },
                },
              ],
            },
          };
        },
      );
      return {
        peak: () => peak,
        started: () => releases.length,
        releaseAll: () => {
          for (const release of releases.splice(0)) release();
        },
      };
    }

    async function makeSecondSource(): Promise<PolicySourceResource> {
      const secondPath = path.join(tmpDir, 'photo-2.png');
      await fs.writeFile(secondPath, 'second-image-bytes');
      return {
        filePath: secondPath,
        recognized: recognizedImage({ sizeBytes: 18 }),
        displayName: 'photo-2.png',
        origin: 'user',
      };
    }

    it('limit 1: the second resource waits until the first fully finishes', async () => {
      const gate = mockGatedTool();
      const second = await makeSecondSource();
      const options = {
        store,
        policies: [makePolicy()],
        limits: limitsWith({ maxConcurrentResources: 1 }),
      };

      const run1 = runFixedPolicies(config, source, options);
      const run2 = runFixedPolicies(config, second, options);
      // Give both runs every chance to start their tool call.
      await vi.waitFor(() => expect(gate.started()).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(gate.started()).toBe(1); // run2 is parked on the gate

      gate.releaseAll(); // finish run1 → slot transfers to run2
      await vi.waitFor(() => expect(gate.started()).toBe(1)); // fresh latch
      gate.releaseAll();
      await Promise.all([run1, run2]);
      expect(gate.peak()).toBe(1);
      expect(executeToolCallMock).toHaveBeenCalledTimes(2);
    });

    it('limit 2: both resources transcode simultaneously', async () => {
      const gate = mockGatedTool();
      const second = await makeSecondSource();
      const options = {
        store,
        policies: [makePolicy()],
        limits: limitsWith({ maxConcurrentResources: 2 }),
      };

      const run1 = runFixedPolicies(config, source, options);
      const run2 = runFixedPolicies(config, second, options);
      await vi.waitFor(() => expect(gate.started()).toBe(2));
      expect(gate.peak()).toBe(2);
      gate.releaseAll();
      await Promise.all([run1, run2]);
    });

    it('a failed run releases its slot (no deadlock for the waiter)', async () => {
      const second = await makeSecondSource();
      executeToolCallMock
        .mockResolvedValueOnce({
          callId: 'x',
          responseParts: [],
          resultDisplay: undefined,
          error: new Error('ffmpeg exploded'),
          errorType: undefined,
        })
        .mockImplementation(
          async (_c: Config, request: ToolCallRequestInfo) => {
            const outputDir = request.args['outputDir'] as string;
            await fs.writeFile(path.join(outputDir, 'out.jpg'), DEGRADED_BYTES);
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
                    kind: 'image',
                    storage: 'workspace',
                    title: 'out.jpg',
                    workspacePath: 'out.jpg',
                    mimeType: 'image/jpeg',
                    metadata: { omniDisclosure: 'ok' },
                  },
                ],
              },
            };
          },
        );
      const options = {
        store,
        policies: [makePolicy({ onFailure: 'abort' as const })],
        limits: limitsWith({ maxConcurrentResources: 1 }),
      };
      await expect(runFixedPolicies(config, source, options)).rejects.toThrow(
        OmniPolicyExecutionError,
      );
      // The waiter (or any later run) must still get the slot.
      const { records } = await runFixedPolicies(config, second, options);
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });
    });
  });
  describe('memory reuse skips execution (#8189)', () => {
    it('reuses recorded outputs on the second run without calling the tool', async () => {
      const { MediaMemoryService } = await import(
        '../../services/media-memory/index.js'
      );
      const service = new MediaMemoryService(store.getOmniRootDir());
      const sha256 = createHash('sha256')
        .update(await fs.readFile(sourcePath))
        .digest('hex');
      const sourceBinding = await service.recordFileRecognized({
        fileRef: sourcePath,
        sha256,
        mediaType: 'image',
        metadata: recognizedImage().metadata,
        sizeBytes: recognizedImage().sizeBytes,
        mimeType: 'image/png',
        origin: 'user',
        source: { protocol: 'local', locator: 'source.png' },
        recognition: {
          ingestionConfigHash: '',
          detectorVersion: 'omni-sniff-ffprobe/1',
          probeStatus: 'complete',
        },
      });
      const options = {
        store,
        policies: [makePolicy({})],
        memory: { service, sourceBinding },
      };

      mockToolSuccess();
      const first = await runFixedPolicies(config, source, options);
      expect(first.records[0]).toMatchObject({ outcome: 'succeeded' });
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);

      // Second delivery of the same bytes under the same configuration:
      // the tool must NOT run again, and the derivative must be the very
      // same content-addressed object.
      const second = await runFixedPolicies(config, source, options);
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);
      expect(second.records[0]).toMatchObject({ outcome: 'succeeded' });
      expect(second.deliveries[0]!.sha256).toBe(first.deliveries[0]!.sha256);
      expect(second.deliveries[0]!.filePath).toBe(
        first.deliveries[0]!.filePath,
      );
      expect(second.deliveries[0]!.disclosure).toBe(
        first.deliveries[0]!.disclosure,
      );
    });
  });

  describe('memory collection commits (S5)', () => {
    let service: MediaMemoryService;

    /** Record the source bytes as a user file, the way the delivery
     * pipeline does before it hands the root to the orchestrator. */
    async function recordSource(service: MediaMemoryService) {
      const sha256 = createHash('sha256')
        .update(await fs.readFile(sourcePath))
        .digest('hex');
      const binding = await service.recordFileRecognized({
        fileRef: sourcePath,
        sha256,
        mediaType: 'image',
        metadata: recognizedImage().metadata,
        sizeBytes: recognizedImage().sizeBytes,
        mimeType: 'image/png',
        origin: 'user',
        source: { protocol: 'local', locator: 'photo.png' },
        recognition: {
          ingestionConfigHash: '',
          detectorVersion: 'omni-sniff-ffprobe/1',
          probeStatus: 'complete',
        },
      });
      return binding!;
    }

    async function readSnapshot(): Promise<MediaMemorySnapshot> {
      return JSON.parse(
        await fs.readFile(
          path.join(store.getOmniRootDir(), MEDIA_MEMORY_FILE_NAME),
          'utf8',
        ),
      ) as MediaMemorySnapshot;
    }

    beforeEach(async () => {
      const { MediaMemoryService: Service } = await import(
        '../../services/media-memory/index.js'
      );
      service = new Service(store.getOmniRootDir());
    });

    it('commits the execution and threads the derived binding onto the delivery', async () => {
      // Everything memory can later recall about a policy derivative —
      // reuse (#8189), recall payloads, the honesty of the lineage graph —
      // hangs off this one commit at the orchestrator's success point. If
      // it stops firing, delivery still looks perfectly healthy: the
      // derivative ships, and memory quietly stays empty forever.
      const sourceBinding = await recordSource(service);
      mockToolSuccess();
      const { deliveries, records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy()],
        memory: { service, sourceBinding },
      });
      expect(records[0]).toMatchObject({ outcome: 'succeeded' });

      const snapshot = await readSnapshot();
      const executions = Object.values(snapshot.executions);
      expect(executions).toHaveLength(1);
      const execution = executions[0];
      expect(execution).toMatchObject({
        // EXECUTED_ON: the version the tool actually ran against, not
        // whatever the root of the tree happens to be.
        sourceVersionId: sourceBinding.fileVersionId,
        rootFileId: sourceBinding.rootFileId,
        executionOrigin: {
          kind: 'fixed_policy',
          policyId: 'img-downsample',
          stage: 'preprocessing',
        },
        toolName: 'omni_downsample_image',
        // Effective arguments AND the fingerprint they hash to: this pair
        // is the content-identity reuse key, so a commit that recorded
        // either loosely would hand later runs a false reuse hit.
        finalArguments: { maxDimension: 1568 },
        omniConfigHash: computePolicyFingerprint(
          'omni_downsample_image',
          { maxDimension: 1568 },
          undefined,
        ),
      });
      expect(execution.outputRefs).toHaveLength(1);
      // Recall reports "processed at" from these two fields, so both must
      // be real ISO instants in the right order — a missing or reversed
      // window turns into a nonsense duration in the payload.
      expect(
        Date.parse(execution.completedAt) - Date.parse(execution.startedAt),
      ).toBeGreaterThanOrEqual(0);

      const degradedSha = sha256Of(DEGRADED_BYTES);
      const derivedVersion = Object.values(snapshot.versions).find(
        (version) => version.sha256 === degradedSha,
      );
      expect(derivedVersion).toBeDefined();
      // DERIVED_FROM / PRODUCED_BY: without both edges the derivative is
      // an orphan node and recall can never reach it from the user's file.
      expect(derivedVersion!.parentVersionId).toBe(sourceBinding.fileVersionId);
      expect(derivedVersion!.producedByExecutionId).toBe(execution.executionId);
      expect(snapshot.files[derivedVersion!.fileId].rootFileId).toBe(
        sourceBinding.rootFileId,
      );

      // The binding rides out on the delivery: the transport guard and the
      // reactive ladder commit their own passes onto it, so a delivery that
      // ships without it silently starts a second, disconnected lineage.
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].memoryBinding).toEqual({
        fileId: derivedVersion!.fileId,
        fileVersionId: derivedVersion!.fileVersionId,
        rootFileId: sourceBinding.rootFileId,
      });
    });

    it('threads each derived binding into the next pass as its own source', async () => {
      // Two-stage lineage: the second policy runs on the FIRST policy's
      // derivative. Committing that pass against the root binding instead
      // of the derivative's own would flatten the chain into two siblings
      // of the root — the graph would then claim the 800px image was
      // produced from the original PNG, which is a lie about provenance
      // and breaks reuse for the intermediate.
      const sourceBinding = await recordSource(service);
      // Distinct bytes per rung so each stage has its own content identity.
      executeToolCallMock.mockImplementation(
        async (_config: Config, request: ToolCallRequestInfo) => {
          const outputDir = request.args['outputDir'] as string;
          const bytes = `degraded-${request.args['maxDimension']}`;
          await fs.writeFile(path.join(outputDir, 'out.jpg'), bytes);
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
                  kind: 'image',
                  storage: 'workspace',
                  title: 'out.jpg',
                  workspacePath: 'out.jpg',
                  mimeType: 'image/jpeg',
                  metadata: { omniDisclosure: 'Downsampled.' },
                },
              ],
            },
          };
        },
      );

      const { deliveries } = await runFixedPolicies(config, source, {
        store,
        policies: [
          makePolicy({
            id: 'stage-1',
            output: {
              reprocessMedia: true,
              source: 'omit',
              artifacts: { '*': 'include' },
            },
          }),
          makePolicy({
            id: 'stage-2',
            origins: ['policy'],
            arguments: { maxDimension: 800 },
          }),
        ],
        memory: { service, sourceBinding },
      });
      expect(executeToolCallMock).toHaveBeenCalledTimes(2);

      const snapshot = await readSnapshot();
      const versionBySha = (sha: string) =>
        Object.values(snapshot.versions).find((v) => v.sha256 === sha)!;
      const stage1Version = versionBySha(sha256Of('degraded-1568'));
      const stage2Version = versionBySha(sha256Of('degraded-800'));
      const stage2Execution = Object.values(snapshot.executions).find(
        (e) =>
          e.executionOrigin.kind === 'fixed_policy' &&
          e.executionOrigin.policyId === 'stage-2',
      )!;
      expect(stage2Execution.sourceVersionId).toBe(stage1Version.fileVersionId);
      expect(stage2Version.parentVersionId).toBe(stage1Version.fileVersionId);
      // Depth grows, but every node stays inside the ONE root's tree —
      // that root bounds every recall traversal.
      expect(snapshot.files[stage2Version.fileId].rootFileId).toBe(
        sourceBinding.rootFileId,
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].memoryBinding).toMatchObject({
        fileVersionId: stage2Version.fileVersionId,
      });
    });

    it('commits a degradation-cache hit onto the same lineage', async () => {
      // The degradation cache is a workspace file that outlives a wiped
      // memory.json (or predates memory being switched on at all). On that
      // replay the tool never runs, so the post-promotion commit above
      // never fires — without the cache-hit commit the delivered
      // derivative would carry no binding, and every later pass in the
      // pipeline would derive from nothing.
      mockToolSuccess();
      const seeded = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy()],
      });
      expect(seeded.records[0]).toMatchObject({ outcome: 'succeeded' });

      const sourceBinding = await recordSource(service);
      const { deliveries, records } = await runFixedPolicies(config, source, {
        store,
        policies: [makePolicy()],
        memory: { service, sourceBinding },
      });
      expect(records[0]).toMatchObject({ outcome: 'cache_hit' });
      expect(executeToolCallMock).toHaveBeenCalledTimes(1);

      const snapshot = await readSnapshot();
      const executions = Object.values(snapshot.executions);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        invocationId: 'cache-hit',
        sourceVersionId: sourceBinding.fileVersionId,
        toolName: 'omni_downsample_image',
      });
      const derivedVersion = Object.values(snapshot.versions).find(
        (version) => version.sha256 === sha256Of(DEGRADED_BYTES),
      );
      expect(derivedVersion).toBeDefined();
      expect(deliveries[0].memoryBinding).toEqual({
        fileId: derivedVersion!.fileId,
        fileVersionId: derivedVersion!.fileVersionId,
        rootFileId: sourceBinding.rootFileId,
      });
    });
  });
});
