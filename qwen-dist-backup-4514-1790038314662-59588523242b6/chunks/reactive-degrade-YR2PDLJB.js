// Force strict mode and setup for ESM
"use strict";
import {
  DashScopeUploader,
  OSS_URL_PREFIX
} from "./chunk-V2XJJTAB.js";
import {
  runFixedPolicies
} from "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import {
  MediaMemoryService
} from "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-RSFNJ6UU.js";
import {
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
  OmniUploadCache
} from "./chunk-JYGESWZM.js";
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
import {
  isOmniDeliveryActive
} from "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import {
  requireEffectiveOmniUploadConfig
} from "./chunk-SATGWSS6.js";
import "./chunk-BQMSZSG6.js";
import {
  formatDisclosureText
} from "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-VPGRGNNH.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/reactive-degrade.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
var debugLogger = createDebugLogger("omni:reactive-degrade");
var REACTIVE_LADDERS = {
  video: {
    toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
    steps: [
      { maxHeight: 480, fps: 2 },
      { maxHeight: 360, fps: 0.5 },
      { maxHeight: 360, fps: 0.25 }
    ]
  },
  image: {
    toolName: ToolNames.OMNI_DOWNSAMPLE_IMAGE,
    steps: [
      { maxDimension: 1024, quality: 70 },
      { maxDimension: 640, quality: 60 },
      { maxDimension: 448, quality: 50 }
    ]
  },
  audio: {
    toolName: ToolNames.OMNI_DOWNSAMPLE_AUDIO,
    steps: [
      { bitrateKbps: 32, sampleRateHz: 16e3, channels: 1 },
      { bitrateKbps: 16, sampleRateHz: 16e3, channels: 1 },
      { bitrateKbps: 12, sampleRateHz: 8e3, channels: 1 }
    ]
  }
};
var observedServerInputLimits = /* @__PURE__ */ new Map();
function recordObservedServerInputLimit(model, limitTokens) {
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) return;
  const prior = observedServerInputLimits.get(model);
  if (prior === void 0 || limitTokens < prior) {
    observedServerInputLimits.set(model, limitTokens);
    debugLogger.info(
      `observed server input limit for ${model}: ${limitTokens} tokens`
    );
  }
}
__name(recordObservedServerInputLimit, "recordObservedServerInputLimit");
function getObservedServerInputLimit(model) {
  return observedServerInputLimits.get(model);
}
__name(getObservedServerInputLimit, "getObservedServerInputLimit");
function resetObservedServerInputLimitsForTests() {
  observedServerInputLimits.clear();
}
__name(resetObservedServerInputLimitsForTests, "resetObservedServerInputLimitsForTests");
function* iterateParts(content) {
  for (const part of content.parts ?? []) {
    yield part;
    const nested = part.functionResponse?.parts;
    if (Array.isArray(nested)) {
      yield* nested;
    }
  }
}
__name(iterateParts, "iterateParts");
function collectOssMediaRefs(contents) {
  const byUri = /* @__PURE__ */ new Map();
  for (const content of contents) {
    for (const part of iterateParts(content)) {
      const fileData = part.fileData;
      if (!fileData?.fileUri?.startsWith(OSS_URL_PREFIX)) continue;
      if (byUri.has(fileData.fileUri)) continue;
      byUri.set(fileData.fileUri, {
        fileUri: fileData.fileUri,
        mimeType: fileData.mimeType ?? "",
        displayName: fileData.displayName ?? path.basename(fileData.fileUri)
      });
    }
  }
  return [...byUri.values()];
}
__name(collectOssMediaRefs, "collectOssMediaRefs");
function contentsHaveOssMedia(contents) {
  return contents.some((content) => {
    for (const part of iterateParts(content)) {
      if (part.fileData?.fileUri?.startsWith(OSS_URL_PREFIX)) return true;
    }
    return false;
  });
}
__name(contentsHaveOssMedia, "contentsHaveOssMedia");
async function findObjectPath(store, sha256) {
  const dir = path.join(store.getObjectsDir(), sha256.slice(0, 2));
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((name) => name.startsWith(sha256));
  return match ? path.join(dir, match) : null;
}
__name(findObjectPath, "findObjectPath");
function buildLadderPolicy(base, modality, attempt) {
  const ladder = REACTIVE_LADDERS[modality];
  const rung = ladder.steps[Math.min(attempt, ladder.steps.length - 1)];
  const args = base.toolName === ladder.toolName ? { ...base.arguments, ...rung } : base.arguments;
  return {
    ...base,
    id: `${base.id}.reactive-${attempt}`,
    when: void 0,
    onConditionUnavailable: "run",
    arguments: args,
    maxRunsPerLineage: 1,
    output: {
      reprocessMedia: false,
      source: "omit",
      artifacts: { "*": "include" }
    },
    stage: "transport_guard"
  };
}
__name(buildLadderPolicy, "buildLadderPolicy");
function applyOssMediaReplacements(contents, replacements) {
  let replacedParts = 0;
  const swapInParts = /* @__PURE__ */ __name((parts) => {
    const nextParts = [];
    let changed = false;
    for (const part of parts) {
      const uri = part.fileData?.fileUri;
      const replacement = uri ? replacements.get(uri) : void 0;
      if (replacement && part.fileData) {
        nextParts.push({ text: replacement.disclosureText });
        nextParts.push({
          fileData: {
            ...part.fileData,
            fileUri: replacement.fileUri,
            mimeType: replacement.mimeType
          }
        });
        replacedParts++;
        changed = true;
        continue;
      }
      const nested = part.functionResponse?.parts;
      if (Array.isArray(nested)) {
        const swappedNested = swapInParts(nested);
        if (swappedNested) {
          nextParts.push({
            ...part,
            functionResponse: {
              ...part.functionResponse,
              parts: swappedNested
            }
          });
          changed = true;
          continue;
        }
      }
      nextParts.push(part);
    }
    return changed ? nextParts : null;
  }, "swapInParts");
  for (const content of contents) {
    if (!content.parts?.length) continue;
    const swapped = swapInParts(content.parts);
    if (swapped) content.parts = swapped;
  }
  return replacedParts;
}
__name(applyOssMediaReplacements, "applyOssMediaReplacements");
async function degradeOmniMediaAfterServerReject(config, contents, attempt, options) {
  const none = {
    replacedParts: 0,
    degradedResources: 0
  };
  const signal = options?.signal;
  if (!isOmniDeliveryActive(config)) return none;
  const processingConfig = config.getOmniProcessingConfig?.();
  if (!processingConfig) return none;
  const refs = collectOssMediaRefs(contents);
  if (refs.length === 0) return none;
  const inferenceModel = config.getModel();
  if (options?.observedLimitTokens !== void 0) {
    recordObservedServerInputLimit(inferenceModel, options.observedLimitTokens);
  }
  const uploadConfig = requireEffectiveOmniUploadConfig(config);
  const uploadModel = uploadConfig.model;
  const store = new OmniObjectStore(config.storage.getQwenDir());
  const cacheScope = createHash("sha256").update(`${uploadConfig.baseUrl}|${uploadConfig.apiKey}`).digest("hex").slice(0, 16);
  const uploadCache = new OmniUploadCache(
    store.getOmniRootDir(),
    config.getOmniUploadUrlTtlHours?.() ?? DEFAULT_UPLOAD_CACHE_TTL_HOURS,
    cacheScope
  );
  const memoryConfig = config.getOmniMemoryConfig?.();
  const memoryService = memoryConfig ? new MediaMemoryService(store.getOmniRootDir(), {
    maxInlineTextBytes: memoryConfig.collection.maxInlineTextBytes
  }) : void 0;
  const replacements = /* @__PURE__ */ new Map();
  for (const ref of refs) {
    if (signal?.aborted) break;
    try {
      const sha256 = await uploadCache.findSha256ByUrl(ref.fileUri);
      if (!sha256) {
        debugLogger.debug(
          `no upload-cache mapping for ${ref.fileUri}; skipping`
        );
        continue;
      }
      const objectPath = await findObjectPath(store, sha256);
      if (!objectPath) {
        debugLogger.debug(
          `object ${sha256.slice(0, 12)}\u2026 not in store; skipping`
        );
        continue;
      }
      const recognized = await recognizeMediaFile(objectPath, { signal });
      const basePolicy = processingConfig.transportGuardPolicies.find(
        (p) => p.mediaTypes.includes(recognized.modality)
      );
      if (!basePolicy) continue;
      const policy = buildLadderPolicy(
        basePolicy,
        recognized.modality,
        attempt
      );
      const sourceBinding = memoryService ? await memoryService.findBindingBySha256(sha256) : void 0;
      const { deliveries } = await runFixedPolicies(
        config,
        {
          filePath: objectPath,
          recognized,
          displayName: ref.displayName,
          origin: "user",
          sha256
        },
        {
          store,
          policies: [policy],
          signal,
          limits: processingConfig.limits,
          memory: memoryService && sourceBinding ? { service: memoryService, sourceBinding } : void 0
        }
      );
      const delivery = deliveries[0];
      if (!delivery || delivery.filePath === objectPath) {
        debugLogger.debug(
          `reactive rung ${attempt} made no progress on ${ref.displayName}`
        );
        continue;
      }
      const derivedSha = delivery.sha256 ?? await hashFileSha256(delivery.filePath, signal);
      let fileUri = await uploadCache.get(derivedSha, uploadModel);
      if (!fileUri) {
        const { objectPath: derivedPath } = await store.putFile(
          delivery.filePath,
          derivedSha,
          extensionForMime(delivery.recognized.detectedMimeType),
          signal
        );
        const uploader = new DashScopeUploader({
          apiKey: uploadConfig.apiKey,
          baseUrl: uploadConfig.baseUrl
        });
        fileUri = await uploader.uploadFile({
          filePath: derivedPath,
          model: uploadModel,
          mimeType: delivery.recognized.detectedMimeType,
          signal
        });
        await uploadCache.put(derivedSha, uploadModel, fileUri);
      }
      if (fileUri === ref.fileUri) continue;
      const disclosureText = formatDisclosureText(
        ref.displayName,
        `${delivery.disclosure ?? "\u5DF2\u8FDB\u4E00\u6B65\u964D\u8D28"}\uFF08\u670D\u52A1\u7AEF\u8F93\u5165\u8D85\u9650\uFF0C\u7B2C ${attempt + 1} \u6B21\u964D\u8D28\u91CD\u8BD5\uFF09`
      );
      replacements.set(ref.fileUri, {
        fileUri,
        mimeType: delivery.recognized.detectedMimeType,
        disclosureText
      });
      debugLogger.info(
        `reactive degrade rung ${attempt}: ${ref.displayName} ${sha256.slice(0, 12)}\u2026 \u2192 ${derivedSha.slice(0, 12)}\u2026 (${recognized.modality})`
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      debugLogger.warn(
        `reactive degrade failed for ${ref.displayName}; skipping`,
        err
      );
    }
  }
  if (replacements.size === 0) return none;
  const replacedParts = applyOssMediaReplacements(contents, replacements);
  return { replacedParts, degradedResources: replacements.size };
}
__name(degradeOmniMediaAfterServerReject, "degradeOmniMediaAfterServerReject");
export {
  applyOssMediaReplacements,
  buildLadderPolicy,
  collectOssMediaRefs,
  contentsHaveOssMedia,
  degradeOmniMediaAfterServerReject,
  getObservedServerInputLimit,
  recordObservedServerInputLimit,
  resetObservedServerInputLimitsForTests
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
