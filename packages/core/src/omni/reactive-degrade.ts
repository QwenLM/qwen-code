/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reactive server-limit fallback (issue: server-feedback-driven transport
 * guard): when the provider rejects a request as over its REAL input
 * limit (e.g. DashScope `Range of input length should be [1, 196608]`),
 * the session must not abort — the delivered omni media is degraded
 * further and the request retried.
 *
 * Why this exists: the local token estimator cannot predict server-side
 * media billing (measured: qwen3.5-omni-plus bills video per SAMPLED
 * FRAME, resolution-normalized, ~4fps sampling cap — so the default
 * guard downscale of 480p/10fps does NOT reduce billed tokens, while
 * sub-1fps rates do). The server's own 400 is therefore the only
 * reliable over-limit signal, and this module turns it into another
 * transport-guard pass with an escalating argument ladder instead of a
 * session-fatal error.
 *
 * Flow per rejected oss:// media part:
 *   oss URL → upload-cache reverse lookup (sha256) → objects/ file →
 *   transport-guard policy with ladder-escalated arguments →
 *   promoted derivative → re-upload → fileUri swap in the chat history
 *   (with a fresh disclosure Part, decision D8).
 *
 * Everything here is best-effort: any failure returns "no progress" and
 * the original server error propagates through the existing fail paths.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { ToolNames } from '../tools/tool-names.js';
import { OmniObjectStore } from './storage.js';
import {
  OmniUploadCache,
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
} from './upload-cache.js';
import { DashScopeUploader, OSS_URL_PREFIX } from './upload.js';
import {
  recognizeMediaFile,
  hashFileSha256,
  extensionForMime,
  type OmniModality,
} from './recognition.js';
import { runFixedPolicies } from './policy/orchestrator.js';
import type { NormalizedFixedPolicy } from './policy/types.js';
import { formatDisclosureText } from './disclosure.js';
import { isOmniDeliveryActive } from './index.js';

const debugLogger = createDebugLogger('omni:reactive-degrade');

/**
 * Escalation ladders per modality: argument overrides merged over the
 * configured transport-guard policy's arguments, one rung per retry
 * attempt. Grounded in measured server billing (see module doc):
 *
 * - video: fps is the only effective lever below the ~4fps sampling cap
 *   (~148 tokens per sampled frame, resolution-normalized), so the
 *   ladder drives fps down aggressively; maxHeight mainly bounds upload
 *   size.
 * - image: billed per normalized resolution — shrink the longest edge.
 * - audio: billed per second (duration is fixed), so the ladder only
 *   shrinks transfer size; it cannot shrink billed tokens.
 *
 * Attempts beyond the last rung reuse the last rung (the no-progress
 * check upstream then stops the loop).
 */
const REACTIVE_LADDERS: Record<
  OmniModality,
  { toolName: string; steps: ReadonlyArray<Record<string, unknown>> }
> = {
  video: {
    toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
    steps: [
      { maxHeight: 480, fps: 2 },
      { maxHeight: 360, fps: 0.5 },
      { maxHeight: 360, fps: 0.25 },
    ],
  },
  image: {
    toolName: ToolNames.OMNI_DOWNSAMPLE_IMAGE,
    steps: [
      { maxDimension: 1024, quality: 70 },
      { maxDimension: 640, quality: 60 },
      { maxDimension: 448, quality: 50 },
    ],
  },
  audio: {
    toolName: ToolNames.OMNI_DOWNSAMPLE_AUDIO,
    steps: [
      { bitrateKbps: 32, sampleRateHz: 16000, channels: 1 },
      { bitrateKbps: 16, sampleRateHz: 16000, channels: 1 },
      { bitrateKbps: 12, sampleRateHz: 8000, channels: 1 },
    ],
  },
};

/** Per-model server input limits observed from real rejections this
 * session. Currently informational (logs/telemetry); a future guard can
 * consume it as a calibrated ceiling. */
const observedServerInputLimits = new Map<string, number>();

export function recordObservedServerInputLimit(
  model: string,
  limitTokens: number,
): void {
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) return;
  const prior = observedServerInputLimits.get(model);
  if (prior === undefined || limitTokens < prior) {
    observedServerInputLimits.set(model, limitTokens);
    debugLogger.info(
      `observed server input limit for ${model}: ${limitTokens} tokens`,
    );
  }
}

export function getObservedServerInputLimit(model: string): number | undefined {
  return observedServerInputLimits.get(model);
}

export function resetObservedServerInputLimitsForTests(): void {
  observedServerInputLimits.clear();
}

/** Outcome of one reactive degradation pass. */
export interface OmniReactiveDegradeOutcome {
  /** fileData parts whose fileUri was swapped to a degraded derivative. */
  replacedParts: number;
  /** Distinct source objects degraded and re-uploaded. */
  degradedResources: number;
}

interface OssMediaRef {
  fileUri: string;
  mimeType: string;
  displayName: string;
}

/** Collect the distinct oss:// media deliveries present in `contents`. */
export function collectOssMediaRefs(contents: Content[]): OssMediaRef[] {
  const byUri = new Map<string, OssMediaRef>();
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      const fileData = part.fileData;
      if (!fileData?.fileUri?.startsWith(OSS_URL_PREFIX)) continue;
      if (byUri.has(fileData.fileUri)) continue;
      byUri.set(fileData.fileUri, {
        fileUri: fileData.fileUri,
        mimeType: fileData.mimeType ?? '',
        displayName: fileData.displayName ?? path.basename(fileData.fileUri),
      });
    }
  }
  return [...byUri.values()];
}

/** Whether a retry-with-degradation is even applicable to this request. */
export function contentsHaveOssMedia(contents: Content[]): boolean {
  return contents.some((content) =>
    content.parts?.some((part) =>
      part.fileData?.fileUri?.startsWith(OSS_URL_PREFIX),
    ),
  );
}

/** Locate the content-addressed object file for a hash (extension is not
 * recorded in the upload cache, so scan the two-level fanout dir). */
async function findObjectPath(
  store: OmniObjectStore,
  sha256: string,
): Promise<string | null> {
  const dir = path.join(store.getObjectsDir(), sha256.slice(0, 2));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((name) => name.startsWith(sha256));
  return match ? path.join(dir, match) : null;
}

/** Transport-guard policy for the modality with the ladder rung merged
 * in. Overrides only apply when the configured policy actually uses the
 * modality's default degradation tool — a custom guard tool keeps its own
 * arguments (re-running it unchanged is then caught as no-progress).
 * Exported for direct unit testing. */
export function buildLadderPolicy(
  base: NormalizedFixedPolicy,
  modality: OmniModality,
  attempt: number,
): NormalizedFixedPolicy {
  const ladder = REACTIVE_LADDERS[modality];
  const rung = ladder.steps[Math.min(attempt, ladder.steps.length - 1)];
  const args =
    base.toolName === ladder.toolName
      ? { ...base.arguments, ...rung }
      : base.arguments;
  return {
    ...base,
    id: `${base.id}.reactive-${attempt}`,
    when: undefined,
    onConditionUnavailable: 'run',
    arguments: args,
    maxRunsPerLineage: 1,
    output: {
      reprocessMedia: false,
      source: 'omit',
      artifacts: { '*': 'include' },
    },
    stage: 'transport_guard',
  };
}

/** One replacement produced by the degradation loop. */
export interface OssMediaReplacement {
  fileUri: string;
  mimeType: string;
  disclosureText: string;
}

/**
 * In-place history swap: replace each fileData part whose fileUri is in
 * `replacements` with [disclosure text Part, degraded fileData Part].
 * Disclosure precedes the media Part — the ordering the provider
 * converters key on. Returns the number of parts swapped. Exported for
 * direct unit testing.
 */
export function applyOssMediaReplacements(
  contents: Content[],
  replacements: Map<string, OssMediaReplacement>,
): number {
  let replacedParts = 0;
  for (const content of contents) {
    if (!content.parts?.length) continue;
    const nextParts: Part[] = [];
    let changed = false;
    for (const part of content.parts) {
      const uri = part.fileData?.fileUri;
      const replacement = uri ? replacements.get(uri) : undefined;
      if (!replacement || !part.fileData) {
        nextParts.push(part);
        continue;
      }
      nextParts.push({ text: replacement.disclosureText });
      nextParts.push({
        fileData: {
          ...part.fileData,
          fileUri: replacement.fileUri,
          mimeType: replacement.mimeType,
        },
      });
      replacedParts++;
      changed = true;
    }
    if (changed) content.parts = nextParts;
  }
  return replacedParts;
}

/**
 * Degrade every oss:// media delivery found in `contents` one ladder rung
 * further and swap the parts in place (fileUri + mimeType + a fresh
 * disclosure Part inserted before the media, decision D8). `contents`
 * must be the live chat history: the swap must persist so follow-up
 * turns keep fitting under the server limit.
 *
 * Best-effort by contract: returns the outcome of whatever progressed;
 * a resource that cannot be reverse-mapped, re-derived, or re-uploaded
 * is skipped. `replacedParts === 0` tells the caller to stop retrying
 * and let the original server error propagate. Only abort errors throw.
 */
export async function degradeOmniMediaAfterServerReject(
  config: Config,
  contents: Content[],
  attempt: number,
  options?: {
    signal?: AbortSignal;
    /** Server-reported input ceiling parsed from the rejection. */
    observedLimitTokens?: number;
  },
): Promise<OmniReactiveDegradeOutcome> {
  const none: OmniReactiveDegradeOutcome = {
    replacedParts: 0,
    degradedResources: 0,
  };
  const signal = options?.signal;
  if (!isOmniDeliveryActive(config)) return none;
  const processingConfig = config.getOmniProcessingConfig?.();
  if (!processingConfig) return none;
  const refs = collectOssMediaRefs(contents);
  if (refs.length === 0) return none;

  const model = config.getModel();
  if (options?.observedLimitTokens !== undefined) {
    recordObservedServerInputLimit(model, options.observedLimitTokens);
  }

  const cgc = config.getContentGeneratorConfig();
  const store = new OmniObjectStore(config.storage.getQwenDir());
  // Same scope fingerprint as the delivery pipeline: entries minted for
  // one (origin, apiKey) pair never serve another.
  const cacheScope = createHash('sha256')
    .update(`${cgc.baseUrl ?? ''}|${cgc.apiKey ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const uploadCache = new OmniUploadCache(
    store.getOmniRootDir(),
    config.getOmniUploadUrlTtlHours?.() ?? DEFAULT_UPLOAD_CACHE_TTL_HOURS,
    cacheScope,
  );

  // old fileUri → replacement delivery.
  const replacements = new Map<string, OssMediaReplacement>();

  for (const ref of refs) {
    if (signal?.aborted) break;
    try {
      const sha256 = await uploadCache.findSha256ByUrl(ref.fileUri);
      if (!sha256) {
        debugLogger.debug(
          `no upload-cache mapping for ${ref.fileUri}; skipping`,
        );
        continue;
      }
      const objectPath = await findObjectPath(store, sha256);
      if (!objectPath) {
        debugLogger.debug(
          `object ${sha256.slice(0, 12)}… not in store; skipping`,
        );
        continue;
      }
      const recognized = await recognizeMediaFile(objectPath, { signal });
      const basePolicy = processingConfig.transportGuardPolicies.find((p) =>
        p.mediaTypes.includes(recognized.modality),
      );
      if (!basePolicy) continue;
      const policy = buildLadderPolicy(
        basePolicy,
        recognized.modality,
        attempt,
      );
      const { deliveries } = await runFixedPolicies(
        config,
        {
          filePath: objectPath,
          recognized,
          displayName: ref.displayName,
          origin: 'user',
        },
        {
          store,
          policies: [policy],
          signal,
          limits: processingConfig.limits,
        },
      );
      const delivery = deliveries[0];
      if (!delivery || delivery.filePath === objectPath) {
        debugLogger.debug(
          `reactive rung ${attempt} made no progress on ${ref.displayName}`,
        );
        continue;
      }

      const derivedSha =
        delivery.sha256 ?? (await hashFileSha256(delivery.filePath, signal));
      let fileUri = await uploadCache.get(derivedSha, model);
      if (!fileUri) {
        const { objectPath: derivedPath } = await store.putFile(
          delivery.filePath,
          derivedSha,
          extensionForMime(delivery.recognized.detectedMimeType),
          signal,
        );
        const uploader = new DashScopeUploader({
          apiKey: cgc.apiKey ?? '',
          baseUrl: cgc.baseUrl,
        });
        fileUri = await uploader.uploadFile({
          filePath: derivedPath,
          model,
          mimeType: delivery.recognized.detectedMimeType,
          signal,
        });
        await uploadCache.put(derivedSha, model, fileUri);
      }
      if (fileUri === ref.fileUri) continue; // no progress

      const disclosureText = formatDisclosureText(
        ref.displayName,
        `${delivery.disclosure ?? '已进一步降质'}（服务端输入超限，第 ${attempt + 1} 次降质重试）`,
      );
      replacements.set(ref.fileUri, {
        fileUri,
        mimeType: delivery.recognized.detectedMimeType,
        disclosureText,
      });
      debugLogger.info(
        `reactive degrade rung ${attempt}: ${ref.displayName} ` +
          `${sha256.slice(0, 12)}… → ${derivedSha.slice(0, 12)}… (${recognized.modality})`,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      debugLogger.warn(
        `reactive degrade failed for ${ref.displayName}; skipping`,
        err,
      );
    }
  }

  if (replacements.size === 0) return none;

  const replacedParts = applyOssMediaReplacements(contents, replacements);

  return { replacedParts, degradedResources: replacements.size };
}
