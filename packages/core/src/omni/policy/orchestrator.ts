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
import { DEFAULT_OMNI_PROCESSING_LIMITS } from './config.js';
import type {
  FixedPolicyOrigin,
  NormalizedFixedPolicy,
  NormalizedOmniProcessingLimits,
} from './types.js';

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
    | 'condition_unavailable'
    | 'budget_exhausted';
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
  /** Per-root derivation budgets (decision D11); the system defaults
   * apply when the caller has no normalized processing config. */
  limits?: NormalizedOmniProcessingLimits;
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
  /** Derivation-chain length from the root (root = 0). */
  depth: number;
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

/** Per-omni-root counting semaphore bounding how many resources are
 * inside fixed-policy processing at once (`maxConcurrentResources`,
 * decision D11). Keyed by omni root so distinct stores in one process
 * (multi-project setups, tests) never throttle each other. Callers of
 * one root share a config, so the per-call limit is stable per key. */
const resourceGates = new Map<
  string,
  { active: number; waiters: Array<() => void> }
>();

/**
 * Take one processing slot for `rootDir`, waiting FIFO when `limit` are
 * already taken. Returns an idempotent release function. On release the
 * slot transfers directly to the next waiter (no decrement/re-increment
 * gap another caller could slip through), so at most `limit` holders
 * ever run concurrently.
 */
async function acquireResourceSlot(
  rootDir: string,
  limit: number,
): Promise<() => void> {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  let gate = resourceGates.get(rootDir);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    resourceGates.set(rootDir, gate);
  }
  const heldGate = gate;
  if (heldGate.active >= effectiveLimit) {
    await new Promise<void>((resolve) => heldGate.waiters.push(resolve));
    // Slot transferred by the releaser — `active` already counts us.
  } else {
    heldGate.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = heldGate.waiters.shift();
    if (next) {
      next();
      return;
    }
    heldGate.active--;
    if (heldGate.active === 0 && heldGate.waiters.length === 0) {
      resourceGates.delete(rootDir);
    }
  };
}

/**
 * Run the fixed-policy pipeline over one recognized media resource
 * (decisions D1/D3/D5): match each policy in priority order, execute the
 * matched media-policy tool through the ordinary scheduler path inside an
 * exclusive staging directory, validate the artifacts against the tool's
 * descriptor, promote them into the content-addressed store, and return
 * the final delivery set plus records of the work performed.
 *
 * Termination is structural AND budgeted: each policy runs at most
 * `maxRunsPerLineage` times per derivation chain and the policy set is
 * finite, so the derived tree is finite; on top of that the per-root
 * budgets (decision D11 — `maxPolicyRunsPerRoot`, `maxArtifactsPerRoot`,
 * `maxDerivedBytesPerRoot`, `maxLineageDepth`) stop further derivation
 * when exceeded. A budget stop is not a failure: already-committed
 * delivery decisions stand (no rollback), the stop is recorded with the
 * exhausted budget as its reason, and the transport guard still judges
 * the final set.
 *
 * Failure semantics (decision D10): a failed invocation never leaves
 * partial state in staging/ — its staging directory is moved to
 * quarantine/ with a `reason.json` for postmortem (Stage B; sweeps apply
 * retention). `onFailure: 'continue'` keeps the source in the delivery
 * set (the transport guard remains the backstop), while `'abort'` — and
 * any transport-guard-stage failure — throws
 * {@link OmniPolicyExecutionError}.
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
  const limits = options.limits ?? DEFAULT_OMNI_PROCESSING_LIMITS;
  // `maxConcurrentResources` (decision D11): each call processes one
  // root, so bounding concurrent calls per omni root bounds simultaneous
  // transcode work (ffmpeg/sharp processes, staging disk churn).
  const releaseSlot = await acquireResourceSlot(
    options.store.getOmniRootDir(),
    limits.maxConcurrentResources,
  );
  try {
    return await runFixedPoliciesUnbounded(config, source, options, {
      policies,
      limits,
    });
  } finally {
    releaseSlot();
  }
}

/** Body of {@link runFixedPolicies}, after the per-root concurrency slot
 * has been taken. */
async function runFixedPoliciesUnbounded(
  config: Config,
  source: PolicySourceResource,
  options: RunFixedPoliciesOptions,
  normalized: {
    policies: NormalizedFixedPolicy[];
    limits: NormalizedOmniProcessingLimits;
  },
): Promise<{
  deliveries: PolicyDeliveryResource[];
  records: PolicyRunRecord[];
}> {
  const { policies, limits } = normalized;
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
      depth: 0,
      deliver: true,
      process: true,
    },
  ];

  // Per-root budget counters (decision D11). One runFixedPolicies call
  // processes exactly one root, so the counters live here.
  let runsUsed = 0;
  let artifactsProduced = 0;
  let derivedBytesProduced = 0;
  let budgetExhausted = false;
  const stopOnBudget = (
    policy: NormalizedFixedPolicy,
    item: WorkItem,
    reason: string,
  ): void => {
    budgetExhausted = true;
    records.push({
      policyId: policy.id,
      toolName: policy.toolName,
      outcome: 'budget_exhausted',
      resource: item.label,
      error: reason,
    });
    debugLogger.debug(
      `per-root policy budget exhausted on ${item.label}: ${reason}; ` +
        `no further derivation for this root (committed deliveries stand)`,
    );
  };

  // Index-based: executions append derived items behind the cursor.
  for (let i = 0; i < items.length && !budgetExhausted; i++) {
    const item = items[i];
    if (!item.process) continue;
    // D9: animated images (frameCount > 1) never enter image-policy
    // matching — sharp multi-frame re-encoding is out of scope, and a
    // silent single-frame flattening must be impossible. An over-limit
    // animated image is handled by the transport guard's explicit
    // fail-closed omission instead. Still images are unaffected: probes
    // report no frameCount for them, which reads as a single frame.
    if (
      item.recognized.modality === 'image' &&
      (item.recognized.metadata.frameCount ?? 1) > 1
    ) {
      debugLogger.debug(
        `animated image ${item.label} ` +
          `(${item.recognized.metadata.frameCount} frames) excluded from ` +
          `policy matching (D9)`,
      );
      continue;
    }
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
      if (runsUsed >= limits.maxPolicyRunsPerRoot) {
        stopOnBudget(
          policy,
          item,
          `maxPolicyRunsPerRoot (${limits.maxPolicyRunsPerRoot}) reached`,
        );
        break;
      }
      runsUsed++;
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
        const childDepth = item.depth + 1;
        const depthAllowsReprocess = childDepth < limits.maxLineageDepth;
        if (policy.output.reprocessMedia && !depthAllowsReprocess) {
          debugLogger.debug(
            `maxLineageDepth (${limits.maxLineageDepth}) reached under ${item.label}; ` +
              `derivatives deliver but do not re-enter policy matching`,
          );
        }
        for (const derived of execution.derived) {
          artifactsProduced++;
          derivedBytesProduced += derived.recognized.sizeBytes;
          items.push({
            ...derived,
            label: `${item.label} → ${policy.id}`,
            origin: 'policy',
            lineageRuns: new Map(item.lineageRuns),
            depth: childDepth,
            deliver: true,
            process: policy.output.reprocessMedia && depthAllowsReprocess,
          });
        }
        if (artifactsProduced > limits.maxArtifactsPerRoot) {
          stopOnBudget(
            policy,
            item,
            `maxArtifactsPerRoot (${limits.maxArtifactsPerRoot}) exceeded`,
          );
          break;
        }
        if (derivedBytesProduced > limits.maxDerivedBytesPerRoot) {
          stopOnBudget(
            policy,
            item,
            `maxDerivedBytesPerRoot (${limits.maxDerivedBytesPerRoot}) exceeded`,
          );
          break;
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
 * Tool-level tunable defaults from
 * `omni.processing.policyTools.<tool>.settings`. The map is raw settings
 * input (values may be null tombstones or malformed — see
 * `OmniPolicyToolsSettings` in types.ts), so anything non-conforming
 * reads as "no defaults" rather than throwing mid-run.
 */
function resolveToolSettingsDefaults(
  config: Config,
  toolName: string,
): Record<string, unknown> {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const settings = entry?.settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return settings;
  }
  return {};
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
  // Effective tunables: tool-level defaults from
  // `omni.processing.policyTools.<tool>.settings` (validated against the
  // descriptor's settingsSchema at startup) underneath the policy's own
  // arguments. Merged HERE — the single point feeding both the tool call
  // and the cache fingerprint — so a settings change also invalidates
  // cached derivatives produced under the old values.
  const settingsDefaults = resolveToolSettingsDefaults(config, policy.toolName);
  const effectiveArguments = { ...settingsDefaults, ...policy.arguments };
  const fingerprint = computePolicyFingerprint(
    policy.toolName,
    effectiveArguments,
    descriptor.version,
  );
  const hit = await cache.get(item.sha256, fingerprint);
  if (hit) {
    try {
      const objectPath = store.objectPathFor(hit.degradedSha256, hit.extension);
      const stat = await fs.lstat(objectPath).catch(() => undefined);
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        // Content verification before reuse: the cache file lives in the
        // workspace and is only shape-validated on load, so the bytes at
        // the addressed path must actually hash to the entry's identity —
        // otherwise a poisoned cache (or a corrupted store) would silently
        // substitute foreign media as "the degraded derivative".
        const actualSha256 = await hashFileSha256(objectPath, signal);
        if (actualSha256 === hit.degradedSha256) {
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
      }
    } catch (err) {
      // Verification errors (hash/probe I/O races, a hostile entry whose
      // components objectPathFor rejects) must not abort the run: the
      // entry is dropped below and the policy re-transcodes from source.
      // A caller abort is not a verification failure — propagate it.
      if (signal?.aborted) throw err;
      debugLogger.debug(
        `degradation cache hit could not be verified for policy=${policy.id}: ` +
          `${err instanceof Error ? err.message : String(err)}; ` +
          `dropping the entry and re-transcoding`,
      );
    }
    // Stale, mismatching, or unverifiable: the derivative left the store
    // (GC, manual deletion) or its bytes no longer match the entry. Drop
    // every entry pointing at it and re-transcode.
    await cache.removeByDegradedSha256(hit.degradedSha256);
  }

  const invocationId = randomBytes(8).toString('hex');
  const stagingDir = await store.createStagingDir(invocationId);
  let failure: unknown;
  try {
    const request: ToolCallRequestInfo = {
      callId: invocationId,
      name: policy.toolName,
      args: {
        ...effectiveArguments,
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
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (failure === undefined || signal?.aborted) {
      // Success, no_op, and user aborts end without a staging dir — there
      // is nothing to diagnose.
      await store.removeStagingDir(invocationId).catch(() => {});
    } else {
      // Failure (decision D10 Stage B): move the staging dir — partial
      // outputs included — into quarantine/ with a reason.json for
      // postmortem; the startup sweeps apply retention/size budgets. If
      // quarantining itself fails, fall back to plain removal so a failed
      // invocation still never leaves live staging state behind.
      try {
        await store.quarantineInvocation(invocationId, {
          policyId: policy.id,
          toolName: policy.toolName,
          reason: failure instanceof Error ? failure.message : String(failure),
        });
      } catch {
        await store.removeStagingDir(invocationId).catch(() => {});
      }
    }
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
