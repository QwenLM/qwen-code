// Force strict mode and setup for ESM
"use strict";
import {
  assertRequiredOutputsPresent,
  computePolicyFingerprint,
  validateArtifact
} from "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import {
  MEDIA_DETECTOR_VERSION,
  MediaMemoryService
} from "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-RSFNJ6UU.js";
import "./chunk-TFDCK56Y.js";
import {
  OmniObjectStore
} from "./chunk-FTKXJMQV.js";
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile
} from "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-CA63HYHU.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/model-call-collection.ts
init_esbuild_shims();
import path from "node:path";
var debugLogger = createDebugLogger("omni:memory");
async function collectModelPolicyCall(params) {
  const { config, batch, descriptor, args, signal } = params;
  if (batch.executionOrigin.kind === "fixed_policy") return;
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig) return;
  const inputPath = args["inputPath"];
  const outputDir = args["outputDir"];
  if (typeof inputPath !== "string" || typeof outputDir !== "string") return;
  try {
    const store = new OmniObjectStore(config.storage.getQwenDir());
    const memory = new MediaMemoryService(store.getOmniRootDir(), {
      maxInlineTextBytes: memoryConfig.collection.maxInlineTextBytes
    });
    const source = await resolveSourceBinding({
      config,
      memory,
      inputPath,
      signal
    });
    if (!source) return;
    const startedAt = new Date(params.startedAt ?? Date.now()).toISOString();
    const validated = await Promise.all(
      batch.artifacts.map(
        (artifact) => validateArtifact(artifact, descriptor, path.resolve(outputDir), signal)
      )
    );
    assertRequiredOutputsPresent(descriptor, validated, batch.toolName);
    const outputs = await Promise.all(
      validated.map(async (artifact) => {
        const mimeType = artifact.kind === "media" ? artifact.recognized.detectedMimeType : artifact.mimeType;
        const put = await store.putFile(
          artifact.absolutePath,
          artifact.sha256,
          extensionForMime(mimeType),
          signal
        );
        return artifact.kind === "media" ? {
          kind: "media",
          objectPath: put.objectPath,
          sha256: artifact.sha256,
          mediaType: artifact.recognized.modality,
          metadata: artifact.recognized.metadata,
          sizeBytes: artifact.recognized.sizeBytes,
          mimeType: artifact.recognized.detectedMimeType,
          role: artifact.role,
          disclosure: artifact.disclosure
        } : {
          kind: "text",
          objectPath: put.objectPath,
          sha256: artifact.sha256,
          mimeType: artifact.mimeType,
          text: artifact.text,
          sizeBytes: artifact.sizeBytes,
          role: artifact.role,
          disclosure: artifact.disclosure
        };
      })
    );
    const finalArguments = { ...args };
    delete finalArguments["inputPath"];
    delete finalArguments["outputDir"];
    delete finalArguments["resourceId"];
    const commit = await memory.commitPolicySucceeded({
      invocationId: batch.invocationId,
      source,
      executionOrigin: batch.executionOrigin,
      toolName: batch.toolName,
      ...descriptor.version !== void 0 ? { toolVersion: descriptor.version } : {},
      finalArguments,
      omniConfigHash: computePolicyFingerprint(
        batch.toolName,
        args,
        descriptor.version
      ),
      startedAt,
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      outputs
    });
    debugLogger.debug(
      `omni memory: ${commit?.created === false ? "replayed" : "recorded"} ${batch.toolName} (${batch.executionOrigin.kind}) with ${outputs.length} output(s)`
    );
  } catch (err) {
    if (signal?.aborted) return;
    debugLogger.debug(
      `omni memory: collecting ${batch.toolName} (${batch.executionOrigin.kind}) failed, skipping: ${err instanceof Error ? err.message : err}`
    );
  }
}
__name(collectModelPolicyCall, "collectModelPolicyCall");
async function resolveSourceBinding(params) {
  const { config, memory, inputPath, signal } = params;
  const bound = config.getOmniMediaResourceRegistry?.()?.resolveByFileRef(inputPath);
  if (bound) {
    return {
      fileId: bound.fileId,
      fileVersionId: bound.fileVersionId,
      rootFileId: bound.rootFileId
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
    origin: "user",
    source: { protocol: "local", locator: path.basename(inputPath) },
    recognition: {
      ingestionConfigHash: "",
      detectorVersion: MEDIA_DETECTOR_VERSION,
      probeStatus: "complete"
    }
  });
}
__name(resolveSourceBinding, "resolveSourceBinding");
export {
  collectModelPolicyCall
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
