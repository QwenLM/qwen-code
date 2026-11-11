/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseObjectGateValue } from './gateParseUtils.js';

export const PROMPT_POLICY_FEATURE_GATE = 'prompt_policy';

export const PROMPT_SECTION_GATE_KEYS = [
  'communication.turn_updates',
  'behavior.verified_vs_assumed',
  'behavior.act_dont_rederive',
  'behavior.delivering_work',
  'behavior.overcorrection',
  'behavior.tool_argument_json',
  'behavior.autonomy',
] as const;

export type PromptSectionGateKey = (typeof PROMPT_SECTION_GATE_KEYS)[number];
export type RemoteBundleMode = 'full' | 'lean';
export type RemoteSectionMode = 'enable' | 'disable';

export const PROMPT_MODEL_BEHAVIOR_KEYS = [
  'mitigations',
  'frontendGuidance',
  'modernDefaults',
  'extendedDefaults',
  'turnUpdates',
  'outcomeFirst',
] as const;
export const PROMPT_BEHAVIOR_FLAG_KEYS = [
  'turnUpdates',
  'outcomeFirst',
  'autonomy',
  'autonomyEnabled',
  'deliveringWork',
  'extendedDefaultsDisabled',
  'brief',
] as const;
export type PromptModelBehavior = Readonly<
  Partial<Record<(typeof PROMPT_MODEL_BEHAVIOR_KEYS)[number], boolean>> & {
    frontendGuidanceText?: string;
  }
>;
export type PromptBehaviorFlags = Readonly<
  Partial<Record<(typeof PROMPT_BEHAVIOR_FLAG_KEYS)[number], boolean>>
>;

export interface PromptPolicySnapshot {
  readonly bundleByModel: Readonly<Partial<Record<string, RemoteBundleMode>>>;
  readonly sectionGates: Readonly<
    Partial<Record<PromptSectionGateKey, RemoteSectionMode>>
  >;
  /** Explicit traits of the effective model; unknown models do not inherit a profile. */
  readonly behaviorByModel?: Readonly<Record<string, PromptModelBehavior>>;
  readonly behaviorFlags?: PromptBehaviorFlags;
}

export function isPromptSectionGateKey(
  value: string,
): value is PromptSectionGateKey {
  return (PROMPT_SECTION_GATE_KEYS as readonly string[]).includes(value);
}

function freezePolicy(
  bundleByModel: Partial<Record<string, RemoteBundleMode>>,
  sectionGates: Partial<Record<PromptSectionGateKey, RemoteSectionMode>>,
  behaviorByModel?: Record<string, PromptModelBehavior>,
  behaviorFlags?: PromptBehaviorFlags,
): PromptPolicySnapshot {
  return Object.freeze({
    bundleByModel: Object.freeze({ ...bundleByModel }),
    sectionGates: Object.freeze({ ...sectionGates }),
    ...(behaviorByModel && {
      behaviorByModel: Object.freeze({ ...behaviorByModel }),
    }),
    ...(behaviorFlags && {
      behaviorFlags: Object.freeze({ ...behaviorFlags }),
    }),
  });
}

const EMPTY_PROMPT_POLICY = freezePolicy({}, {});
let currentPromptPolicy = EMPTY_PROMPT_POLICY;
let lastParsedRawValue: unknown;

function logUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    runLogger.warn('[config-service] Ignoring unknown prompt_policy keys', {
      field,
      keys: unknown,
    });
  }
}

const BUNDLE_MODES: readonly RemoteBundleMode[] = ['full', 'lean'];
const SECTION_MODES: readonly RemoteSectionMode[] = ['enable', 'disable'];

/**
 * 抽出指定 key 上的合法枚举值；遇到非法值返回 undefined（整个 policy 作废）。
 */
function parseModeMap<K extends string, M extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
  modes: readonly M[],
): Partial<Record<K, M>> | undefined {
  const entries: Array<[K, M]> = [];
  for (const key of keys) {
    if (!Object.hasOwn(raw, key)) continue;
    const mode = raw[key];
    if (
      typeof mode !== 'string' ||
      !(modes as readonly string[]).includes(mode)
    ) {
      return undefined;
    }
    entries.push([key, mode as M]);
  }
  return Object.fromEntries(entries) as Partial<Record<K, M>>;
}

/**
 * 取出 payload 上的嵌套对象字段。缺省视为空对象，非法值返回 undefined
 * 让整个 policy 作废——校验与取值合成一处，新增字段只需多一行调用。
 */
function nestedRecord(
  payload: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(payload, field)) return {};
  const value = payload[field];
  // 嵌套字段必须已经是对象：这里不接受 JSON 字符串，避免双重编码的 payload。
  if (typeof value === 'string') return undefined;
  return parseObjectGateValue(value);
}

function parseBooleanFields<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
  field: string,
): Readonly<Partial<Record<K, boolean>>> | undefined {
  logUnknownKeys(raw, keys, field);
  const result: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (typeof value !== 'boolean') return undefined;
    result[key] = value;
  }
  return Object.freeze(result);
}

export function parsePromptPolicyValue(
  value: unknown,
): PromptPolicySnapshot | undefined {
  const payload = parseObjectGateValue(value);
  if (!payload) return undefined;

  logUnknownKeys(
    payload,
    ['bundleByModel', 'sectionGates', 'behaviorByModel', 'behaviorFlags'],
    'payload',
  );
  const rawBundles = nestedRecord(payload, 'bundleByModel');
  const rawSections = nestedRecord(payload, 'sectionGates');
  if (!rawBundles || !rawSections) return undefined;

  logUnknownKeys(
    rawSections,
    PROMPT_SECTION_GATE_KEYS as readonly string[],
    'sectionGates',
  );

  const bundleByModel = parseModeMap(
    rawBundles,
    Object.keys(rawBundles),
    BUNDLE_MODES,
  );
  const sectionGates = parseModeMap(
    rawSections,
    PROMPT_SECTION_GATE_KEYS,
    SECTION_MODES,
  );
  if (!bundleByModel || !sectionGates) return undefined;

  let behaviorByModel: Record<string, PromptModelBehavior> | undefined;
  if (Object.hasOwn(payload, 'behaviorByModel')) {
    const rawModels = nestedRecord(payload, 'behaviorByModel');
    if (!rawModels) return undefined;
    const entries: Array<[string, PromptModelBehavior]> = [];
    for (const model of Object.keys(rawModels)) {
      const raw = nestedRecord(rawModels, model);
      if (!raw) return undefined;
      const { frontendGuidanceText, ...flags } = raw;
      const text =
        typeof frontendGuidanceText === 'string'
          ? frontendGuidanceText.trim()
          : '';
      if (Object.hasOwn(raw, 'frontendGuidanceText') && !text) return undefined;
      const parsed = parseBooleanFields(
        flags,
        PROMPT_MODEL_BEHAVIOR_KEYS,
        `behaviorByModel.${model}`,
      );
      if (!parsed) return undefined;
      entries.push([
        model,
        text ? Object.freeze({ ...parsed, frontendGuidanceText: text }) : parsed,
      ]);
    }
    behaviorByModel = Object.fromEntries(entries);
  }
  let behaviorFlags: PromptBehaviorFlags | undefined;
  if (Object.hasOwn(payload, 'behaviorFlags')) {
    const rawFlags = nestedRecord(payload, 'behaviorFlags');
    if (!rawFlags) return undefined;
    behaviorFlags = parseBooleanFields(
      rawFlags,
      PROMPT_BEHAVIOR_FLAG_KEYS,
      'behaviorFlags',
    );
    if (!behaviorFlags) return undefined;
  }
  return freezePolicy(
    bundleByModel,
    sectionGates,
    behaviorByModel,
    behaviorFlags,
  );
}

function updatePromptPolicyIfValid(value: unknown): boolean {
  const parsed = parsePromptPolicyValue(value);
  if (!parsed) {
    runLogger.warn(
      '[config-service] Ignoring invalid prompt_policy feature gate value',
      { value },
    );
    return false;
  }
  currentPromptPolicy = parsed;
  return true;
}

/**
 * 每个 turn 都会调用：命中同一个原始 gate 值时跳过重新解析，
 * 并直接返回已冻结的快照（无需再拷贝一层）。
 */
export function getPromptPolicySnapshot(): PromptPolicySnapshot {
  const fresh = getConfigValue(PROMPT_POLICY_FEATURE_GATE);
  if (fresh !== undefined && fresh !== lastParsedRawValue) {
    lastParsedRawValue = fresh;
    updatePromptPolicyIfValid(fresh);
  }
  return currentPromptPolicy;
}

export function registerPromptPolicyFeature(): void {
  subscribeConfigValue(PROMPT_POLICY_FEATURE_GATE, (value) => {
    if (value === undefined) {
      // An explicit removal/invalidation must not retain another identity's
      // last-good policy. Malformed updates still preserve the current policy.
      currentPromptPolicy = EMPTY_PROMPT_POLICY;
      lastParsedRawValue = undefined;
      return;
    }

    if (updatePromptPolicyIfValid(value)) {
      // Serialised because util.inspect stops at depth 2 and would render
      // nested per-model maps as `[Object]`.
      runLogger.log(
        '[config-service] prompt_policy feature gate value received',
        { value: JSON.stringify(value) },
      );
    }
  });
}

export function _resetPromptPolicyForTesting(): void {
  currentPromptPolicy = EMPTY_PROMPT_POLICY;
  lastParsedRawValue = undefined;
}
