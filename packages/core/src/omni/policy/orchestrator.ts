/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
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
  conditionUsesNamespace,
  evaluateFixedPolicyCondition,
  type FixedPolicyConditionContext,
  type MemoryConditionField,
  type RequestConditionField,
  type ResourceConditionField,
} from './conditions.js';
import {
  computePolicyFingerprint,
  OmniDegradationCache,
} from './degradation-cache.js';
import { isOmniDerivationSuspended, settleOmniGc } from '../gc.js';
import { DEFAULT_OMNI_PROCESSING_LIMITS } from './config.js';
import { resolvePolicyToolSettings } from './tools/media-policy-tool.js';
import type {
  MediaMemoryBinding,
  MediaMemoryService,
  PolicyOutputInput,
  ReusableExecutionOutputs,
} from '../../services/media-memory/index.js';
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
  /** Media-memory identity of this resource, when memory collection is
   * active (S5): threaded so downstream policy passes (transport guard,
   * reactive ladder) commit onto the same lineage graph. */
  memoryBinding?: MediaMemoryBinding;
}

/** Size ceiling for non-media (`kind: 'file'`) policy artifacts — the
 * "bounded" in upstream P's transcript protocol. Text this size is far
 * beyond any real transcript; anything bigger is a runaway tool. */
export const MAX_FILE_ARTIFACT_BYTES = 256 * 1024;

/**
 * One included non-media file artifact (upstream P §6.2 transcript
 * protocol): NOT a media resource — it skipped media recognition, was
 * validated as bounded UTF-8 text instead, and is delivered as a text
 * Part rather than uploaded. `text` carries the full content, read within
 * {@link MAX_FILE_ARTIFACT_BYTES} at validation time, so delivery never
 * re-reads the file.
 */
export interface PolicyFileDelivery {
  /** Promoted object path (registration/record; content is in `text`). */
  filePath: string;
  /** `metadata.omniRole` of the artifact (e.g. 'transcript'). */
  role?: string;
  mimeType: string;
  text: string;
  sha256: string;
  sizeBytes: number;
  /** Disclosure that must accompany the text (lossy derivations). */
  disclosure?: string;
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
  /** Request/session condition namespaces from the caller. The resource
   * namespace is always derived from each item's recognition, and
   * `request.totalEstimatedMediaTokens` is computed internally from the
   * pending delivery set unless the caller supplies its own `request`
   * (a future multi-root caller that knows the full request set). */
  conditionContext?: Pick<FixedPolicyConditionContext, 'request' | 'session'>;
  /** Injectable for tests; defaults to the store-rooted cache. */
  degradationCache?: OmniDegradationCache;
  /** Per-root derivation budgets (decision D11); the system defaults
   * apply when the caller has no normalized processing config. */
  limits?: NormalizedOmniProcessingLimits;
  /** Media-memory collection (S5). When present, successful executions
   * commit onto the memory graph; `sourceBinding` is the root resource's
   * identity when the caller already recorded it. Collection failures
   * never block delivery (design M §6.4). */
  memory?: {
    service: MediaMemoryService;
    sourceBinding?: MediaMemoryBinding;
  };
}

/** Root resource entering the orchestrator. */
export interface PolicySourceResource {
  filePath: string;
  recognized: RecognizedMedia;
  /** User-recognizable name for records and error messages. */
  displayName: string;
  origin: Extract<FixedPolicyOrigin, 'user' | 'tool'>;
  /** Content hash when the caller already computed it (memory
   * collection records it at recognition time); avoids re-hashing. */
  sha256?: string;
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
  /** Media-memory identity of this item (S5). Set on the root from
   * `options.memory.sourceBinding` and on derived items from the commit
   * of the execution that produced them; absent when memory is off or
   * the identity is unknown (commit failed). */
  memoryBinding?: MediaMemoryBinding;
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
    /** `metadata.omniRole`, when the tool labeled the artifact. */
    role?: string;
    /** Media-memory identity, when collection committed this artifact. */
    memoryBinding?: MediaMemoryBinding;
  }>;
  /** Non-media file artifacts (transcripts). Never re-enter matching. */
  derivedFiles: PolicyFileDelivery[];
}

/**
 * Delivery decision for one artifact under the policy's
 * `output.artifacts` selector map: most-specific selector wins
 * (`role:` > `kind:` > `*`); an artifact nothing matches is retained
 * (upstream P default).
 */
function resolveArtifactSelector(
  artifacts: Record<string, 'include' | 'retain'>,
  kind: string,
  role: string | undefined,
): 'include' | 'retain' {
  if (role !== undefined) {
    const byRole = artifacts[`role:${role}`];
    if (byRole) return byRole;
  }
  const byKind = artifacts[`kind:${kind}`];
  if (byKind) return byKind;
  return artifacts['*'] ?? 'retain';
}

function resourceConditionContext(
  recognized: RecognizedMedia,
  shared?: Pick<FixedPolicyConditionContext, 'request' | 'session' | 'memory'>,
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

/** Memory-role name → the `memory.*` condition field it feeds. Free-form
 * roles from tools simply have no condition field. */
const MEMORY_ROLE_FIELDS: Record<string, MemoryConditionField> = {
  transcript: 'hasTranscript',
  ocr: 'hasOcr',
  caption: 'hasCaption',
  summary: 'hasSummary',
  keyframe: 'hasKeyframes',
  clip: 'hasClip',
};

/**
 * The `memory.*` condition namespace for one work item (policy design
 * §4.1/4.4): 0/1 presence flags derived from the roles recorded anywhere
 * in the item's version subgraph. Returns undefined — every memory
 * condition then evaluates `unavailable`, never silently false — when
 * memory is off, the item has no binding, or the store is unreadable.
 */
async function memoryConditionNamespace(
  memory: { service: MediaMemoryService } | undefined,
  binding: MediaMemoryBinding | undefined,
): Promise<Partial<Record<MemoryConditionField, number>> | undefined> {
  if (!memory || !binding) return undefined;
  const roles = await memory.service.collectVersionOutputRoles(binding);
  if (!roles) return undefined;
  const namespace: Partial<Record<MemoryConditionField, number>> = {};
  for (const field of Object.values(MEMORY_ROLE_FIELDS)) {
    namespace[field] = 0;
  }
  for (const role of roles) {
    const field = MEMORY_ROLE_FIELDS[role];
    if (field) namespace[field] = 1;
  }
  return namespace;
}

/**
 * `request.totalEstimatedMediaTokens` (policy design §8.3): the estimated
 * token sum over ALL media currently pending delivery for this root.
 * Computed when an item enters matching (pass start) — and therefore
 * recomputed as derivatives join or replace the delivery set. Undefined
 * (→ `unavailable`) when any pending resource cannot be estimated: a
 * partial sum silently reading as a smaller total would flip threshold
 * conditions the permissive way.
 */
function requestConditionNamespace(
  items: WorkItem[],
): Partial<Record<RequestConditionField, number>> | undefined {
  let total = 0;
  for (const item of items) {
    if (!item.deliver) continue;
    const estimate = estimateRawResourceTokens(item.recognized);
    if (estimate.status !== 'ok') return undefined;
    total += estimate.estimatedTokenCount;
  }
  return { totalEstimatedMediaTokens: total };
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
  /** Included non-media file artifacts (transcripts), delivered as text
   * Parts by the caller — never uploaded. */
  fileDeliveries: PolicyFileDelivery[];
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
  fileDeliveries: PolicyFileDelivery[];
  records: PolicyRunRecord[];
}> {
  const { policies, limits } = normalized;
  const cache =
    options.degradationCache ??
    new OmniDegradationCache(options.store.getOmniRootDir());
  const records: PolicyRunRecord[] = [];
  const fileDeliveries: PolicyFileDelivery[] = [];
  const items: WorkItem[] = [
    {
      filePath: source.filePath,
      recognized: source.recognized,
      label: source.displayName,
      origin: source.origin,
      sha256: source.sha256,
      memoryBinding: options.memory?.sourceBinding,
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
    // Pass-start condition snapshot (policy design §8.3): the request
    // namespace is recomputed as each item enters matching so it reflects
    // derivatives added by earlier passes; the session namespace is the
    // caller's per-delivery snapshot and never changes mid-run. The
    // memory namespace is per-ITEM (each version's subgraph has its own
    // recorded roles) and is only consulted when some policy's `when`
    // actually references `memory.*` — the subgraph query costs a store
    // read.
    const needsMemoryNamespace = policies.some(
      (policy) => policy.when && conditionUsesNamespace(policy.when, 'memory'),
    );
    const sharedConditionContext: Pick<
      FixedPolicyConditionContext,
      'request' | 'session' | 'memory'
    > = {
      request:
        options.conditionContext?.request ?? requestConditionNamespace(items),
      session: options.conditionContext?.session,
      memory: needsMemoryNamespace
        ? await memoryConditionNamespace(options.memory, item.memoryBinding)
        : undefined,
    };
    for (const policy of policies) {
      if (!policy.mediaTypes.includes(item.recognized.modality)) continue;
      if (!policy.origins.includes(item.origin)) continue;
      const runs = item.lineageRuns.get(policy.id) ?? 0;
      if (runs >= policy.maxRunsPerLineage) continue;
      if (policy.when) {
        const evaluation = evaluateFixedPolicyCondition(
          policy.when,
          resourceConditionContext(item.recognized, sharedConditionContext),
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
          options.memory && item.memoryBinding
            ? { service: options.memory.service, source: item.memoryBinding }
            : undefined,
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
            // `output.artifacts` selector decides delivery (upstream P):
            // an included derivative enters the delivery set, a retained
            // one is only registered in objects/.
            deliver:
              resolveArtifactSelector(
                policy.output.artifacts,
                derived.recognized.modality,
                derived.role,
              ) === 'include',
            process: policy.output.reprocessMedia && depthAllowsReprocess,
          });
        }
        for (const file of execution.derivedFiles) {
          // File artifacts (transcripts) count against the same budgets
          // but never re-enter policy matching — they are not media.
          artifactsProduced++;
          derivedBytesProduced += file.sizeBytes;
          if (
            resolveArtifactSelector(
              policy.output.artifacts,
              'file',
              file.role,
            ) === 'include'
          ) {
            fileDeliveries.push(file);
          }
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
        memoryBinding: item.memoryBinding,
      })),
    fileDeliveries,
    records,
  };
}

/** Validated view of one media artifact after descriptor/staging checks. */
export interface ValidatedMediaArtifact {
  kind: 'media';
  absolutePath: string;
  recognized: RecognizedMedia;
  sha256: string;
  disclosure?: string;
  lossy: boolean;
  /** `metadata.omniRole`, when the tool labeled the artifact. */
  role?: string;
}

/** Validated view of one non-media file artifact (transcript protocol,
 * upstream P §6.2): bounded UTF-8 text, never probed as media. */
export interface ValidatedFileArtifact {
  kind: 'file';
  absolutePath: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
  sha256: string;
  disclosure?: string;
  lossy: boolean;
  role?: string;
}

export type ValidatedArtifact = ValidatedMediaArtifact | ValidatedFileArtifact;

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
  memory:
    | { service: MediaMemoryService; source: MediaMemoryBinding }
    | undefined,
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
  const settingsDefaults = resolvePolicyToolSettings(config, policy.toolName);
  const effectiveArguments = { ...settingsDefaults, ...policy.arguments };
  const fingerprint = computePolicyFingerprint(
    policy.toolName,
    effectiveArguments,
    descriptor.version,
  );
  // Memory collection needs wall-clock execution bounds; captured here so
  // the cache-hit path (which re-materializes the same execution node)
  // records honest, if near-zero, durations.
  const startedAt = new Date().toISOString();
  // Execution-free reuse (#8189 «同文件同 settings 二次触发同一 policy：
  // 直接复用，无重复执行»). Consulted BEFORE the degradation cache because
  // memory covers every output shape — multi-output tools and text
  // products (an 81-minute transcript!) that the cache deliberately never
  // stores, and therefore used to re-transcode on every delivery.
  if (memory) {
    const reusable = await memory.service.findReusableOutputs(
      item.sha256,
      fingerprint,
    );
    const rebuilt = reusable
      ? await rebuildReusedOutputs(reusable, descriptor, store, signal)
      : undefined;
    if (rebuilt) {
      debugLogger.debug(
        `memory reuse hit: policy=${policy.id} sha256=${item.sha256.slice(0, 12)}… ` +
          `outputs=${rebuilt.outputs.length} (tool not executed)`,
      );
      // The reusing file records its OWN execution, stamped with
      // `reusedExecutionId` by the service (M §11.3) — provenance stays
      // per-file while the computation is shared.
      const commit = await memory.service.commitPolicySucceeded({
        invocationId: 'memory-reuse',
        source: memory.source,
        executionOrigin: {
          kind: 'fixed_policy',
          policyId: policy.id,
          stage: policy.stage,
        },
        toolName: policy.toolName,
        toolVersion: descriptor.version,
        finalArguments: effectiveArguments,
        omniConfigHash: fingerprint,
        startedAt,
        completedAt: new Date().toISOString(),
        outputs: rebuilt.outputs,
      });
      return {
        outcome: 'succeeded',
        derived: rebuilt.derived.map((d) => ({
          ...d,
          memoryBinding: commit?.mediaBindings.get(d.sha256),
        })),
        derivedFiles: rebuilt.derivedFiles,
      };
    }
  }
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
          // Same cross-check a fresh derivation gets in validateArtifact:
          // the recognized bytes must be a media type this tool DECLARES
          // producing. The cache file is workspace-shippable, so without
          // this a crafted entry could route an arbitrary store object —
          // wrong modality included — through a policy that never made
          // it, skipping every per-derivation validation gate.
          const declared = descriptor.outputs.some(
            (o) =>
              o.kind === 'media' &&
              o.mimeTypes?.includes(recognized.detectedMimeType),
          );
          if (declared) {
            debugLogger.debug(
              `degradation cache hit: policy=${policy.id} sha256=${item.sha256.slice(0, 12)}…`,
            );
            // A cache hit converges on the same content-keyed execution node
            // as the original run (design M §11: no duplicate nodes) — the
            // commit is a no-op when memory already has it, and only writes
            // when the memory store was wiped while the degradation cache
            // survived. Never blocks delivery.
            const commit = memory
              ? await memory.service.commitPolicySucceeded({
                  invocationId: 'cache-hit',
                  source: memory.source,
                  executionOrigin: {
                    kind: 'fixed_policy',
                    policyId: policy.id,
                    stage: policy.stage,
                  },
                  toolName: policy.toolName,
                  toolVersion: descriptor.version,
                  finalArguments: effectiveArguments,
                  omniConfigHash: fingerprint,
                  startedAt,
                  completedAt: new Date().toISOString(),
                  outputs: [
                    {
                      kind: 'media',
                      objectPath,
                      sha256: hit.degradedSha256,
                      mediaType: recognized.modality,
                      metadata: recognized.metadata,
                      sizeBytes: recognized.sizeBytes,
                      mimeType: recognized.detectedMimeType,
                      role: hit.role,
                      disclosure: hit.disclosure,
                    },
                  ],
                })
              : undefined;
            return {
              outcome: 'cache_hit',
              derived: [
                {
                  filePath: objectPath,
                  recognized,
                  sha256: hit.degradedSha256,
                  disclosure: hit.disclosure,
                  degraded: true,
                  role: hit.role,
                  memoryBinding: commit?.mediaBindings.get(hit.degradedSha256),
                },
              ],
              derivedFiles: [],
            };
          }
          debugLogger.debug(
            `degradation cache hit for policy=${policy.id} recognized as ` +
              `undeclared media type ${recognized.detectedMimeType}; ` +
              `dropping the entry and re-transcoding`,
          );
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

  // Budget-stop (storage design §6.2 / policy design §8.4): when the GC
  // found the store over budget with only referenced objects left, no NEW
  // bytes may be derived. Reuse and cache hits stay allowed — both paths
  // above return before this point and produce nothing new. Fail the
  // policy rather than silently skip: a policy that was configured to run
  // and didn't must say why (its failure routes through the existing
  // required/optional semantics). The startup GC is fire-and-forget, so
  // settle it first — otherwise the first derivation of a fresh process
  // races past the flag before the sweep can raise it.
  await settleOmniGc(store.getOmniRootDir());
  if (isOmniDerivationSuspended(store.getOmniRootDir())) {
    throw new Error(
      `omni object store is over its byte budget with only ` +
        `memory-referenced objects left; new policy derivations are ` +
        `suspended. Raise omni.storage.maxTotalBytes or delete memory ` +
        `records you no longer need, then start a new session — the ` +
        `budget is re-evaluated once per process.`,
    );
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

    // Artifacts are independent files in the same staging dir — validate
    // them concurrently; map keeps the batch order.
    const validated = await Promise.all(
      batch.artifacts.map((artifact) =>
        validateArtifact(artifact, descriptor, stagingDir, signal),
      ),
    );
    assertRequiredOutputsPresent(descriptor, validated, policy.toolName);

    // Fixed-point: identical output means this iteration changed nothing —
    // deliver the source and stop deriving (no cache entry either; a no-op
    // is a property of this input, re-derivable cheaply).
    if (validated.every((a) => a.sha256 === item.sha256)) {
      return { outcome: 'no_op', derived: [], derivedFiles: [] };
    }

    // Promotion first (D12): once an artifact is in objects/ it is
    // content-addressed and immutable; only then substitute + cache.
    // Independent files promote concurrently (the store is
    // content-addressed: tmp + atomic rename); map keeps the batch order.
    const promoted = await Promise.all(
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
        return { artifact, objectPath: put.objectPath };
      }),
    );
    const derived: PolicyExecution['derived'] = [];
    const derivedFiles: PolicyExecution['derivedFiles'] = [];
    for (const { artifact, objectPath } of promoted) {
      if (artifact.kind === 'media') {
        derived.push({
          filePath: objectPath,
          recognized: artifact.recognized,
          sha256: artifact.sha256,
          disclosure: artifact.disclosure,
          degraded: artifact.lossy,
          role: artifact.role,
        });
      } else {
        derivedFiles.push({
          filePath: objectPath,
          role: artifact.role,
          mimeType: artifact.mimeType,
          text: artifact.text,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          disclosure: artifact.disclosure,
        });
      }
    }
    // Memory collection (S5, design M §6.4): commit AFTER promotion — the
    // objects/ bytes the records reference already exist — and in one shot
    // at the point where every commit input coexists. A collection failure
    // logs inside the service and returns undefined; delivery proceeds.
    if (memory) {
      const outputs: PolicyOutputInput[] = promoted.map(
        ({ artifact, objectPath }) =>
          artifact.kind === 'media'
            ? {
                kind: 'media' as const,
                objectPath,
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
                objectPath,
                sha256: artifact.sha256,
                mimeType: artifact.mimeType,
                text: artifact.text,
                sizeBytes: artifact.sizeBytes,
                role: artifact.role,
                disclosure: artifact.disclosure,
              },
      );
      const commit = await memory.service.commitPolicySucceeded({
        invocationId,
        source: memory.source,
        executionOrigin: {
          kind: 'fixed_policy',
          policyId: policy.id,
          stage: policy.stage,
        },
        toolName: policy.toolName,
        toolVersion: descriptor.version,
        finalArguments: effectiveArguments,
        omniConfigHash: fingerprint,
        startedAt,
        completedAt: new Date().toISOString(),
        outputs,
      });
      if (commit) {
        for (const entry of derived) {
          entry.memoryBinding = commit.mediaBindings.get(entry.sha256);
        }
      }
    }
    // The cache maps one input to ONE media derivative; multi-output tools
    // and file artifacts (whose cache-hit path depends on media
    // re-recognition) are simply not cached — re-run instead of guessing.
    if (
      validated.length === 1 &&
      validated[0].kind === 'media' &&
      validated[0].disclosure
    ) {
      await cache.put(item.sha256, fingerprint, {
        degradedSha256: validated[0].sha256,
        extension: extensionForMime(validated[0].recognized.detectedMimeType),
        disclosure: validated[0].disclosure,
        mimeType: validated[0].recognized.detectedMimeType,
        // Persist the artifact's role so a cache hit reconstructs the SAME
        // derived shape as the fresh derivation above.
        ...(validated[0].role !== undefined ? { role: validated[0].role } : {}),
      });
    }
    return { outcome: 'succeeded', derived, derivedFiles };
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
 * declared media output — or, for `kind: 'file'` artifacts (transcript
 * protocol), bounded strict-UTF-8 text matching a declared file output —
 * and, for lossy outputs, a non-empty `metadata.omniDisclosure`.
 */
/**
 * Rebuild the deliverables of a recorded execution without running the
 * tool. Every reuse is verified exactly like a degradation-cache hit: the
 * object must still be a regular file, its bytes must still hash to the
 * recorded identity (memory.json is project-local and hand-editable), and
 * a media object must re-recognize as a type this tool DECLARES producing
 * — otherwise a crafted record could route arbitrary store content
 * through a policy that never made it. Any doubt returns undefined and the
 * caller re-derives from source.
 */
async function rebuildReusedOutputs(
  reusable: ReusableExecutionOutputs,
  descriptor: MediaPolicyToolDescriptor,
  store: OmniObjectStore,
  signal: AbortSignal | undefined,
): Promise<
  | {
      outputs: PolicyOutputInput[];
      derived: PolicyExecution['derived'];
      derivedFiles: PolicyExecution['derivedFiles'];
    }
  | undefined
> {
  const outputs: PolicyOutputInput[] = [];
  const derived: PolicyExecution['derived'] = [];
  const derivedFiles: PolicyExecution['derivedFiles'] = [];
  try {
    for (const record of reusable.outputs) {
      // A media output carries its object path (its derived version's file
      // record). A TEXT output has no version node, so its location is
      // reconstructed from the content hash — the object store is
      // content-addressed, which is what makes that sound. Without this,
      // text products (transcripts — the most expensive thing to re-derive
      // and the whole point of #8189) could never be reused.
      const objectPath =
        record.objectPath ??
        store.objectPathFor(record.sha256, extensionForMime(record.mimeType));
      const stat = await fs.lstat(objectPath).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
      if ((await hashFileSha256(objectPath, signal)) !== record.sha256) {
        return undefined;
      }
      if (record.kind === 'media') {
        const recognized = await recognizeMediaFile(objectPath, { signal });
        const declared = descriptor.outputs.some(
          (o) =>
            o.kind === 'media' &&
            o.mimeTypes?.includes(recognized.detectedMimeType),
        );
        if (!declared) return undefined;
        outputs.push({
          kind: 'media',
          objectPath,
          sha256: record.sha256,
          mediaType: recognized.modality,
          metadata: recognized.metadata,
          sizeBytes: recognized.sizeBytes,
          mimeType: recognized.detectedMimeType,
          role: record.role,
          disclosure: record.disclosure,
        });
        derived.push({
          filePath: objectPath,
          recognized,
          sha256: record.sha256,
          disclosure: record.disclosure,
          degraded: record.disclosure !== undefined,
          role: record.role,
        });
      } else {
        // Read the FULL text back from the promoted object: the entry's
        // inlineText is bounded by `collection.maxInlineTextBytes`, and a
        // truncated transcript must never be delivered as the whole one.
        const text = await fs.readFile(objectPath, 'utf8');
        outputs.push({
          kind: 'text',
          objectPath,
          sha256: record.sha256,
          mimeType: record.mimeType,
          text,
          sizeBytes: record.sizeBytes,
          role: record.role,
          disclosure: record.disclosure,
        });
        derivedFiles.push({
          filePath: objectPath,
          role: record.role,
          mimeType: record.mimeType,
          text,
          sha256: record.sha256,
          sizeBytes: record.sizeBytes,
          disclosure: record.disclosure,
        });
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    debugLogger.debug(
      `memory reuse could not be verified, re-deriving: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return { outputs, derived, derivedFiles };
}

export async function validateArtifact(
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
  const rawRole = artifact.metadata?.['omniRole'];
  const role = typeof rawRole === 'string' && rawRole ? rawRole : undefined;
  const rawDisclosure = artifact.metadata?.['omniDisclosure'];
  const disclosure =
    typeof rawDisclosure === 'string' && rawDisclosure
      ? rawDisclosure
      : undefined;

  if (artifact.kind === 'file') {
    // Non-media artifact (upstream P §6.2): validated as bounded strict
    // UTF-8 text against a declared `kind: 'file'` output — no media
    // probe. Only tools whose descriptor declares a file output can pass
    // here, and the declared mimeType must be one the spec allows.
    const spec = descriptor.outputs.find(
      (o) =>
        o.kind === 'file' &&
        (o.role === undefined || o.role === role) &&
        artifact.mimeType !== undefined &&
        o.mimeTypes?.includes(artifact.mimeType),
    );
    if (!spec) {
      throw new Error(
        `policy artifact "${artifact.title}" (file, role ${role ?? 'none'}, ` +
          `${artifact.mimeType ?? 'no mimeType'}) matches no declared file output`,
      );
    }
    if (stat.size > MAX_FILE_ARTIFACT_BYTES) {
      throw new Error(
        `policy artifact "${artifact.title}" exceeds the file-artifact ` +
          `size budget (${stat.size} > ${MAX_FILE_ARTIFACT_BYTES} bytes)`,
      );
    }
    const bytes = await fs.readFile(absolutePath);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `policy artifact "${artifact.title}" is not valid UTF-8 text`,
      );
    }
    if (spec.lossy && !disclosure) {
      throw new Error(
        `policy artifact "${artifact.title}" is lossy but carries no omniDisclosure`,
      );
    }
    return {
      kind: 'file',
      absolutePath,
      mimeType: artifact.mimeType as string,
      text,
      sizeBytes: bytes.byteLength,
      // The bytes are already in memory for the UTF-8 check — hash them
      // directly instead of streaming the file a second time.
      sha256: createHash('sha256').update(bytes).digest('hex'),
      disclosure,
      lossy: spec.lossy === true,
      role,
    };
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
  if (spec.lossy && !disclosure) {
    throw new Error(
      `policy artifact "${artifact.title}" is lossy but carries no omniDisclosure`,
    );
  }
  return {
    kind: 'media',
    absolutePath,
    recognized,
    sha256: await hashFileSha256(absolutePath, signal),
    disclosure,
    lossy: spec.lossy === true,
    role,
  };
}

/** Every required media/file output declared by the descriptor must have
 * been produced (§5 completeness check). */
export function assertRequiredOutputsPresent(
  descriptor: MediaPolicyToolDescriptor,
  validated: ValidatedArtifact[],
  toolName: string,
): void {
  for (const spec of descriptor.outputs) {
    if (!spec.required) continue;
    let produced: boolean;
    if (spec.kind === 'media') {
      produced = validated.some(
        (a) =>
          a.kind === 'media' &&
          spec.mimeTypes?.includes(a.recognized.detectedMimeType),
      );
    } else if (spec.kind === 'file') {
      produced = validated.some(
        (a) =>
          a.kind === 'file' &&
          (spec.role === undefined || a.role === spec.role) &&
          spec.mimeTypes?.includes(a.mimeType),
      );
    } else {
      // Text outputs (disclosures) travel as artifact metadata, not as
      // artifacts of their own — validated per lossy artifact above.
      continue;
    }
    if (!produced) {
      throw new Error(
        `tool ${toolName} did not produce its required ${spec.kind} ` +
          `${spec.mimeTypes?.join('/') ?? spec.role ?? ''} output`,
      );
    }
  }
}
