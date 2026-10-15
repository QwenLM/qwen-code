/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Config } from '../../config/config.js';
import type { PolicyArtifactBatch } from '../../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  MediaMemoryService,
  MEDIA_DETECTOR_VERSION,
  type MediaMemoryBinding,
  type OmniMediaRegistryView,
  type OmniMemoryConfigView,
  type PolicyOutputInput,
} from '../../services/media-memory/index.js';
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile,
} from '../recognition.js';
import { OmniObjectStore } from '../storage.js';
import { computePolicyFingerprint } from './degradation-cache.js';
import {
  assertRequiredOutputsPresent,
  validateArtifact,
} from './orchestrator.js';

const debugLogger = createDebugLogger('omni:memory');

/**
 * Model/client-origin half of the `OmniPolicySucceeded` boundary (memory
 * design M §7.1: «固定调用、模型 ToolCall 和 direct client 调用在成功后
 * 都进入同一个 OmniPolicySucceeded 逻辑边界»).
 *
 * The fixed-policy orchestrator commits its own successes inline, where it
 * already holds the staging dir, the promoted objects and the source
 * binding. A gated model call has no orchestrator around it: the scheduler
 * (and ACP's own executor) capture the raw `PolicyArtifactBatch` and hand
 * it here, which walks the same gates in the same order — validate against
 * the descriptor, require declared outputs, promote to the object store,
 * THEN commit (M §6.4 / S §5: no record may reference bytes that are not
 * yet in `objects/`).
 *
 * Without this, evidence gathering never accumulated: recall reported a
 * gap, the advisor suggested a tool, the model called it, the tool
 * succeeded — and the next session's recall reported the identical gap
 * because nothing was ever written.
 *
 * Collection failure never affects the tool call (D12): everything is
 * caught and logged.
 */
export async function collectModelPolicyCall(params: {
  config: Config;
  batch: PolicyArtifactBatch;
  descriptor: MediaPolicyToolDescriptor;
  /** Resolved arguments the tool actually ran with (post-gate: a
   * `resourceId` the caller passed has already become `inputPath`). */
  args: Record<string, unknown>;
  /** Epoch ms when the tool actually began executing. The caller owns this
   * — measuring it here would time the COLLECTION, not the work. */
  startedAt?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, batch, descriptor, args, signal } = params;
  // Fixed-policy successes are committed by the orchestrator itself; a
  // second commit here would be a duplicate write of the same execution.
  if (batch.executionOrigin.kind === 'fixed_policy') return;
  const memoryConfig = (config as OmniMemoryConfigView).getOmniMemoryConfig?.();
  if (!memoryConfig) return;

  const inputPath = args['inputPath'];
  const outputDir = args['outputDir'];
  if (typeof inputPath !== 'string' || typeof outputDir !== 'string') return;

  try {
    const store = new OmniObjectStore(config.storage.getQwenDir());
    const memory = new MediaMemoryService(store.getOmniRootDir(), {
      maxInlineTextBytes: memoryConfig.collection.maxInlineTextBytes,
    });

    const source = await resolveSourceBinding({
      config,
      memory,
      inputPath,
      signal,
    });
    if (!source) return;

    // Fall back to "now" only when the caller could not supply the real
    // start; that degrades the recorded duration, never correctness.
    const startedAt = new Date(params.startedAt ?? Date.now()).toISOString();
    // Same containment rule the orchestrator applies to its staging dir:
    // an artifact must live inside the output directory the call declared.
    const validated = await Promise.all(
      batch.artifacts.map((artifact) =>
        validateArtifact(artifact, descriptor, path.resolve(outputDir), signal),
      ),
    );
    assertRequiredOutputsPresent(descriptor, validated, batch.toolName);

    const outputs: PolicyOutputInput[] = await Promise.all(
      validated.map(async (artifact) => {
        const mimeType =
          artifact.kind === 'media'
            ? artifact.recognized.detectedMimeType
            : artifact.mimeType;
        const put = await store.putFile(
          artifact.absolutePath,
          artifact.sha256,
          extensionForMime(mimeType),
          signal,
        );
        return artifact.kind === 'media'
          ? {
              kind: 'media' as const,
              objectPath: put.objectPath,
              sha256: artifact.sha256,
              mediaType: artifact.recognized.modality,
              metadata: artifact.recognized.metadata,
              sizeBytes: artifact.recognized.sizeBytes,
              mimeType: artifact.recognized.detectedMimeType,
              role: artifact.role,
              disclosure: artifact.disclosure,
            }
          : {
              kind: 'text' as const,
              objectPath: put.objectPath,
              sha256: artifact.sha256,
              mimeType: artifact.mimeType,
              text: artifact.text,
              sizeBytes: artifact.sizeBytes,
              role: artifact.role,
              disclosure: artifact.disclosure,
            };
      }),
    );

    // Reserved runtime keys are per-invocation plumbing, not reproducible
    // configuration — the same exclusion the fingerprint applies.
    const finalArguments: Record<string, unknown> = { ...args };
    delete finalArguments['inputPath'];
    delete finalArguments['outputDir'];
    delete finalArguments['resourceId'];

    const commit = await memory.commitPolicySucceeded({
      invocationId: batch.invocationId,
      source,
      executionOrigin: batch.executionOrigin,
      toolName: batch.toolName,
      ...(descriptor.version !== undefined
        ? { toolVersion: descriptor.version }
        : {}),
      finalArguments,
      omniConfigHash: computePolicyFingerprint(
        batch.toolName,
        args,
        descriptor.version,
      ),
      startedAt,
      completedAt: new Date().toISOString(),
      outputs,
    });
    // `created: false` is a content-identity replay: the same file already
    // recorded this execution (a same-invocation retry, or a degradation
    // cache hit). Worth distinguishing in the log, because "no new
    // execution appeared in memory.json" otherwise reads identically to a
    // collection that silently did nothing.
    debugLogger.debug(
      `omni memory: ${commit?.created === false ? 'replayed' : 'recorded'} ` +
        `${batch.toolName} (${batch.executionOrigin.kind}) with ` +
        `${outputs.length} output(s)`,
    );
  } catch (err) {
    if (signal?.aborted) return;
    debugLogger.debug(
      `omni memory: collecting ${batch.toolName} (${batch.executionOrigin.kind}) ` +
        `failed, skipping: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Memory identity of the source the call ran against. A handle-driven call
 * already has one in the session registry (the gate resolved that handle
 * into `inputPath`), so the file is not re-hashed; a call that named a raw
 * path falls back to recognizing it, which is an idempotent upsert.
 */
async function resolveSourceBinding(params: {
  config: Config;
  memory: MediaMemoryService;
  inputPath: string;
  signal?: AbortSignal;
}): Promise<MediaMemoryBinding | undefined> {
  const { config, memory, inputPath, signal } = params;
  const bound = (config as OmniMediaRegistryView)
    .getOmniMediaResourceRegistry?.()
    ?.resolveByFileRef(inputPath);
  if (bound) {
    return {
      fileId: bound.fileId,
      fileVersionId: bound.fileVersionId,
      rootFileId: bound.rootFileId,
    };
  }
  const recognized = await recognizeMediaFile(inputPath, { signal });
  const sha256 = await hashFileSha256(inputPath, signal);
  return memory.recordFileRecognized({
    fileRef: inputPath,
    sha256,
    mediaType: recognized.modality,
    metadata: recognized.metadata,
    sizeBytes: recognized.sizeBytes,
    mimeType: recognized.detectedMimeType,
    origin: 'user',
    source: { protocol: 'local', locator: path.basename(inputPath) },
    recognition: {
      ingestionConfigHash: '',
      detectorVersion: MEDIA_DETECTOR_VERSION,
      probeStatus: 'complete',
    },
  });
}
