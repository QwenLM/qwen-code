/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import { ToolNames } from '../../tools/tool-names.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';
import type { OmniModality } from '../recognition.js';
import { STAGING_GRACE_MS } from '../recovery.js';
import { validateFixedPolicyCondition } from './conditions.js';
import type { FixedPolicyCondition } from './conditions.js';
import { isPlainRecord } from './types.js';
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
  'description',
]);
/** Upper bound on a policy `description` — it is injected verbatim into the
 * system prompt, so a runaway string would silently bloat every request. */
const MAX_POLICY_DESCRIPTION_CHARS = 600;
const OUTPUT_KEYS = new Set(['reprocessMedia', 'source', 'artifacts']);
/** Valid `kind:<…>` selector targets in `output.artifacts` — the media
 * modalities plus the non-media `file` artifact kind (transcripts). */
const ARTIFACT_SELECTOR_KINDS = new Set(['image', 'video', 'audio', 'file']);
const MODALITIES: readonly OmniModality[] = ['image', 'video', 'audio'];
const ORIGINS: readonly FixedPolicyOrigin[] = ['user', 'tool', 'policy'];
/** io params are harness-injected per invocation — fixed `arguments`
 * naming them would be overwritten silently, so they are rejected. */
const RESERVED_ARGUMENT_KEYS = ['inputPath', 'outputDir', 'resourceId'];

/** Policy ids feed run records and execution origins; keep them to a
 * conservative token charset. */
const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * System default policies, registered ONLY as `transportGuard.policies`
 * (decision D7, revised): no `when`, so the guard stage runs them exactly
 * when the final delivery set still exceeds transport limits. This
 * satisfies the mandatory non-empty + three-modality-coverage validation
 * (policy design §10.1). There are NO system-default `fixedPolicies` —
 * preprocessing is pure user-experiment semantics, and a zero-config
 * setup must never trigger a policy below transport limits. Returns a
 * fresh object per call: the entries flow into normalization as raw
 * settings input, which must never share mutable state across calls.
 */
export function systemDefaultTransportGuardPolicies(): Record<
  string,
  Record<string, unknown>
> {
  return {
    'image-downsample': {
      mediaTypes: ['image'],
      toolName: ToolNames.OMNI_DOWNSAMPLE_IMAGE,
    },
    'video-downscale': {
      mediaTypes: ['video'],
      toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
    },
    'audio-downsample': {
      mediaTypes: ['audio'],
      toolName: ToolNames.OMNI_DOWNSAMPLE_AUDIO,
    },
  };
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
  /** `omni.processing.transportGuard.maxEstimatedTokens`
   * (0/unset = token guard disabled). */
  maxEstimatedTokens?: number;
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
        /** The tool's NATIVE parameter schema (DeclarativeTool's public
         * field) — never the `schema` getter: for media-policy tools that
         * getter is the model-visible projection, which strips
         * lockedArguments and operatorOnly keys, and validating operator
         * config against the projection would reject every legitimate
         * locked/operator-only argument at startup. */
        parameterSchema?: unknown;
      }
    | undefined;
}

function fail(message: string): never {
  throw new OmniPolicyConfigError(message);
}

/** §13 #1: unknown keys are configuration errors, never silently ignored. */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  where: string,
  known: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      fail(`${where}: unknown key "${key}"`);
    }
  }
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
  // Null prototype: a raw "__proto__" key must become an ordinary own key
  // (handed to normalizePolicy, whose id pattern rejects it) instead of
  // silently re-prototyping the map through the __proto__ setter.
  const merged: Record<string, Record<string, unknown> | null> = Object.assign(
    Object.create(null),
    defaults,
  );
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

  // Optional model-facing description (like a tool description): free text
  // explaining what this policy does / when it triggers. Collected into the
  // media-guidance system-prompt section so the model learns the active
  // preprocessing contract straight from configuration.
  let description: string | undefined;
  if (entry['description'] !== undefined) {
    if (typeof entry['description'] !== 'string') {
      fail(`${where}.${id}.description: must be a string`);
    }
    const trimmed = (entry['description'] as string).trim();
    if (trimmed.length > MAX_POLICY_DESCRIPTION_CHARS) {
      fail(
        `${where}.${id}.description: must be ≤ ${MAX_POLICY_DESCRIPTION_CHARS} ` +
          `characters (got ${trimmed.length})`,
      );
    }
    if (trimmed.length > 0) description = trimmed;
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
  // `output.artifacts` selector map (upstream P): selector → action.
  // Unconfigured defaults to include-all — the historical "every
  // derivative delivers" behavior of this stage. Selector producibility
  // (§13 #22/#24) is checked below, once the descriptor is known.
  const rawArtifacts = rawOutput['artifacts'];
  let artifacts: Record<string, 'include' | 'retain'>;
  if (rawArtifacts === undefined) {
    artifacts = { '*': 'include' };
  } else {
    if (!isPlainRecord(rawArtifacts)) {
      fail(`${where}.${id}.output.artifacts: must be an object`);
    }
    artifacts = {};
    for (const [selector, action] of Object.entries(rawArtifacts)) {
      const at = `${where}.${id}.output.artifacts["${selector}"]`;
      if (action !== 'include' && action !== 'retain') {
        fail(
          `${at}: must be "include" or "retain" (got ${JSON.stringify(action)})`,
        );
      }
      if (selector === '*') {
        // Default action for artifacts no other selector matches.
      } else if (selector.startsWith('kind:')) {
        const kind = selector.slice('kind:'.length);
        if (!ARTIFACT_SELECTOR_KINDS.has(kind)) {
          fail(
            `${at}: unknown artifact kind "${kind}" ` +
              `(expected one of ${[...ARTIFACT_SELECTOR_KINDS].join(', ')})`,
          );
        }
      } else if (selector.startsWith('role:')) {
        const role = selector.slice('role:'.length);
        if (!POLICY_ID_PATTERN.test(role)) {
          fail(`${at}: invalid role token ${JSON.stringify(role)}`);
        }
      } else {
        fail(
          `${at}: unknown selector (expected "*", "kind:<kind>", or "role:<role>")`,
        );
      }
      artifacts[selector] = action;
    }
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

  // §13 #22/#24: every configured artifact selector must correspond to an
  // output the tool's descriptor can actually produce — a selector that
  // can never match is a configuration error, not a silent no-op. #24 in
  // full: a `role:transcript` selector must point at a bounded, managed
  // UTF-8 text/plain file output.
  {
    const producibleKinds = new Set<string>();
    // role → declaring output spec (first declaration wins, matching the
    // outputs-order semantics of a find): one structure serves BOTH the
    // role-selector existence check and the transcript shape check below.
    const producibleRoleSpecs = new Map<
      string,
      (typeof descriptor.outputs)[number]
    >();
    for (const o of descriptor.outputs) {
      if (o.kind === 'media') {
        for (const mimeType of o.mimeTypes ?? []) {
          producibleKinds.add(mimeType.split('/')[0]);
        }
        if (o.role && !producibleRoleSpecs.has(o.role)) {
          producibleRoleSpecs.set(o.role, o);
        }
      } else if (o.kind === 'file') {
        producibleKinds.add('file');
        if (o.role && !producibleRoleSpecs.has(o.role)) {
          producibleRoleSpecs.set(o.role, o);
        }
      }
    }
    for (const selector of Object.keys(artifacts)) {
      const at = `${where}.${id}.output.artifacts["${selector}"]`;
      if (selector === '*') continue;
      if (selector.startsWith('kind:')) {
        const kind = selector.slice('kind:'.length);
        if (!producibleKinds.has(kind)) {
          fail(
            `${at}: tool "${toolName}" declares no output of kind "${kind}"`,
          );
        }
        continue;
      }
      const role = selector.slice('role:'.length);
      const spec = producibleRoleSpecs.get(role);
      if (!spec) {
        fail(
          `${at}: tool "${toolName}" declares no artifact output with ` +
            `role "${role}"`,
        );
      }
      if (
        role === 'transcript' &&
        (spec.kind !== 'file' ||
          spec.mimeTypes?.length !== 1 ||
          spec.mimeTypes[0] !== 'text/plain')
      ) {
        fail(
          `${at}: a transcript selector must point at a bounded UTF-8 ` +
            `text/plain file output, but tool "${toolName}" declares ` +
            `role "transcript" differently`,
        );
      }
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
    output: { reprocessMedia, source, artifacts },
    stage,
    ...(description !== undefined ? { description } : {}),
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

/** A numeric bound with its exclusivity, for the §11.2 range checks. */
interface NumericBound {
  value: number;
  exclusive: boolean;
}

/** Effective lower bound of a property schema: the tighter of `minimum`
 * and (numeric draft-2020) `exclusiveMinimum` — higher value wins, an
 * exclusive bound beats an inclusive one at the same value. */
function lowerBoundOf(s: Record<string, unknown>): NumericBound | undefined {
  let bound: NumericBound | undefined;
  if (typeof s['minimum'] === 'number') {
    bound = { value: s['minimum'], exclusive: false };
  }
  if (typeof s['exclusiveMinimum'] === 'number') {
    const b = { value: s['exclusiveMinimum'], exclusive: true };
    if (!bound || b.value >= bound.value) bound = b;
  }
  return bound;
}

/** Effective upper bound: the tighter of `maximum` and
 * `exclusiveMaximum` — lower value wins, exclusive beats inclusive. */
function upperBoundOf(s: Record<string, unknown>): NumericBound | undefined {
  let bound: NumericBound | undefined;
  if (typeof s['maximum'] === 'number') {
    bound = { value: s['maximum'], exclusive: false };
  }
  if (typeof s['exclusiveMaximum'] === 'number') {
    const b = { value: s['exclusiveMaximum'], exclusive: true };
    if (!bound || b.value <= bound.value) bound = b;
  }
  return bound;
}

/**
 * §11.2 constraint-VALUE narrowing: given one native property schema and
 * the projection override that will be merged over it
 * (`{...native, ...override}` in model-access.ts), return a description
 * of the first constraint the merge would LOOSEN, or undefined when the
 * merged schema is at least as tight as the native one. Covers the
 * design's "类型、枚举、范围" beyond the property-set check: `type`,
 * `enum` subsets, numeric ranges (minimum/maximum and their exclusive
 * forms considered together), and the minLength/maxLength/
 * minItems/maxItems scalar families.
 */
function findProjectionLoosening(
  native: Record<string, unknown>,
  override: Record<string, unknown>,
): string | undefined {
  const merged: Record<string, unknown> = { ...native, ...override };

  // Type may not change — a different type is a different surface, not a
  // narrowing. The one true narrowing is integer over number.
  if (typeof native['type'] === 'string' && merged['type'] !== native['type']) {
    if (!(native['type'] === 'number' && merged['type'] === 'integer')) {
      return (
        `"type" changes the native type ` +
        `(${JSON.stringify(merged['type'])} vs native "${native['type']}")`
      );
    }
  }

  // enum: the projected value set must be a subset of the native one.
  if (Array.isArray(native['enum'])) {
    if (!Array.isArray(merged['enum'])) {
      return '"enum" replaces the native enum with a non-array';
    }
    const allowed = new Set(native['enum'].map((v) => JSON.stringify(v)));
    const added = merged['enum'].filter((v) => !allowed.has(JSON.stringify(v)));
    if (added.length > 0) {
      return (
        `"enum" adds values the native enum does not allow ` +
        `(${added.map((v) => JSON.stringify(v)).join(', ')})`
      );
    }
  }

  // Numeric range: the merged effective bounds may not extend past the
  // native effective bounds.
  const nativeLower = lowerBoundOf(native);
  if (nativeLower) {
    const mergedLower = lowerBoundOf(merged);
    if (
      !mergedLower ||
      mergedLower.value < nativeLower.value ||
      (mergedLower.value === nativeLower.value &&
        nativeLower.exclusive &&
        !mergedLower.exclusive)
    ) {
      return (
        `the lower bound loosens the native one ` +
        `(${mergedLower?.value ?? 'none'} vs native ${nativeLower.value})`
      );
    }
  }
  const nativeUpper = upperBoundOf(native);
  if (nativeUpper) {
    const mergedUpper = upperBoundOf(merged);
    if (
      !mergedUpper ||
      mergedUpper.value > nativeUpper.value ||
      (mergedUpper.value === nativeUpper.value &&
        nativeUpper.exclusive &&
        !mergedUpper.exclusive)
    ) {
      return (
        `the upper bound loosens the native one ` +
        `(${mergedUpper?.value ?? 'none'} vs native ${nativeUpper.value})`
      );
    }
  }

  // Scalar tightness families: min* may not shrink, max* may not grow.
  for (const key of ['minLength', 'minItems'] as const) {
    const n = native[key];
    if (typeof n !== 'number') continue;
    const m = merged[key];
    if (typeof m !== 'number' || m < n) {
      return `"${key}" loosens the native constraint (${JSON.stringify(m)} vs native ${n})`;
    }
  }
  for (const key of ['maxLength', 'maxItems'] as const) {
    const n = native[key];
    if (typeof n !== 'number') continue;
    const m = merged[key];
    if (typeof m !== 'number' || m > n) {
      return `"${key}" loosens the native constraint (${JSON.stringify(m)} vs native ${n})`;
    }
  }
  return undefined;
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

    // §13 #1: unknown keys are errors — a typo like "settigns" or
    // "modelaccess" would otherwise read as absent downstream and the
    // intended configuration would silently never take effect.
    rejectUnknownKeys(entry, where, ['settings', 'runtime', 'modelAccess']);

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
      rejectUnknownKeys(entry['runtime'], `${where}.runtime`, ['timeoutMs']);
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
    rejectUnknownKeys(modelAccess, `${where}.modelAccess`, [
      'enabled',
      'description',
      'defaultArguments',
      'lockedArguments',
      'parameterSchema',
      'output',
    ]);
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
    const nativeSchema = tool.parameterSchema;
    const nativeProperties =
      isPlainRecord(nativeSchema) && isPlainRecord(nativeSchema['properties'])
        ? nativeSchema['properties']
        : undefined;
    // defaultArguments/lockedArguments are merged into every invocation's
    // args (defaults + caller args + locked), so a key the tool's native
    // schema does not declare, or a value its sub-schema rejects, would
    // fail EVERY invocation at build time. Catch the misconfiguration at
    // startup instead of per-call. `required` is intentionally dropped:
    // these records are partial arg sets, the io params arrive per-run.
    if (nativeProperties !== undefined) {
      for (const [label, record] of [
        ['defaultArguments', defaults],
        ['lockedArguments', locked],
      ] as const) {
        if (!isPlainRecord(record)) continue;
        const error = SchemaValidator.validate(
          {
            type: 'object',
            properties: nativeProperties,
            additionalProperties: false,
          },
          record,
        );
        if (error) {
          fail(`${where}.modelAccess.${label}: ${error}`);
        }
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
      const nativeProps =
        nativeProperties !== undefined
          ? new Set(Object.keys(nativeProperties))
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
      // §11.2 in full: narrowing covers constraint VALUES, not just the
      // property set. The declaration merges each projected property's
      // keys over the native ones (model-access.ts), so an override
      // carrying a looser bound would promise the model a range the
      // native per-call validation then rejects — the exact per-call
      // misconfiguration this startup check exists to prevent.
      if (
        isPlainRecord(projection['properties']) &&
        nativeProperties !== undefined
      ) {
        for (const [prop, override] of Object.entries(
          projection['properties'],
        )) {
          const native = nativeProperties[prop];
          if (!isPlainRecord(override) || !isPlainRecord(native)) continue;
          const loosening = findProjectionLoosening(native, override);
          if (loosening !== undefined) {
            fail(
              `${where}.modelAccess.parameterSchema.properties.${prop}: ` +
                `${loosening} (projection may only narrow)`,
            );
          }
        }
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
  // Token-guard threshold: settings load performs no runtime type checks,
  // and guard.ts compares with `<=`/`>` — a string here would make both
  // comparisons false and silently disable the guard (fail-open). Reject
  // anything but a finite number ≥ 0 (0/unset = guard disabled).
  if (raw.maxEstimatedTokens !== undefined) {
    const tokens = raw.maxEstimatedTokens;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
      fail(
        `omni.processing.transportGuard.maxEstimatedTokens: must be a ` +
          `finite number >= 0, where 0 disables the token guard ` +
          `(got ${JSON.stringify(tokens)})`,
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
