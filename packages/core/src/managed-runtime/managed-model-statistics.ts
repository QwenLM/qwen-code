/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ModelInvocationObservation,
  ModelObservationFailure,
  ModelObservationOutcome,
  ModelObservationSource,
} from '../telemetry/model-observation.js';
import { outputTokenCount } from '../telemetry/gen-ai-usage.js';
import { ManagedSessionRecordError } from './managed-session-records.js';

export const MANAGED_MODEL_STATISTICS_KINDS = Object.freeze({
  main: 'managed-hosted-model-usage-v2',
  hook: 'managed-hook-model-usage-v2',
  snapshot: 'managed-session-model-stats',
});
export const MANAGED_MODEL_STATISTICS_RESOURCE_KINDS: ReadonlySet<string> =
  new Set(Object.values(MANAGED_MODEL_STATISTICS_KINDS));
export const MANAGED_MODEL_STATISTICS_LIMITS = Object.freeze({
  statisticsBytes: 40 * 1024,
  contextBytes: 8 * 1024,
  envelopeBytes: 64 * 1024,
  models: 16,
  recent: 20,
  details: 32,
  nameBytes: 128,
});
export const MODEL_STATISTICS_GAPS = [
  'legacy_history',
  'unclosed_turn',
  'unclosed_model_attempt',
  'unclosed_maintenance',
  'observation_error',
  'missing_usage',
  'interrupted_observation',
  'counter_overflow',
] as const;
export type ModelStatisticsGap = (typeof MODEL_STATISTICS_GAPS)[number];
const SOURCES = ['main', 'hook', 'compression'] as const;
const OUTCOMES = ['success', 'error', 'cancelled', 'interrupted'] as const;
const FAILURES = ['http', 'transport', 'timeout', 'other'] as const;
const TOKEN_KEYS = [
  'prompt',
  'candidates',
  'total',
  'cached',
  'thoughts',
] as const;
export const MANAGED_CONTEXT_CATEGORIES = [
  'systemPrompt',
  'builtinTools',
  'mcpTools',
  'instructionFiles',
  'memoryFiles',
  'skills',
  'startupContext',
  'messages',
] as const;
export type ManagedContextCategory =
  (typeof MANAGED_CONTEXT_CATEGORIES)[number];
type TokenCounts = Record<(typeof TOKEN_KEYS)[number], number>;

export interface ManagedModelMetricBucket {
  requests: Record<ModelObservationOutcome | 'total', number>;
  tokens: TokenCounts;
  usageKnown: TokenCounts;
  latencyMs: number;
  timing: {
    ttftCount: number;
    totalTtftMs: number;
    generationCount: number;
    totalGenerationMs: number;
    throughputOutputTokens: number;
  };
  failures: Record<ModelObservationFailure, number>;
  backoffRetries: number;
}

export interface ManagedModelStatisticsSample {
  executionId: string;
  source: ModelObservationSource;
  modelKey: string;
  at: number;
  outcome: ModelObservationOutcome;
  durationMs: number;
  ttftMs: number | null;
  generationMs: number | null;
  outputTokens: number | null;
  failureKind: ModelObservationFailure | null;
  statusCode: number | null;
  backoffRetryOrdinal: number;
}

export interface ManagedModelStatistics {
  version: 1;
  snapshotRevision: number;
  observedAt: number;
  rawOutputTokensTotal: number;
  coverage: { gaps: ModelStatisticsGap[] };
  totals: ManagedModelMetricBucket;
  sources: Record<ModelObservationSource, ManagedModelMetricBucket>;
  models: Array<{
    key: string;
    name: string | null;
    nameTruncated: boolean;
    metrics: ManagedModelMetricBucket;
  }>;
  overflow: ManagedModelMetricBucket;
  recent: ManagedModelStatisticsSample[];
  modelBreakdownOmitted: boolean;
  samplesTruncated: boolean;
}

export interface ManagedCommittedContext {
  version: 1;
  attemptId: string;
  turnId: string;
  model: string;
  providerPin: string;
  observedAt: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  contextWindowSize: number | null;
  breakdown: Record<ManagedContextCategory, number>;
  thresholds: { warn: number; auto: number; hard: number } | null;
  details: Array<{
    category: ManagedContextCategory;
    name: string;
    tokens: number;
  }>;
  attributionComplete: boolean;
  detailsTruncated: boolean;
}

export interface ManagedStatisticsBudget {
  sessionId: string;
  promptId: string;
  budget: number | null;
  outputTokensAtTurnStart: number;
}

interface StatisticsEnvelopeBase {
  budget: ManagedStatisticsBudget | null;
  statistics: ManagedModelStatistics;
  context: ManagedCommittedContext | null;
}
export type ManagedStatisticsEnvelope = StatisticsEnvelopeBase &
  (
    | { version: 1 }
    | { version: 2; turnId: string; model: string }
    | {
        version: 2;
        operationId: string;
        occurrenceId: string;
        originTurnId: string | null;
        eventName: string;
        model: string;
      }
  );

function fail(label: string): never {
  throw new ManagedSessionRecordError('Invalid model statistics: ' + label);
}

function closed(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  )
    fail(label);
  return record;
}

function count(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(label);
}

function counts(value: unknown, keys: readonly string[], label: string) {
  const record = closed(value, keys, label);
  for (const key of keys) count(record[key], label + '.' + key);
  return record;
}

function text(
  value: unknown,
  label: string,
  limit = 128,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > limit ||
    Array.from(value).some(isControlCharacter)
  )
    fail(label);
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
}

function flag(value: unknown, label: string): void {
  if (typeof value !== 'boolean') fail(label);
}

function oneOf(value: unknown, values: readonly string[], label: string): void {
  if (typeof value !== 'string' || !values.includes(value)) fail(label);
}

function hash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(label);
}

function byteLimit(value: unknown, limit: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) fail(label + ' bytes');
}

function validateBucket(value: unknown): void {
  const b = closed(
    value,
    [
      'requests',
      'tokens',
      'usageKnown',
      'latencyMs',
      'timing',
      'failures',
      'backoffRetries',
    ],
    'bucket',
  );
  const requests = counts(b['requests'], ['total', ...OUTCOMES], 'requests');
  const total = requests['total'] as number;
  const sum = OUTCOMES.reduce(
    (result, outcome) => result + BigInt(requests[outcome] as number),
    0n,
  );
  if (
    BigInt(total) !==
    (sum > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : sum)
  )
    fail('request totals');
  counts(b['tokens'], TOKEN_KEYS, 'tokens');
  const known = counts(b['usageKnown'], TOKEN_KEYS, 'usageKnown');
  if (Object.values(known).some((n) => (n as number) > total))
    fail('usageKnown exceeds requests');
  count(b['latencyMs'], 'latencyMs');
  counts(
    b['timing'],
    [
      'ttftCount',
      'totalTtftMs',
      'generationCount',
      'totalGenerationMs',
      'throughputOutputTokens',
    ],
    'timing',
  );
  counts(b['failures'], FAILURES, 'failures');
  count(b['backoffRetries'], 'backoffRetries');
}

export function parseManagedModelStatistics(
  value: unknown,
): ManagedModelStatistics {
  const s = closed(
    value,
    [
      'version',
      'snapshotRevision',
      'observedAt',
      'rawOutputTokensTotal',
      'coverage',
      'totals',
      'sources',
      'models',
      'overflow',
      'recent',
      'modelBreakdownOmitted',
      'samplesTruncated',
    ],
    'statistics',
  );
  if (s['version'] !== 1) fail('version');
  count(s['snapshotRevision'], 'snapshotRevision');
  if (s['snapshotRevision'] < 1) fail('snapshotRevision');
  count(s['observedAt'], 'observedAt');
  count(s['rawOutputTokensTotal'], 'rawOutputTokensTotal');
  const gaps = closed(s['coverage'], ['gaps'], 'coverage')['gaps'];
  if (
    !Array.isArray(gaps) ||
    gaps.length > MODEL_STATISTICS_GAPS.length ||
    new Set(gaps).size !== gaps.length
  )
    fail('coverage gaps');
  gaps.forEach((gap) => oneOf(gap, MODEL_STATISTICS_GAPS, 'gap'));
  if (
    JSON.stringify(gaps) !==
    JSON.stringify(MODEL_STATISTICS_GAPS.filter((gap) => gaps.includes(gap)))
  )
    fail('gap order');
  validateBucket(s['totals']);
  validateBucket(s['overflow']);
  const sources = closed(s['sources'], SOURCES, 'sources');
  SOURCES.forEach((source) => validateBucket(sources[source]));
  const models = s['models'];
  if (
    !Array.isArray(models) ||
    models.length > MANAGED_MODEL_STATISTICS_LIMITS.models
  )
    fail('models');
  const keys = new Set<string>();
  for (const model of models) {
    const m = closed(
      model,
      ['key', 'name', 'nameTruncated', 'metrics'],
      'model',
    );
    hash(m['key'], 'model key');
    if (keys.has(m['key'] as string)) fail('duplicate model');
    keys.add(m['key'] as string);
    if (m['name'] !== null) text(m['name'], 'model name');
    flag(m['nameTruncated'], 'nameTruncated');
    validateBucket(m['metrics']);
  }
  const recent = s['recent'];
  if (
    !Array.isArray(recent) ||
    recent.length > MANAGED_MODEL_STATISTICS_LIMITS.recent
  )
    fail('recent');
  const executions = new Set<string>();
  for (const item of recent) {
    const sample = closed(
      item,
      [
        'executionId',
        'source',
        'modelKey',
        'at',
        'outcome',
        'durationMs',
        'ttftMs',
        'generationMs',
        'outputTokens',
        'failureKind',
        'statusCode',
        'backoffRetryOrdinal',
      ],
      'sample',
    );
    if (
      typeof sample['executionId'] !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        sample['executionId'],
      ) ||
      executions.has(sample['executionId'])
    )
      fail('executionId');
    executions.add(sample['executionId']);
    oneOf(sample['source'], SOURCES, 'source');
    oneOf(sample['outcome'], OUTCOMES, 'outcome');
    hash(sample['modelKey'], 'modelKey');
    for (const key of ['at', 'durationMs', 'backoffRetryOrdinal'])
      count(sample[key], key);
    for (const key of ['ttftMs', 'generationMs', 'outputTokens'])
      if (sample[key] !== null) count(sample[key], key);
    if (sample['failureKind'] !== null)
      oneOf(sample['failureKind'], FAILURES, 'failureKind');
    if (sample['statusCode'] !== null) {
      count(sample['statusCode'], 'statusCode');
      if (sample['statusCode'] < 100 || sample['statusCode'] > 599)
        fail('statusCode');
    }
  }
  flag(s['modelBreakdownOmitted'], 'modelBreakdownOmitted');
  if (s['modelBreakdownOmitted'] && models.length !== 0) fail('omitted models');
  flag(s['samplesTruncated'], 'samplesTruncated');
  byteLimit(
    value,
    MANAGED_MODEL_STATISTICS_LIMITS.statisticsBytes,
    'statistics',
  );
  return structuredClone(value) as ManagedModelStatistics;
}

export function parseManagedCommittedContext(
  value: unknown,
): ManagedCommittedContext {
  const c = closed(
    value,
    [
      'version',
      'attemptId',
      'turnId',
      'model',
      'providerPin',
      'observedAt',
      'inputTokens',
      'cachedTokens',
      'contextWindowSize',
      'breakdown',
      'thresholds',
      'details',
      'attributionComplete',
      'detailsTruncated',
    ],
    'context',
  );
  if (c['version'] !== 1) fail('context version');
  for (const key of ['attemptId', 'turnId', 'model']) text(c[key], key, 512);
  hash(c['providerPin'], 'providerPin');
  count(c['observedAt'], 'observedAt');
  for (const key of ['inputTokens', 'cachedTokens', 'contextWindowSize'])
    if (c[key] !== null) count(c[key], key);
  if (c['contextWindowSize'] === 0) fail('contextWindowSize');
  counts(c['breakdown'], MANAGED_CONTEXT_CATEGORIES, 'breakdown');
  if (c['thresholds'] !== null) {
    const thresholds = closed(
      c['thresholds'],
      ['warn', 'auto', 'hard'],
      'thresholds',
    );
    let previous = 0;
    for (const key of ['warn', 'auto', 'hard']) {
      const value = thresholds[key];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < previous ||
        value > 1
      )
        fail('thresholds');
      previous = value;
    }
  }
  const details = c['details'];
  if (
    !Array.isArray(details) ||
    details.length > MANAGED_MODEL_STATISTICS_LIMITS.details
  )
    fail('details');
  for (const detail of details) {
    const d = closed(detail, ['category', 'name', 'tokens'], 'detail');
    oneOf(d['category'], MANAGED_CONTEXT_CATEGORIES, 'category');
    text(d['name'], 'detail name');
    count(d['tokens'], 'detail tokens');
  }
  flag(c['attributionComplete'], 'attributionComplete');
  flag(c['detailsTruncated'], 'detailsTruncated');
  byteLimit(value, MANAGED_MODEL_STATISTICS_LIMITS.contextBytes, 'context');
  return structuredClone(value) as ManagedCommittedContext;
}

export function parseManagedStatisticsEnvelope(
  kind: string,
  value: unknown,
): ManagedStatisticsEnvelope {
  const main = kind === MANAGED_MODEL_STATISTICS_KINDS.main;
  const hook = kind === MANAGED_MODEL_STATISTICS_KINDS.hook;
  if (!main && !hook && kind !== MANAGED_MODEL_STATISTICS_KINDS.snapshot)
    fail('resource kind');
  const e = closed(
    value,
    [
      'version',
      'budget',
      'statistics',
      'context',
      ...(main
        ? ['turnId', 'model']
        : hook
          ? [
              'operationId',
              'occurrenceId',
              'originTurnId',
              'eventName',
              'model',
            ]
          : []),
    ],
    'envelope',
  );
  if (e['version'] !== (main || hook ? 2 : 1)) fail('envelope version');
  for (const key of main
    ? ['turnId', 'model']
    : hook
      ? ['operationId', 'occurrenceId', 'eventName', 'model']
      : [])
    text(e[key], key, 512);
  if (hook && e['originTurnId'] !== null)
    text(e['originTurnId'], 'originTurnId', 512);
  if (e['budget'] !== null) {
    const b = closed(
      e['budget'],
      ['sessionId', 'promptId', 'budget', 'outputTokensAtTurnStart'],
      'budget',
    );
    text(b['sessionId'], 'budget sessionId', 512);
    text(b['promptId'], 'budget promptId', 512);
    if (b['budget'] !== null) count(b['budget'], 'budget');
    count(b['outputTokensAtTurnStart'], 'outputTokensAtTurnStart');
  }
  parseManagedModelStatistics(e['statistics']);
  if (e['context'] !== null) {
    if (!main) fail('only main carries context');
    const context = parseManagedCommittedContext(e['context']);
    if (context.turnId !== e['turnId'] || context.model !== e['model'])
      fail('context binding');
  }
  byteLimit(value, MANAGED_MODEL_STATISTICS_LIMITS.envelopeBytes, 'envelope');
  return structuredClone(value) as ManagedStatisticsEnvelope;
}

const zeroTokens = (): TokenCounts => ({
  prompt: 0,
  candidates: 0,
  total: 0,
  cached: 0,
  thoughts: 0,
});
export const createManagedModelMetricBucket = (): ManagedModelMetricBucket => ({
  requests: { total: 0, success: 0, error: 0, cancelled: 0, interrupted: 0 },
  tokens: zeroTokens(),
  usageKnown: zeroTokens(),
  latencyMs: 0,
  timing: {
    ttftCount: 0,
    totalTtftMs: 0,
    generationCount: 0,
    totalGenerationMs: 0,
    throughputOutputTokens: 0,
  },
  failures: { http: 0, transport: 0, timeout: 0, other: 0 },
  backoffRetries: 0,
});

export function createManagedModelStatistics(): ManagedModelStatistics {
  return {
    version: 1,
    snapshotRevision: 1,
    observedAt: 0,
    rawOutputTokensTotal: 0,
    coverage: { gaps: [] },
    totals: createManagedModelMetricBucket(),
    sources: {
      main: createManagedModelMetricBucket(),
      hook: createManagedModelMetricBucket(),
      compression: createManagedModelMetricBucket(),
    },
    models: [],
    overflow: createManagedModelMetricBucket(),
    recent: [],
    modelBreakdownOmitted: false,
    samplesTruncated: false,
  };
}

export function addModelStatisticsGap(
  statistics: ManagedModelStatistics,
  gap: ModelStatisticsGap,
): void {
  statistics.coverage.gaps = MODEL_STATISTICS_GAPS.filter(
    (item) => item === gap || statistics.coverage.gaps.includes(item),
  );
}

function plus(
  a: number,
  b: number,
  statistics: ManagedModelStatistics,
): number {
  if (a > Number.MAX_SAFE_INTEGER - b) {
    addModelStatisticsGap(statistics, 'counter_overflow');
    return Number.MAX_SAFE_INTEGER;
  }
  return a + b;
}

export function boundedModelName(value: string): string {
  let result = '';
  for (const character of value) {
    if (isControlCharacter(character)) continue;
    if (
      Buffer.byteLength(result + character) >
      MANAGED_MODEL_STATISTICS_LIMITS.nameBytes
    )
      break;
    result += character;
  }
  return result || 'unknown';
}

export function recordManagedModelObservation(
  statistics: ManagedModelStatistics,
  event: ModelInvocationObservation,
): void {
  const key = createHash('sha256').update(event.model).digest('hex');
  let model = statistics.models.find((entry) => entry.key === key);
  if (
    !model &&
    !statistics.modelBreakdownOmitted &&
    statistics.models.length < MANAGED_MODEL_STATISTICS_LIMITS.models
  ) {
    const name = boundedModelName(event.model);
    model = {
      key,
      name,
      nameTruncated: name !== event.model,
      metrics: createManagedModelMetricBucket(),
    };
    statistics.models.push(model);
  }
  const usage = event.usage;
  const input =
    usage?.promptTokenCount === undefined
      ? undefined
      : usage.promptTokenCount > 0
        ? usage.promptTokenCount
        : (usage.cachedContentTokenCount ?? usage.promptTokenCount);
  const rawOutput = usage?.candidatesTokenCount;
  const thoughts = usage?.thoughtsTokenCount;
  const output =
    rawOutput === undefined
      ? undefined
      : plus(
          0,
          outputTokenCount(
            {
              input: input ?? 0,
              output: rawOutput,
              thoughts: thoughts ?? 0,
              total: input === undefined ? 0 : (usage?.totalTokenCount ?? 0),
            },
            event.authType,
          ),
          statistics,
        );
  const total =
    usage?.totalTokenCount && usage.totalTokenCount > 0
      ? usage.totalTokenCount
      : input !== undefined && output !== undefined
        ? plus(input, output, statistics)
        : undefined;
  const tokens = {
    prompt: input,
    candidates: output,
    total,
    cached: usage?.cachedContentTokenCount,
    thoughts,
  };
  if (TOKEN_KEYS.some((name) => tokens[name] === undefined))
    addModelStatisticsGap(statistics, 'missing_usage');
  if (event.outcome === 'interrupted')
    addModelStatisticsGap(statistics, 'interrupted_observation');
  for (const bucket of [
    statistics.totals,
    statistics.sources[event.source],
    model?.metrics ?? statistics.overflow,
  ]) {
    bucket.requests.total = plus(bucket.requests.total, 1, statistics);
    bucket.requests[event.outcome] = plus(
      bucket.requests[event.outcome],
      1,
      statistics,
    );
    bucket.latencyMs = plus(bucket.latencyMs, event.durationMs, statistics);
    if (event.backoffRetryOrdinal > 0)
      bucket.backoffRetries = plus(bucket.backoffRetries, 1, statistics);
    if (event.failureKind)
      bucket.failures[event.failureKind] = plus(
        bucket.failures[event.failureKind],
        1,
        statistics,
      );
    for (const name of TOKEN_KEYS) {
      const value = tokens[name];
      if (value === undefined) continue;
      bucket.tokens[name] = plus(bucket.tokens[name], value, statistics);
      bucket.usageKnown[name] = plus(bucket.usageKnown[name], 1, statistics);
    }
    if (event.ttftMs !== undefined) {
      bucket.timing.ttftCount = plus(bucket.timing.ttftCount, 1, statistics);
      bucket.timing.totalTtftMs = plus(
        bucket.timing.totalTtftMs,
        event.ttftMs,
        statistics,
      );
    }
    if (
      event.generationMs !== undefined &&
      event.generationMs >= 100 &&
      output !== undefined
    ) {
      bucket.timing.generationCount = plus(
        bucket.timing.generationCount,
        1,
        statistics,
      );
      bucket.timing.totalGenerationMs = plus(
        bucket.timing.totalGenerationMs,
        event.generationMs,
        statistics,
      );
      bucket.timing.throughputOutputTokens = plus(
        bucket.timing.throughputOutputTokens,
        output,
        statistics,
      );
    }
  }
  statistics.observedAt = Math.max(statistics.observedAt, event.at);
  statistics.recent.push({
    executionId: event.executionId,
    source: event.source,
    modelKey: key,
    at: event.at,
    outcome: event.outcome,
    durationMs: event.durationMs,
    ttftMs: event.ttftMs ?? null,
    generationMs: event.generationMs ?? null,
    outputTokens: output ?? null,
    failureKind: event.failureKind,
    statusCode: event.statusCode,
    backoffRetryOrdinal: event.backoffRetryOrdinal,
  });
  if (statistics.recent.length > MANAGED_MODEL_STATISTICS_LIMITS.recent) {
    statistics.recent.shift();
    statistics.samplesTruncated = true;
  }
}

function mergeBucket(
  into: ManagedModelMetricBucket,
  from: ManagedModelMetricBucket,
  statistics: ManagedModelStatistics,
): void {
  for (const key of [
    'requests',
    'tokens',
    'usageKnown',
    'timing',
    'failures',
  ] as const) {
    const target = into[key] as Record<string, number>;
    for (const [name, value] of Object.entries(from[key]))
      target[name] = plus(target[name], value, statistics);
  }
  into.latencyMs = plus(into.latencyMs, from.latencyMs, statistics);
  into.backoffRetries = plus(
    into.backoffRetries,
    from.backoffRetries,
    statistics,
  );
}

export function boundManagedModelStatistics(
  statistics: ManagedModelStatistics,
): ManagedModelStatistics {
  const result = structuredClone(statistics);
  const fits = () =>
    Buffer.byteLength(JSON.stringify(result)) <=
    MANAGED_MODEL_STATISTICS_LIMITS.statisticsBytes;
  while (!fits() && result.recent.length) {
    result.recent.shift();
    result.samplesTruncated = true;
  }
  if (!fits()) for (const model of result.models) model.name = null;
  if (!fits()) {
    for (const model of result.models)
      mergeBucket(result.overflow, model.metrics, result);
    result.models = [];
    result.modelBreakdownOmitted = true;
  }
  return parseManagedModelStatistics(result);
}

export function boundManagedCommittedContext(
  context: ManagedCommittedContext,
): ManagedCommittedContext {
  const result = structuredClone(context);
  result.details = result.details.slice(
    0,
    MANAGED_MODEL_STATISTICS_LIMITS.details,
  );
  result.detailsTruncated ||= context.details.length !== result.details.length;
  while (
    Buffer.byteLength(JSON.stringify(result)) >
      MANAGED_MODEL_STATISTICS_LIMITS.contextBytes &&
    result.details.length
  ) {
    result.details.pop();
    result.detailsTruncated = true;
  }
  return parseManagedCommittedContext(result);
}
