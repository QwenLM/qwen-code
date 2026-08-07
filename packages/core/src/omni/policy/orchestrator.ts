/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import type { ToolCallRequestInfo } from '../../core/turn.js';
import type {
  MediaPolicyToolDescriptor,
  ToolArtifact,
} from '../../tools/tools.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { estimateRawResourceTokens } from '../estimation.js';
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile,
  type RecognizedMedia,
} from '../recognition.js';
import type { OmniObjectStore } from '../storage.js';
import {
  evaluateFixedPolicyCondition,
  type FixedPolicyConditionContext,
  type ResourceConditionField,
} from './conditions.js';
import {
  computePolicyFingerprint,
  OmniDegradationCache,
} from './degradation-cache.js';
import type { FixedPolicyOrigin, NormalizedFixedPolicy } from './types.js';

const debugLogger = createDebugLogger('omni:policy');

/** One resource in the final delivery set produced by the orchestrator. */
export interface PolicyDeliveryResource {
  /** Absolute path of the deliverable file (the original input, or a
   * promoted derivative inside `objects/`). */
  filePath: string;
  recognized: RecognizedMedia;
  /** Content hash when already known (always set for derivatives; set on
   * the source only if a policy run had to hash it). */
  sha256?: string;
  /** Disclosure that must accompany the resource (lossy derivatives). */
  disclosure?: string;
  /** True when the resource is a lossy derivative of the user's input. */
  degraded?: boolean;
}

/** Debug/telemetry record of one policy decision that did real work (or
 * failed to). Pure matching misses are deliberately unrecorded — with the
 * system defaults active on every delivery, zero-policy runs must stay
 * zero-noise. */
export interface PolicyRunRecord {
  policyId: string;
  toolName: string;
  outcome:
    | 'succeeded'
    | 'cache_hit'
    | 'no_op'
    | 'failed'
    | 'condition_unavailable';
  /** Display label of the resource the policy ran against. */
  resource: string;
  /** Fields that made a `when` condition undecidable. */
  missingFields?: string[];
  error?: string;
}

export interface RunFixedPoliciesOptions {
  store: OmniObjectStore;
  policies: NormalizedFixedPolicy[];
  signal?: AbortSignal;
  /** Request/session condition namespaces, when the caller has them. The
   * resource namespace is always derived from each item's recognition. */
  conditionContext?: Pick<FixedPolicyConditionContext, 'request' | 'session'>;
  /** Injectable for tests; defaults to the store-rooted cache. */
  degradationCache?: OmniDegradationCache;
}

/** Root resource entering the orchestrator. */
export interface PolicySourceResource {
  filePath: string;
  recognized: RecognizedMedia;
  /** User-recognizable name for records and error messages. */
  displayName: string;
  origin: Extract<FixedPolicyOrigin, 'user' | 'tool'>;
}

/** Thrown when a policy invocation fails and the failure must abort the
 * delivery (`onFailure: 'abort'`, or any transport-guard policy). */
export class OmniPolicyExecutionError extends Error {
  constructor(
    message: string,
    readonly policyId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OmniPolicyExecutionError';
  }
}

/** Work-queue item: a resource that may still be matched by policies. */
interface WorkItem {
  filePath: string;
  recognized: RecognizedMedia;
  label: string;
  origin: FixedPolicyOrigin;
  sha256?: string;
  disclosure?: string;
  degraded?: boolean;
  /** Per-derivation-chain run counts (policy id → runs). Copied — never
   * shared — on derivation, so sibling branches cap independently. */
  lineageRuns: Map<string, number>;
  deliver: boolean;
  /** Whether the item enters policy matching (`output.reprocessMedia`). */
  process: boolean;
}

/** Result of one actual policy execution. */
interface PolicyExecution {
  outcome: 'succeeded' | 'cache_hit' | 'no_op';
  derived: Array<{
    filePath: string;
    recognized: RecognizedMedia;
    sha256: string;
    disclosure?: string;
    degraded: boolean;
  }>;
}

function resourceConditionContext(
  recognized: RecognizedMedia,
  shared?: Pick<FixedPolicyConditionContext, 'request' | 'session'>,
): FixedPolicyConditionContext {
  const resource: Partial<Record<ResourceConditionField, number>> = {};
  const set = (
    field: ResourceConditionField,
    value: number | undefined,
  ): void => {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      resource[field] = value;
    }
  };
  const m = recognized.metadata;
  set('sizeBytes', recognized.sizeBytes);
  set('durationMs', m.durationMs);
  set('width', m.width);
  set('height', m.height);
  // The probe reports the (single) primary stream's dimensions, so the
  // max* aliases resolve to the same values.
  set('maxWidth', m.width);
  set('maxHeight', m.height);
  set('frameRate', m.frameRate);
  set('frameCount', m.frameCount);
  set('bitRate', m.bitRate);
  set('sampleRateHz', m.sampleRateHz);
  set('channels', m.channels);
  const estimate = estimateRawResourceTokens(recognized);
  if (estimate.status === 'ok') {
    set('estimatedTokenCount', estimate.estimatedTokenCount);
  }
  return { resource, ...shared };
}

/** Deterministic execution order: priority descending, id ascending. */
function sortPolicies(
  policies: NormalizedFixedPolicy[],
): NormalizedFixedPolicy[] {
  return [...policies].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
}

/**
 * Run the fixed-policy pipeline over one recognized media resource
 * (decisions D1/D3/D5): match each policy in priority order, execute the
 * matched media-policy tool through the ordinary scheduler path inside an
 * exclusive staging directory, validate the artifacts against the tool's
 * descriptor, promote them into the content-addressed store, and return
 * the final delivery set plus records of the work performed.
 *
 * Termination is structural: each policy runs at most `maxRunsPerLineage`
 * times per derivation chain and the policy set is finite, so the derived
 * tree is finite (global budgets are the next commit's backstop).
 *
 * Failure semantics (decision D10): a failed invocation never leaves
 * partial state (its staging dir is removed); `onFailure: 'continue'`
 * keeps the source in the delivery set (the transport guard remains the
 * backstop), while `'abort'` — and any transport-guard-stage failure —
 * throws {@link OmniPolicyExecutionError}.
 */
export async function runFixedPolicies(
  config: Config,
  source: PolicySourceResource,
  options: RunFixedPoliciesOptions,
): Promise<{
  deliveries: PolicyDeliveryResource[];
  records: PolicyRunRecord[];
}> {
  const policies = sortPolicies(options.policies);
  const cache =
    options.degradationCache ??
    new OmniDegradationCache(options.store.getOmniRootDir());
  const records: PolicyRunRecord[] = [];
  const items: WorkItem[] = [
    {
      filePath: source.filePath,
      recognized: source.recognized,
      label: source.displayName,
      origin: source.origin,
      lineageRuns: new Map(),
      deliver: true,
      process: true,
    },
  ];

  // Index-based: executions append derived items behind the cursor.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.process) continue;
    for (const policy of policies) {
      if (!policy.mediaTypes.includes(item.recognized.modality)) continue;
      if (!policy.origins.includes(item.origin)) continue;
      const runs = item.lineageRuns.get(policy.id) ?? 0;
      if (runs >= policy.maxRunsPerLineage) continue;
      if (policy.when) {
        const evaluation = evaluateFixedPolicyCondition(
          policy.when,
          resourceConditionContext(item.recognized, options.conditionContext),
        );
        if (evaluation.outcome === 'no_match') continue;
        if (
          evaluation.outcome === 'unavailable' &&
          policy.onConditionUnavailable === 'skip'
        ) {
          records.push({
            policyId: policy.id,
            toolName: policy.toolName,
            outcome: 'condition_unavailable',
            resource: item.label,
            missingFields: evaluation.missingFields,
          });
          continue;
        }
        // 'unavailable' + onConditionUnavailable 'run' falls through.
      }
      item.lineageRuns.set(policy.id, runs + 1);
      try {
        const execution = await executePolicy(
          config,
          item,
          policy,
          options.store,
          cache,
          options.signal,
        );
        records.push({
          policyId: policy.id,
          toolName: policy.toolName,
          outcome: execution.outcome,
          resource: item.label,
        });
        if (execution.outcome === 'no_op') continue;
        if (policy.output.source === 'omit') item.deliver = false;
        for (const derived of execution.derived) {
          items.push({
            ...derived,
            label: `${item.label} → ${policy.id}`,
            origin: 'policy',
            lineageRuns: new Map(item.lineageRuns),
            deliver: true,
            process: policy.output.reprocessMedia,
          });
        }
      } catch (err) {
        if (options.signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        records.push({
          policyId: policy.id,
          toolName: policy.toolName,
          outcome: 'failed',
          resource: item.label,
          error: message,
        });
        debugLogger.debug(
          `fixed policy ${policy.id} (${policy.toolName}) failed on ${item.label}: ${message}`,
        );
        if (
          policy.onFailure === 'abort' ||
          policy.stage === 'transport_guard'
        ) {
          throw new OmniPolicyExecutionError(
            `Fixed policy ${policy.id} failed: ${message}`,
            policy.id,
            { cause: err },
          );
        }
        // 'continue': the source stays in the delivery set; the transport
        // guard remains the backstop for oversized content.
      }
    }
  }

  return {
    deliveries: items
      .filter((item) => item.deliver)
      .map((item) => ({
        filePath: item.filePath,
        recognized: item.recognized,
        sha256: item.sha256,
        disclosure: item.disclosure,
        degraded: item.degraded,
      })),
    records,
  };
}

/** Validated view of one artifact after descriptor/staging checks. */
interface ValidatedArtifact {
  absolutePath: string;
  recognized: RecognizedMedia;
  sha256: string;
  disclosure?: string;
  lossy: boolean;
}

/**
 * Execute one policy against one work item: degradation-cache lookup,
 * otherwise a real tool invocation in a fresh staging directory followed
 * by artifact validation and promotion (staging lifecycle §5, order D12:
 * promote first, then substitute, then delete staging).
 */
async function executePolicy(
  config: Config,
  item: WorkItem,
  policy: NormalizedFixedPolicy,
  store: OmniObjectStore,
  cache: OmniDegradationCache,
  signal: AbortSignal | undefined,
): Promise<PolicyExecution> {
  const tool = config.getToolRegistry().getTool(policy.toolName);
  const descriptor = tool?.mediaPolicyDescriptor;
  if (!descriptor) {
    throw new Error(
      `tool ${policy.toolName} is not a registered media-policy tool`,
    );
  }

  // The source hash keys the degradation cache; computed lazily so runs
  // without matching policies never pay it.
  item.sha256 ??= await hashFileSha256(item.filePath, signal);
  const fingerprint = computePolicyFingerprint(
    policy.toolName,
    policy.arguments,
  );
  const hit = await cache.get(item.sha256, fingerprint);
  if (hit) {
    const objectPath = store.objectPathFor(hit.degradedSha256, hit.extension);
    const stat = await fs.lstat(objectPath).catch(() => undefined);
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const recognized = await recognizeMediaFile(objectPath, { signal });
      debugLogger.debug(
        `degradation cache hit: policy=${policy.id} sha256=${item.sha256.slice(0, 12)}…`,
      );
      return {
        outcome: 'cache_hit',
        derived: [
          {
            filePath: objectPath,
            recognized,
            sha256: hit.degradedSha256,
            disclosure: hit.disclosure,
            degraded: true,
          },
        ],
      };
    }
    // Stale: the derivative left the store (GC, manual deletion). Drop
    // every entry pointing at it and re-transcode.
    await cache.removeByDegradedSha256(hit.degradedSha256);
  }

  const invocationId = randomBytes(8).toString('hex');
  const stagingDir = await store.createStagingDir(invocationId);
  try {
    const request: ToolCallRequestInfo = {
      callId: invocationId,
      name: policy.toolName,
      args: {
        ...policy.arguments,
        inputPath: item.filePath,
        outputDir: stagingDir,
      },
      isClientInitiated: true,
      prompt_id: `omni-fixed-policy-${invocationId}`,
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: policy.id,
        stage: policy.stage,
      },
    };
    // Dynamic import: the executor pulls in the scheduler, whose module
    // graph reaches back into omni surfaces — the runtime dependency is
    // resolved at call time (same pattern as the scheduler's tool-result
    // funnel import) to keep module evaluation cycle-free.
    const { executeToolCall } = await import(
      '../../core/nonInteractiveToolExecutor.js'
    );
    const response = await executeToolCall(
      config,
      request,
      signal ?? new AbortController().signal,
      { recordToolResult: false },
    );
    if (response.error) {
      throw new Error(response.error.message, { cause: response.error });
    }
    const batch = response.policyArtifacts;
    if (!batch || batch.artifacts.length === 0) {
      throw new Error(
        `tool ${policy.toolName} succeeded but produced no policy artifacts`,
      );
    }

    const validated: ValidatedArtifact[] = [];
    for (const artifact of batch.artifacts) {
      validated.push(
        await validateArtifact(artifact, descriptor, stagingDir, signal),
      );
    }
    assertRequiredOutputsPresent(descriptor, validated, policy.toolName);

    // Fixed-point: identical output means this iteration changed nothing —
    // deliver the source and stop deriving (no cache entry either; a no-op
    // is a property of this input, re-derivable cheaply).
    if (validated.every((a) => a.sha256 === item.sha256)) {
      return { outcome: 'no_op', derived: [] };
    }

    // Promotion first (D12): once an artifact is in objects/ it is
    // content-addressed and immutable; only then substitute + cache.
    const derived: PolicyExecution['derived'] = [];
    for (const artifact of validated) {
      const extension = extensionForMime(artifact.recognized.detectedMimeType);
      const put = await store.putFile(
        artifact.absolutePath,
        artifact.sha256,
        extension,
        signal,
      );
      derived.push({
        filePath: put.objectPath,
        recognized: artifact.recognized,
        sha256: artifact.sha256,
        disclosure: artifact.disclosure,
        degraded: artifact.lossy,
      });
    }
    // The cache maps one input to ONE derivative; multi-output tools are
    // simply not cached (re-run instead of guessing which output to key).
    if (validated.length === 1 && validated[0].disclosure) {
      await cache.put(item.sha256, fingerprint, {
        degradedSha256: validated[0].sha256,
        extension: extensionForMime(validated[0].recognized.detectedMimeType),
        disclosure: validated[0].disclosure,
        mimeType: validated[0].recognized.detectedMimeType,
      });
    }
    return { outcome: 'succeeded', derived };
  } finally {
    // Success and failure both end without a staging dir (this commit's
    // Stage A behavior; quarantine-on-failure is the Stage B follow-up).
    await store.removeStagingDir(invocationId).catch(() => {});
  }
}

/**
 * Validate one artifact against the staging contract (§5) and the tool's
 * descriptor (D8): workspace-storage with a path strictly inside the
 * staging dir, a regular non-symlink file, recognized content matching a
 * declared media output, and — for lossy outputs — a non-empty
 * `metadata.omniDisclosure`.
 */
async function validateArtifact(
  artifact: ToolArtifact,
  descriptor: MediaPolicyToolDescriptor,
  stagingDir: string,
  signal: AbortSignal | undefined,
): Promise<ValidatedArtifact> {
  if (artifact.storage !== 'workspace' || !artifact.workspacePath) {
    throw new Error(
      `policy artifact "${artifact.title}" is not a workspace file`,
    );
  }
  const absolutePath = path.resolve(stagingDir, artifact.workspacePath);
  if (!absolutePath.startsWith(stagingDir + path.sep)) {
    throw new Error(
      `policy artifact "${artifact.title}" escapes the staging directory`,
    );
  }
  const stat = await fs.lstat(absolutePath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `policy artifact "${artifact.title}" is missing or not a regular file`,
    );
  }
  // Authoritative recognition of the actual bytes — the tool's declared
  // mimeType/kind are cross-checked, never trusted.
  const recognized = await recognizeMediaFile(absolutePath, { signal });
  const spec = descriptor.outputs.find(
    (o) =>
      o.kind === 'media' && o.mimeTypes?.includes(recognized.detectedMimeType),
  );
  if (!spec) {
    throw new Error(
      `policy artifact "${artifact.title}" has undeclared media type ${recognized.detectedMimeType}`,
    );
  }
  if (artifact.kind !== recognized.modality) {
    throw new Error(
      `policy artifact "${artifact.title}" declares kind ${String(artifact.kind)} but contains ${recognized.modality} content`,
    );
  }
  const disclosure = artifact.metadata?.['omniDisclosure'];
  if (spec.lossy && (typeof disclosure !== 'string' || disclosure === '')) {
    throw new Error(
      `policy artifact "${artifact.title}" is lossy but carries no omniDisclosure`,
    );
  }
  return {
    absolutePath,
    recognized,
    sha256: await hashFileSha256(absolutePath, signal),
    disclosure:
      typeof disclosure === 'string' && disclosure ? disclosure : undefined,
    lossy: spec.lossy === true,
  };
}

/** Every required media output declared by the descriptor must have been
 * produced (§5 completeness check). */
function assertRequiredOutputsPresent(
  descriptor: MediaPolicyToolDescriptor,
  validated: ValidatedArtifact[],
  toolName: string,
): void {
  for (const spec of descriptor.outputs) {
    if (spec.kind !== 'media' || !spec.required) continue;
    const produced = validated.some((a) =>
      spec.mimeTypes?.includes(a.recognized.detectedMimeType),
    );
    if (!produced) {
      throw new Error(
        `tool ${toolName} did not produce its required ${spec.mimeTypes?.join('/') ?? 'media'} output`,
      );
    }
  }
}
