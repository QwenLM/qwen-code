/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';
import type { OmniModality } from '../recognition.js';
import { STAGING_GRACE_MS } from '../recovery.js';
import { validateFixedPolicyCondition } from './conditions.js';
import type { FixedPolicyCondition } from './conditions.js';
import type {
  FixedPolicyOrigin,
  NormalizedFixedPolicy,
  NormalizedOmniProcessingConfig,
  NormalizedOmniProcessingLimits,
  OmniPolicyToolsSettings,
} from './types.js';

/**
 * Startup normalization of `omni.processing` (policy design §13 applicable
 * subset — see the S4 mapping doc §7). Raw settings enter, a fully
 * defaulted and validated {@link NormalizedOmniProcessingConfig} leaves;
 * any violation throws {@link OmniPolicyConfigError} and MUST abort
 * startup — a mis-configured guard must never degrade into delivering
 * over-limit media.
 */

/** A configuration error in `omni.processing.*`. Startup-fatal. */
export class OmniPolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniPolicyConfigError';
  }
}

/** Per-root derivation budget defaults (policy design §12.2). */
export const DEFAULT_OMNI_PROCESSING_LIMITS: NormalizedOmniProcessingLimits = {
  maxConcurrentResources: 1,
  reservedOutputTokens: 8192,
  maxLineageDepth: 8,
  maxPolicyRunsPerRoot: 64,
  maxArtifactsPerRoot: 256,
  maxDerivedBytesPerRoot: 1024 * 1024 * 1024,
  maxTransportPasses: 3,
};

const GIB = 1024 * 1024 * 1024;
/** DashScope temporary-upload per-file cap (§13 #18). */
const MAX_UPLOAD_FILE_BYTES_CEILING = GIB;
/** DashScope temporary uploads live 48h (§13 #19). */
const MAX_URL_TTL_HOURS = 48;

/** Raw fixed-policy entry shape accepted from settings. Everything
 * optional except `mediaTypes` and `toolName`; unknown keys rejected. */
const POLICY_ENTRY_KEYS = new Set([
  'priority',
  'mediaTypes',
  'origins',
  'when',
  'onConditionUnavailable',
  'toolName',
  'arguments',
  'maxRunsPerLineage',
  'onFailure',
  'output',
]);
const OUTPUT_KEYS = new Set(['reprocessMedia', 'source']);
const MODALITIES: readonly OmniModality[] = ['image', 'video', 'audio'];
const ORIGINS: readonly FixedPolicyOrigin[] = ['user', 'tool', 'policy'];
/** io params are harness-injected per invocation — fixed `arguments`
 * naming them would be overwritten silently, so they are rejected. */
const RESERVED_ARGUMENT_KEYS = ['inputPath', 'outputDir', 'resourceId'];

/** Policy ids feed run records and execution origins; keep them to a
 * conservative token charset. */
const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface SystemDefaultPolicy {
  mediaTypes: OmniModality[];
  toolName: string;
}

const SYSTEM_DEFAULT_POLICY_BASES: Record<string, SystemDefaultPolicy> = {
  'image-downsample': {
    mediaTypes: ['image'],
    toolName: 'omni_downsample_image',
  },
  'video-downscale': {
    mediaTypes: ['video'],
    toolName: 'omni_downscale_video',
  },
  'audio-downsample': {
    mediaTypes: ['audio'],
    toolName: 'omni_downsample_audio',
  },
};

/**
 * System default policies, registered ONLY as `transportGuard.policies`
 * (decision D7, revised): no `when`, so the guard stage runs them exactly
 * when the final delivery set still exceeds transport limits. This
 * satisfies the mandatory non-empty + three-modality-coverage validation
 * (policy design §10.1). There are NO system-default `fixedPolicies` —
 * preprocessing is pure user-experiment semantics, and a zero-config
 * setup must never trigger a policy below transport limits.
 */
export function systemDefaultTransportGuardPolicies(): Record<
  string,
  Record<string, unknown>
> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [id, base] of Object.entries(SYSTEM_DEFAULT_POLICY_BASES)) {
    entries[id] = {
      mediaTypes: base.mediaTypes,
      toolName: base.toolName,
    };
  }
  return entries;
}

/** Raw inputs to normalization, as threaded from settings. */
export interface RawOmniProcessingSettings {
  /** `omni.processing.fixedPolicies` (id → entry | null tombstone). */
  fixedPolicies?: unknown;
  /** `omni.processing.transportGuard.policies` (id → entry; tombstones
   * are a configuration error — the guard cannot be disabled). */
  transportGuardPolicies?: unknown;
  /** `omni.processing.limits`. */
  limits?: unknown;
  /** `omni.processing.policyTools`. */
  policyTools?: OmniPolicyToolsSettings;
  /** `omni.processing.transportGuard.maxUploadFileBytes`. */
  maxUploadFileBytes?: number;
  /** `omni.delivery.upload.urlTtlHours`. */
  urlTtlHours?: number;
}

/** Tool lookup surface normalization validates against (§13 #6/#14: a
 * tool that is unregistered — including excluded via tool filtering — or
 * not a media-policy tool fails normalization). */
export interface OmniPolicyToolLookup {
  getTool(name: string):
    | {
        mediaPolicyDescriptor?: MediaPolicyToolDescriptor;
        schema?: { parametersJsonSchema?: unknown };
      }
    | undefined;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(message: string): never {
  throw new OmniPolicyConfigError(message);
}

function requirePositiveInteger(
  value: unknown,
  where: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    fail(
      `${where}: must be ${allowZero ? 'a non-negative' : 'a positive'} integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** ID-merge two policy maps: user entry replaces the whole default entry;
 * `null` tombstones (where allowed) remove it. */
function mergePolicyMaps(
  defaults: Record<string, Record<string, unknown>>,
  raw: unknown,
  where: string,
  { allowTombstones }: { allowTombstones: boolean },
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown> | null> = {
    ...defaults,
  };
  if (raw === undefined) {
    return merged as Record<string, Record<string, unknown>>;
  }
  if (!isPlainRecord(raw)) {
    fail(`${where}: must be an object map of policy id → policy`);
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (entry === null) {
      if (!allowTombstones) {
        fail(
          `${where}.${id}: transport guard policies cannot be removed ` +
            `(the guard is mandatory); override the entry instead`,
        );
      }
      delete merged[id];
      continue;
    }
    if (!isPlainRecord(entry)) {
      fail(`${where}.${id}: must be an object (or null to remove a default)`);
    }
    merged[id] = entry;
  }
  return merged as Record<string, Record<string, unknown>>;
}

function normalizePolicy(
  id: string,
  entry: Record<string, unknown>,
  stage: 'preprocessing' | 'transport_guard',
  where: string,
  tools: OmniPolicyToolLookup,
): NormalizedFixedPolicy {
  // §13 #2: unique ids come free with the map shape; the charset check
  // keeps ids safe for run records and log lines.
  if (!POLICY_ID_PATTERN.test(id)) {
    fail(
      `${where}.${id}: policy id must match ${POLICY_ID_PATTERN} ` +
        `(letters, digits, ".", "_", "-")`,
    );
  }
  // §13 #1: strict structure — unknown keys are errors, not warnings.
  for (const key of Object.keys(entry)) {
    if (!POLICY_ENTRY_KEYS.has(key)) {
      fail(`${where}.${id}: unknown key "${key}"`);
    }
  }

  // §13 #3/#4: legal values and enums.
  const priority =
    entry['priority'] === undefined
      ? 0
      : typeof entry['priority'] === 'number' &&
          Number.isFinite(entry['priority'])
        ? entry['priority']
        : fail(`${where}.${id}.priority: must be a finite number`);

  const rawMediaTypes = entry['mediaTypes'];
  if (!Array.isArray(rawMediaTypes) || rawMediaTypes.length === 0) {
    fail(`${where}.${id}.mediaTypes: must be a non-empty array`);
  }
  for (const m of rawMediaTypes) {
    if (!MODALITIES.includes(m as OmniModality)) {
      fail(
        `${where}.${id}.mediaTypes: unknown modality ${JSON.stringify(m)} ` +
          `(expected ${MODALITIES.join(', ')})`,
      );
    }
  }
  const mediaTypes = [...new Set(rawMediaTypes as OmniModality[])];

  const rawOrigins = entry['origins'] ?? ['user', 'tool'];
  if (!Array.isArray(rawOrigins) || rawOrigins.length === 0) {
    fail(`${where}.${id}.origins: must be a non-empty array`);
  }
  for (const o of rawOrigins) {
    if (!ORIGINS.includes(o as FixedPolicyOrigin)) {
      fail(
        `${where}.${id}.origins: unknown origin ${JSON.stringify(o)} ` +
          `(expected ${ORIGINS.join(', ')})`,
      );
    }
  }
  const origins = [...new Set(rawOrigins as FixedPolicyOrigin[])];

  const onConditionUnavailable = entry['onConditionUnavailable'] ?? 'skip';
  if (onConditionUnavailable === 'abortTurn') {
    fail(
      `${where}.${id}.onConditionUnavailable: "abortTurn" is not yet ` +
        `supported (design reserves it for a later stage); use "skip" or "run"`,
    );
  }
  if (onConditionUnavailable !== 'skip' && onConditionUnavailable !== 'run') {
    fail(
      `${where}.${id}.onConditionUnavailable: must be "skip" or "run" ` +
        `(got ${JSON.stringify(onConditionUnavailable)})`,
    );
  }

  const onFailure = entry['onFailure'] ?? 'continue';
  if (onFailure !== 'continue' && onFailure !== 'abort') {
    fail(
      `${where}.${id}.onFailure: must be "continue" or "abort" ` +
        `(got ${JSON.stringify(onFailure)})`,
    );
  }

  const maxRunsPerLineage =
    entry['maxRunsPerLineage'] === undefined
      ? 1
      : requirePositiveInteger(
          entry['maxRunsPerLineage'],
          `${where}.${id}.maxRunsPerLineage`,
        );

  const rawOutput = entry['output'] ?? {};
  if (!isPlainRecord(rawOutput)) {
    fail(`${where}.${id}.output: must be an object`);
  }
  // §13 #23: output fields are a closed set with concrete defaults.
  for (const key of Object.keys(rawOutput)) {
    if (!OUTPUT_KEYS.has(key)) {
      fail(`${where}.${id}.output: unknown key "${key}"`);
    }
  }
  const reprocessMedia = rawOutput['reprocessMedia'] ?? false;
  if (typeof reprocessMedia !== 'boolean') {
    fail(`${where}.${id}.output.reprocessMedia: must be a boolean`);
  }
  const source = rawOutput['source'] ?? 'omit';
  if (source !== 'keep' && source !== 'omit') {
    fail(
      `${where}.${id}.output.source: must be "keep" or "omit" ` +
        `(got ${JSON.stringify(source)})`,
    );
  }
  // §13 #17: transport-guard outputs must replace the offending source —
  // keeping it would re-deliver the very media the guard rejected.
  if (stage === 'transport_guard' && source !== 'omit') {
    fail(
      `${where}.${id}.output.source: transport guard policies must use ` +
        `"omit" (the over-limit source cannot stay in the delivery set)`,
    );
  }

  // §13 #5: when-condition structure and field names.
  let when: FixedPolicyCondition | undefined;
  if (entry['when'] !== undefined) {
    if (stage === 'transport_guard') {
      // Guard policies are triggered by the limit breach itself, never by
      // conditions; a `when` here would silently punch a hole in coverage.
      fail(
        `${where}.${id}.when: transport guard policies must not declare ` +
          `"when" (they run exactly when transport limits are exceeded)`,
      );
    }
    const errors = validateFixedPolicyCondition(
      entry['when'],
      `${where}.${id}.when`,
    );
    if (errors.length > 0) {
      fail(errors.join('; '));
    }
    when = entry['when'] as FixedPolicyCondition;
  }

  // §13 #6 (+#14): the referenced tool must be registered — an excluded
  // (tools.disabled) tool is absent from the registry — and be a
  // media-policy tool.
  const toolName = entry['toolName'];
  if (typeof toolName !== 'string' || toolName.length === 0) {
    fail(`${where}.${id}.toolName: must be a non-empty string`);
  }
  const tool = tools.getTool(toolName);
  if (!tool) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" is not registered ` +
        `(unknown name, or excluded by tool filtering)`,
    );
  }
  const descriptor = tool.mediaPolicyDescriptor;
  if (!descriptor || descriptor.kind !== 'media_policy') {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" is not a media policy ` +
        `tool (no media_policy descriptor)`,
    );
  }
  // §13 #8: the descriptor must declare a deliverable output at all, and
  // a lossy media output obligates a disclosure text output — otherwise
  // the pipeline could degrade media with no user-visible disclosure.
  if (!descriptor.outputs.some((o) => o.required)) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" declares no required ` +
        `output; a fixed policy cannot rely on it producing anything`,
    );
  }
  const hasLossyMedia = descriptor.outputs.some(
    (o) => o.kind === 'media' && o.lossy,
  );
  const hasDisclosure = descriptor.outputs.some(
    (o) => o.kind === 'text' && o.role === 'disclosure',
  );
  if (hasLossyMedia && !hasDisclosure) {
    fail(
      `${where}.${id}.toolName: tool "${toolName}" declares a lossy media ` +
        `output but no disclosure text output`,
    );
  }
  // The policy's modalities must be servable by the tool.
  for (const m of mediaTypes) {
    if (!descriptor.inputMediaTypes.includes(m)) {
      fail(
        `${where}.${id}.mediaTypes: tool "${toolName}" does not accept ` +
          `"${m}" input (accepts ${descriptor.inputMediaTypes.join(', ')})`,
      );
    }
  }

  // §13 #11: fixed arguments validate against the tool's io-stripped
  // tunable schema; the harness-injected io keys are reserved.
  const args = entry['arguments'] ?? {};
  if (!isPlainRecord(args)) {
    fail(`${where}.${id}.arguments: must be an object`);
  }
  for (const reserved of RESERVED_ARGUMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, reserved)) {
      fail(
        `${where}.${id}.arguments: "${reserved}" is injected by the ` +
          `orchestrator per invocation and must not be configured`,
      );
    }
  }
  if (descriptor.settingsSchema) {
    const schemaError = SchemaValidator.validate(
      descriptor.settingsSchema,
      args,
    );
    if (schemaError) {
      fail(`${where}.${id}.arguments: ${schemaError}`);
    }
  }

  return {
    id,
    priority,
    mediaTypes,
    origins,
    when,
    onConditionUnavailable,
    toolName,
    arguments: args,
    maxRunsPerLineage,
    onFailure,
    output: { reprocessMedia, source },
    stage,
  };
}

function normalizeLimits(raw: unknown): NormalizedOmniProcessingLimits {
  if (raw === undefined) {
    return { ...DEFAULT_OMNI_PROCESSING_LIMITS };
  }
  if (!isPlainRecord(raw)) {
    fail('omni.processing.limits: must be an object');
  }
  const limits = { ...DEFAULT_OMNI_PROCESSING_LIMITS };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(limits, key)) {
      fail(`omni.processing.limits: unknown key "${key}"`);
    }
    limits[key as keyof NormalizedOmniProcessingLimits] =
      requirePositiveInteger(value, `omni.processing.limits.${key}`, {
        // Reserving zero output tokens is odd but not incoherent.
        allowZero: key === 'reservedOutputTokens',
      });
  }
  return limits;
}

function validatePolicyTools(
  policyTools: OmniPolicyToolsSettings | undefined,
  tools: OmniPolicyToolLookup,
): void {
  if (policyTools === undefined) return;
  if (!isPlainRecord(policyTools)) {
    fail('omni.processing.policyTools: must be an object map');
  }
  for (const [toolName, entry] of Object.entries(policyTools)) {
    const where = `omni.processing.policyTools.${toolName}`;
    if (entry === null) continue; // scope-merge tombstone
    if (!isPlainRecord(entry)) {
      fail(`${where}: must be an object`);
    }
    const tool = tools.getTool(toolName);
    if (!tool?.mediaPolicyDescriptor) {
      fail(`${where}: "${toolName}" is not a registered media policy tool`);
    }
    const descriptor = tool.mediaPolicyDescriptor;

    // §13 #7: tool-level settings validate against the settingsSchema.
    if (entry['settings'] !== undefined) {
      if (!isPlainRecord(entry['settings'])) {
        fail(`${where}.settings: must be an object`);
      }
      if (descriptor.settingsSchema) {
        const error = SchemaValidator.validate(
          descriptor.settingsSchema,
          entry['settings'],
        );
        if (error) {
          fail(`${where}.settings: ${error}`);
        }
      }
    }

    if (entry['runtime'] !== undefined) {
      if (!isPlainRecord(entry['runtime'])) {
        fail(`${where}.runtime: must be an object`);
      }
      const timeoutMs = entry['runtime']['timeoutMs'];
      if (timeoutMs !== undefined) {
        requirePositiveInteger(timeoutMs, `${where}.runtime.timeoutMs`);
        // §5 staging lifecycle: the startup sweep treats staging entries
        // older than STAGING_GRACE_MS as crash leftovers. A tool allowed
        // to run longer than the grace window could have its live staging
        // directory deleted out from under it by another process.
        if ((timeoutMs as number) >= STAGING_GRACE_MS) {
          fail(
            `${where}.runtime.timeoutMs: must be below the staging sweep ` +
              `grace window (${STAGING_GRACE_MS}ms) so a live invocation's ` +
              `staging directory is never reclaimed mid-run`,
          );
        }
      }
    }

    const modelAccess = entry['modelAccess'];
    if (modelAccess === undefined) continue;
    if (!isPlainRecord(modelAccess)) {
      fail(`${where}.modelAccess: must be an object`);
    }
    const defaults = modelAccess['defaultArguments'];
    const locked = modelAccess['lockedArguments'];
    if (defaults !== undefined && !isPlainRecord(defaults)) {
      fail(`${where}.modelAccess.defaultArguments: must be an object`);
    }
    if (locked !== undefined && !isPlainRecord(locked)) {
      fail(`${where}.modelAccess.lockedArguments: must be an object`);
    }
    // §13 #21: a key cannot be both defaulted (model may override) and
    // locked (model must not name it) — the combination is contradictory.
    if (isPlainRecord(defaults) && isPlainRecord(locked)) {
      const conflicts = Object.keys(defaults).filter((k) =>
        Object.prototype.hasOwnProperty.call(locked, k),
      );
      if (conflicts.length > 0) {
        fail(
          `${where}.modelAccess: ${conflicts
            .map((k) => `"${k}"`)
            .join(', ')} present in both defaultArguments and ` +
            `lockedArguments`,
        );
      }
    }
    // §13 #20: the model-visible projection may only narrow the native
    // schema — a property the native schema does not declare cannot be
    // introduced by projection.
    const projection = modelAccess['parameterSchema'];
    if (projection !== undefined) {
      if (!isPlainRecord(projection)) {
        fail(`${where}.modelAccess.parameterSchema: must be an object`);
      }
      const projectionProps = isPlainRecord(projection['properties'])
        ? Object.keys(projection['properties'])
        : [];
      const nativeSchema = tool.schema?.parametersJsonSchema;
      const nativeProps =
        isPlainRecord(nativeSchema) && isPlainRecord(nativeSchema['properties'])
          ? new Set(Object.keys(nativeSchema['properties']))
          : new Set<string>();
      const introduced = projectionProps.filter((p) => !nativeProps.has(p));
      if (introduced.length > 0) {
        fail(
          `${where}.modelAccess.parameterSchema: ${introduced
            .map((p) => `"${p}"`)
            .join(', ')} not present in the tool's native schema ` +
            `(projection may only narrow)`,
        );
      }
    }
  }
}

/**
 * Normalize and validate the full `omni.processing` configuration.
 * Called once at startup (after the tool registry exists); throws
 * {@link OmniPolicyConfigError} on any violation.
 */
export function normalizeOmniProcessingConfig(
  raw: RawOmniProcessingSettings,
  tools: OmniPolicyToolLookup,
): NormalizedOmniProcessingConfig {
  // §13 #18: the upload byte ceiling cannot exceed the channel's own cap.
  if (raw.maxUploadFileBytes !== undefined) {
    const bytes = requirePositiveInteger(
      raw.maxUploadFileBytes,
      'omni.processing.transportGuard.maxUploadFileBytes',
    );
    if (bytes > MAX_UPLOAD_FILE_BYTES_CEILING) {
      fail(
        `omni.processing.transportGuard.maxUploadFileBytes: ${bytes} exceeds ` +
          `the DashScope per-file upload cap (${MAX_UPLOAD_FILE_BYTES_CEILING})`,
      );
    }
  }
  // §13 #19: cached URLs must not outlive the channel's 48h validity.
  if (raw.urlTtlHours !== undefined) {
    const ttl = raw.urlTtlHours;
    if (
      typeof ttl !== 'number' ||
      !Number.isFinite(ttl) ||
      ttl < 0 ||
      ttl > MAX_URL_TTL_HOURS
    ) {
      fail(
        `omni.delivery.upload.urlTtlHours: must be a number between 0 and ` +
          `${MAX_URL_TTL_HOURS} (got ${JSON.stringify(ttl)})`,
      );
    }
  }

  const limits = normalizeLimits(raw.limits);
  validatePolicyTools(raw.policyTools, tools);

  // No system defaults on the fixedPolicies side (D7 revised): with no
  // configuration, preprocessing has zero policies and never runs.
  const fixedMap = mergePolicyMaps(
    {},
    raw.fixedPolicies,
    'omni.processing.fixedPolicies',
    { allowTombstones: true },
  );
  const guardMap = mergePolicyMaps(
    systemDefaultTransportGuardPolicies(),
    raw.transportGuardPolicies,
    'omni.processing.transportGuard.policies',
    { allowTombstones: false },
  );

  const fixedPolicies = Object.entries(fixedMap).map(([id, entry]) =>
    normalizePolicy(
      id,
      entry,
      'preprocessing',
      'omni.processing.fixedPolicies',
      tools,
    ),
  );
  const transportGuardPolicies = Object.entries(guardMap).map(([id, entry]) =>
    normalizePolicy(
      id,
      entry,
      'transport_guard',
      'omni.processing.transportGuard.policies',
      tools,
    ),
  );

  // §13 #15/#16: the merged guard set must exist and must cover every
  // modality the pipeline can deliver — a modality without a guard policy
  // would fail closed with no degradation path.
  if (transportGuardPolicies.length === 0) {
    fail(
      'omni.processing.transportGuard.policies: must not be empty ' +
        '(the transport guard is mandatory)',
    );
  }
  const covered = new Set(
    transportGuardPolicies.flatMap((policy) => policy.mediaTypes),
  );
  const uncovered = MODALITIES.filter((m) => !covered.has(m));
  if (uncovered.length > 0) {
    fail(
      `omni.processing.transportGuard.policies: no guard policy covers ` +
        `${uncovered.join(', ')} — the merged set must cover image, video, ` +
        `and audio`,
    );
  }

  // `output.reprocessMedia` re-enters derivatives into matching with
  // origin 'policy'. Within a set where no policy accepts that origin the
  // flag can never take effect — a silent misconfiguration, so it fails
  // like every other contradictory setting. Each stage runs with its own
  // policy set, so the check is per set.
  for (const [where, set] of [
    ['omni.processing.fixedPolicies', fixedPolicies],
    ['omni.processing.transportGuard.policies', transportGuardPolicies],
  ] as const) {
    const inert = set.filter((p) => p.output.reprocessMedia);
    if (inert.length > 0 && !set.some((p) => p.origins.includes('policy'))) {
      fail(
        `${where}: ${inert.map((p) => `"${p.id}"`).join(', ')} sets ` +
          `output.reprocessMedia, but no policy in this set accepts ` +
          `origin "policy" — derivatives would re-enter matching and ` +
          `never match. Add "policy" to some policy's origins or drop ` +
          `reprocessMedia.`,
      );
    }
  }

  return { fixedPolicies, transportGuardPolicies, limits };
}
