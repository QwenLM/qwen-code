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
import type { RecognizedMedia } from '../recognition.js';
import { OmniObjectStore } from '../storage.js';
import {
  computePolicyFingerprint,
  OmniDegradationCache,
} from './degradation-cache.js';
import {
  OmniPolicyExecutionError,
  runFixedPolicies,
  type PolicySourceResource,
} from './orchestrator.js';
import type { NormalizedFixedPolicy } from './types.js';

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
    output: { reprocessMedia: false, source: 'omit' },
    stage: 'preprocessing',
    ...overrides,
  };
}

function makeConfig(
  descriptorByTool: Record<string, MediaPolicyToolDescriptor>,
) {
  return {
    getToolRegistry: () => ({
      getTool: (name: string) =>
        descriptorByTool[name]
          ? { mediaPolicyDescriptor: descriptorByTool[name] }
          : undefined,
    }),
  } as unknown as Config;
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
        makePolicy({ output: { reprocessMedia: false, source: 'keep' } }),
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
          when: {
            left: { field: 'resource.width' },
            operator: 'gt',
            right: { value: 5000 },
          },
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
          when: {
            left: { field: 'resource.durationMs' },
            operator: 'gt',
            right: { value: 1000 },
          },
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
          when: {
            left: { field: 'resource.durationMs' },
            operator: 'gt',
            right: { value: 1000 },
          },
        }),
      ],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('caps re-derivation per lineage via maxRunsPerLineage', async () => {
    mockToolSuccess();
    const { deliveries } = await runFixedPolicies(config, source, {
      store,
      policies: [
        makePolicy({
          origins: ['user', 'tool', 'policy'],
          maxRunsPerLineage: 1,
          output: { reprocessMedia: true, source: 'omit' },
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
          output: { reprocessMedia: false, source: 'keep' },
        }),
        makePolicy({
          id: 'a-high',
          priority: 10,
          arguments: { maxDimension: 300 },
          output: { reprocessMedia: false, source: 'keep' },
        }),
        makePolicy({
          id: 'a-low',
          priority: 1,
          arguments: { maxDimension: 200 },
          output: { reprocessMedia: false, source: 'keep' },
        }),
      ],
    });
    const order = executeToolCallMock.mock.calls.map((call) => {
      const origin = (call[1] as ToolCallRequestInfo).executionOrigin;
      return origin?.kind === 'fixed_policy' ? origin.policyId : undefined;
    });
    expect(order).toEqual(['a-high', 'a-low', 'b-low']);
  });
});
