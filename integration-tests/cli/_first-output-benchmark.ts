/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const FIRST_OUTPUT_BENCHMARK_VERSION = 2 as const;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
export const DEFAULT_MATERIAL_THRESHOLD_MS = 10;
export const DEFAULT_ORDER_SENSITIVITY_THRESHOLD_MS = 10;
export const DEFAULT_FIRST_OUTPUT_EVENT_BUFFER_LIMIT = 256;

export type BenchmarkVariant = 'single' | 'control' | 'candidate';
export type PairOrder = 'AB' | 'BA';
export type FirstOutputKind = 'answer_text' | 'thought_text' | 'tool_call';
export type BenchmarkDecision =
  | 'improved'
  | 'regressed'
  | 'inconclusive'
  | 'invalid';

export function parseBenchmarkPostSessionDwell(
  configuredValue?: string,
): 0 | 100 | 500 {
  const raw = configuredValue?.trim() ?? '0';
  if (raw === '0' || raw === '100' || raw === '500') {
    return Number(raw) as 0 | 100 | 500;
  }
  throw new Error(
    'Invalid BENCHMARK_POST_SESSION_DWELL_MS: expected exactly 0, 100, or 500.',
  );
}

export function measuredPairCountForDwell(
  postSessionDwellMs: number,
  configuredValue?: string,
): 10 | 30 {
  const expected = postSessionDwellMs === 500 ? 10 : 30;
  const raw = configuredValue?.trim() ?? String(expected);
  if (raw !== '10' && raw !== '30') {
    throw new Error(
      'Invalid BENCHMARK_MEASURED_PAIRS: expected exactly 10 or 30.',
    );
  }
  const configured = Number(raw) as 10 | 30;
  if (configured !== expected) {
    throw new Error(
      `Invalid comparison sample plan: ${postSessionDwellMs}ms dwell ` +
        `requires exactly ${expected} measured pairs.`,
    );
  }
  return configured;
}

export interface BenchmarkDaemonEvent {
  id?: number;
  v?: number;
  type: string;
  data?: unknown;
  promptId?: string;
  _meta?: Record<string, unknown>;
}

export interface TimedDaemonEvent {
  event: BenchmarkDaemonEvent;
  receivedAtMs: number;
}

export interface ClassifiedFirstOutput {
  type: 'output';
  kind: FirstOutputKind;
  text: string | null;
  toolCallId: string | null;
  serverTimestampMs: number | null;
}

export interface ClassifiedTerminal {
  type: 'terminal';
  kind: 'complete' | 'error';
  stopReason: string | null;
  code: string | null;
  message: string | null;
}

export type IgnoredEventReason =
  | 'wrong_prompt_id'
  | 'unrelated_event'
  | 'malformed_update'
  | 'replay'
  | 'diagnostic'
  | 'non_output_update'
  | 'empty_content';

export interface IgnoredFirstOutputEvent {
  type: 'ignore';
  reason: IgnoredEventReason;
}

export type ClassifiedPromptEvent =
  | ClassifiedFirstOutput
  | ClassifiedTerminal
  | IgnoredFirstOutputEvent;

export interface FirstOutputObservation {
  kind: FirstOutputKind;
  receivedAtMs: number;
  eventId: number | null;
  text: string | null;
  toolCallId: string | null;
  serverTimestampMs: number | null;
}

export interface FirstOutputUserEchoObservation {
  receivedAtMs: number;
  eventId: number | null;
}

export interface FirstOutputTerminal {
  kind: 'complete' | 'error';
  receivedAtMs: number;
  eventId: number | null;
  stopReason: string | null;
  code: string | null;
  message: string | null;
}

export type TrackerFailureCode =
  | 'event_buffer_overflow'
  | 'terminal_before_first_output'
  | 'turn_error';

export interface FirstOutputTrackerSnapshot {
  promptId: string | null;
  bufferedEventCount: number;
  bufferedBeforeAcceptanceCount: number;
  matchingEventCount: number;
  matchingTerminalCount: number;
  userEcho: FirstOutputUserEchoObservation | null;
  firstOutput: FirstOutputObservation | null;
  firstAnswer: FirstOutputObservation | null;
  finalAnswerText: string | null;
  terminal: FirstOutputTerminal | null;
  failureCode: TrackerFailureCode | null;
  failureMessage: string | null;
  runEligible: boolean;
  answerMetricEligible: boolean;
}

export interface FirstOutputTrackerOptions {
  maxBufferedEvents?: number;
}

const COMPRESSION_DIAGNOSTIC_PREFIX = 'IMPORTANT: This conversation ';
const COMPRESSION_DIAGNOSTIC_MARKER =
  'A compressed context will be sent for future messages';
const NON_MODEL_OUTPUT_SOURCES = new Set([
  'background_notification',
  'background_notification_response',
  'slash_command',
  'todo_stop_guard',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number !== null) return number;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventServerTimestampMs(event: BenchmarkDaemonEvent): number | null {
  return parseTimestamp(event._meta?.['serverTimestamp']);
}

function isReplayMeta(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  return (
    isRecord(meta['qwenTranscript']) ||
    typeof meta['qwen.session.recordId'] === 'string'
  );
}

function isDiagnosticUpdate(
  update: Record<string, unknown>,
  text: string | null,
): boolean {
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  if (
    meta?.['qwenDiscreteMessage'] === true ||
    NON_MODEL_OUTPUT_SOURCES.has(String(meta?.['source']))
  ) {
    return true;
  }
  return (
    text !== null &&
    text.startsWith(COMPRESSION_DIAGNOSTIC_PREFIX) &&
    text.includes(COMPRESSION_DIAGNOSTIC_MARKER)
  );
}

function classifyTerminal(
  event: BenchmarkDaemonEvent,
  promptId: string,
): ClassifiedPromptEvent {
  if (!isRecord(event.data)) {
    return { type: 'ignore', reason: 'unrelated_event' };
  }
  if (event.promptId !== promptId || event.data['promptId'] !== promptId) {
    return { type: 'ignore', reason: 'wrong_prompt_id' };
  }
  if (event.type === 'turn_complete') {
    return {
      type: 'terminal',
      kind: 'complete',
      stopReason: stringOrNull(event.data['stopReason']),
      code: null,
      message: null,
    };
  }
  return {
    type: 'terminal',
    kind: 'error',
    stopReason: null,
    code: stringOrNull(event.data['code']),
    message: stringOrNull(event.data['message']),
  };
}

export function classifyFirstOutputEvent(
  event: BenchmarkDaemonEvent,
  promptId: string,
): ClassifiedPromptEvent {
  if (event.type === 'turn_complete' || event.type === 'turn_error') {
    return classifyTerminal(event, promptId);
  }
  if (event.type !== 'session_update') {
    return { type: 'ignore', reason: 'unrelated_event' };
  }
  if (event.promptId !== promptId) {
    return { type: 'ignore', reason: 'wrong_prompt_id' };
  }
  if (!isRecord(event.data) || !isRecord(event.data['update'])) {
    return { type: 'ignore', reason: 'malformed_update' };
  }

  const update = event.data['update'];
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  if (isReplayMeta(event._meta) || isReplayMeta(meta)) {
    return { type: 'ignore', reason: 'replay' };
  }

  const updateType = update['sessionUpdate'];
  if (
    updateType === 'agent_message_chunk' ||
    updateType === 'agent_thought_chunk'
  ) {
    const content = isRecord(update['content']) ? update['content'] : undefined;
    const text =
      content?.['type'] === 'text' ? stringOrNull(content['text']) : null;
    if (isDiagnosticUpdate(update, text)) {
      return { type: 'ignore', reason: 'diagnostic' };
    }
    if (text === null || text.length === 0) {
      return { type: 'ignore', reason: 'empty_content' };
    }
    return {
      type: 'output',
      kind:
        updateType === 'agent_message_chunk' ? 'answer_text' : 'thought_text',
      text,
      toolCallId: null,
      serverTimestampMs: eventServerTimestampMs(event),
    };
  }

  if (updateType === 'tool_call') {
    if (isDiagnosticUpdate(update, null)) {
      return { type: 'ignore', reason: 'diagnostic' };
    }
    const toolCallId = stringOrNull(update['toolCallId']);
    const title = stringOrNull(update['title']);
    if (!toolCallId || title === null) {
      return { type: 'ignore', reason: 'malformed_update' };
    }
    return {
      type: 'output',
      kind: 'tool_call',
      text: null,
      toolCallId,
      serverTimestampMs: eventServerTimestampMs(event),
    };
  }

  return { type: 'ignore', reason: 'non_output_update' };
}

function isMatchingUserEcho(
  event: BenchmarkDaemonEvent,
  promptId: string,
): boolean {
  if (
    event.type !== 'session_update' ||
    event.promptId !== promptId ||
    isReplayMeta(event._meta) ||
    !isRecord(event.data) ||
    !isRecord(event.data['update'])
  ) {
    return false;
  }
  const update = event.data['update'];
  const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
  return (
    update['sessionUpdate'] === 'user_message_chunk' && !isReplayMeta(meta)
  );
}

export class FirstOutputTracker {
  readonly #maxBufferedEvents: number;
  readonly #buffer: TimedDaemonEvent[] = [];
  #promptId: string | null = null;
  #bufferedBeforeAcceptanceCount = 0;
  #matchingEventCount = 0;
  #matchingTerminalCount = 0;
  #userEcho: FirstOutputUserEchoObservation | null = null;
  #firstOutput: FirstOutputObservation | null = null;
  #firstAnswer: FirstOutputObservation | null = null;
  #answerChunks: string[] = [];
  #terminal: FirstOutputTerminal | null = null;
  #failureCode: TrackerFailureCode | null = null;
  #failureMessage: string | null = null;

  constructor(options: FirstOutputTrackerOptions = {}) {
    const maxBufferedEvents =
      options.maxBufferedEvents ?? DEFAULT_FIRST_OUTPUT_EVENT_BUFFER_LIMIT;
    if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
      throw new TypeError('maxBufferedEvents must be a positive integer');
    }
    this.#maxBufferedEvents = maxBufferedEvents;
  }

  push(event: BenchmarkDaemonEvent, receivedAtMs: number): void {
    if (!Number.isFinite(receivedAtMs)) {
      throw new TypeError('receivedAtMs must be finite');
    }
    if (this.#promptId === null) {
      if (this.#buffer.length >= this.#maxBufferedEvents) {
        this.#setFailure(
          'event_buffer_overflow',
          `More than ${this.#maxBufferedEvents} events arrived before prompt acceptance`,
        );
        return;
      }
      this.#buffer.push({ event, receivedAtMs });
      return;
    }
    this.#process(event, receivedAtMs);
  }

  acceptPrompt(promptId: string): void {
    if (promptId.length === 0) {
      throw new TypeError('promptId must not be empty');
    }
    if (this.#promptId !== null) {
      if (this.#promptId !== promptId) {
        throw new Error(
          `Tracker already accepted prompt ${this.#promptId}, not ${promptId}`,
        );
      }
      return;
    }
    this.#promptId = promptId;
    this.#bufferedBeforeAcceptanceCount = this.#buffer.length;
    const buffered = this.#buffer.splice(0);
    for (const { event, receivedAtMs } of buffered) {
      this.#process(event, receivedAtMs);
    }
  }

  snapshot(): FirstOutputTrackerSnapshot {
    const runEligible =
      this.#failureCode === null && this.#terminal?.kind === 'complete';
    return {
      promptId: this.#promptId,
      bufferedEventCount: this.#buffer.length,
      bufferedBeforeAcceptanceCount: this.#bufferedBeforeAcceptanceCount,
      matchingEventCount: this.#matchingEventCount,
      matchingTerminalCount: this.#matchingTerminalCount,
      userEcho: this.#userEcho ? { ...this.#userEcho } : null,
      firstOutput: this.#firstOutput ? { ...this.#firstOutput } : null,
      firstAnswer: this.#firstAnswer ? { ...this.#firstAnswer } : null,
      finalAnswerText:
        this.#answerChunks.length > 0 ? this.#answerChunks.join('') : null,
      terminal: this.#terminal ? { ...this.#terminal } : null,
      failureCode: this.#failureCode,
      failureMessage: this.#failureMessage,
      runEligible,
      answerMetricEligible: runEligible && this.#firstAnswer !== null,
    };
  }

  #process(event: BenchmarkDaemonEvent, receivedAtMs: number): void {
    if (this.#terminal !== null) return;
    if (isMatchingUserEcho(event, this.#promptId!)) {
      this.#userEcho ??= {
        receivedAtMs,
        eventId: numberOrNull(event.id),
      };
      return;
    }
    const classified = classifyFirstOutputEvent(event, this.#promptId!);
    if (classified.type === 'ignore') return;
    this.#matchingEventCount += 1;

    if (classified.type === 'output') {
      const observation: FirstOutputObservation = {
        kind: classified.kind,
        receivedAtMs,
        eventId: numberOrNull(event.id),
        text: classified.text,
        toolCallId: classified.toolCallId,
        serverTimestampMs: classified.serverTimestampMs,
      };
      this.#firstOutput ??= observation;
      if (classified.kind === 'answer_text') {
        this.#firstAnswer ??= observation;
        this.#answerChunks.push(classified.text!);
      }
      return;
    }

    this.#matchingTerminalCount += 1;
    this.#terminal = {
      kind: classified.kind,
      receivedAtMs,
      eventId: numberOrNull(event.id),
      stopReason: classified.stopReason,
      code: classified.code,
      message: classified.message,
    };
    if (classified.kind === 'error') {
      this.#setFailure(
        'turn_error',
        classified.message ?? classified.code ?? 'Prompt ended with turn_error',
      );
    } else if (this.#firstOutput === null) {
      this.#setFailure(
        'terminal_before_first_output',
        'Prompt completed before producing a qualifying output event',
      );
    }
  }

  #setFailure(code: TrackerFailureCode, message: string): void {
    if (this.#failureCode !== null) return;
    this.#failureCode = code;
    this.#failureMessage = message;
  }
}

export interface PercentileSummary {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

export interface NullablePercentileSummary {
  totalCount: number;
  eligibleCount: number;
  missingCount: number;
  distribution: PercentileSummary | null;
}

function assertFiniteValues(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Percentile inputs must all be finite');
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentile * sorted.length) - 1),
  );
  return sorted[index];
}

export function percentiles(
  values: readonly number[],
): PercentileSummary | null {
  if (values.length === 0) return null;
  assertFiniteValues(values);
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p99: nearestRank(sorted, 0.99),
    mean: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function nullablePercentiles(
  values: readonly (number | null)[],
): NullablePercentileSummary {
  const eligible = values.filter((value): value is number => value !== null);
  return {
    totalCount: values.length,
    eligibleCount: eligible.length,
    missingCount: values.length - eligible.length,
    distribution: percentiles(eligible),
  };
}

export interface PairedMetricSample {
  order: PairOrder;
  valid: boolean;
  controlMs: number | null;
  candidateMs: number | null;
}

export interface BootstrapMedianConfidenceInterval {
  lowMs: number;
  highMs: number;
  iterations: number;
  seed: number;
}

export interface OrderSensitivitySummary {
  abEligiblePairs: number;
  baEligiblePairs: number;
  abMedianDeltaMs: number | null;
  baMedianDeltaMs: number | null;
  thresholdMs: number;
  orderSensitive: boolean;
}

export interface PairedCandidateControlStats {
  totalPairs: number;
  validPairs: number;
  invalidPairs: number;
  eligiblePairs: number;
  missingMetricPairs: number;
  control: PercentileSummary | null;
  candidate: PercentileSummary | null;
  deltaCandidateMinusControl: PercentileSummary | null;
  medianDeltaMs: number | null;
  meanDeltaMs: number | null;
  candidateWins: number;
  controlWins: number;
  ties: number;
  bootstrapMedianCi95: BootstrapMedianConfidenceInterval | null;
  orderSensitivity: OrderSensitivitySummary;
  decision: BenchmarkDecision;
  decisionReason: string;
}

export interface PairedStatsOptions {
  seed: number;
  bootstrapIterations?: number;
  materialThresholdMs?: number;
  orderSensitivityThresholdMs?: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapMedianCi95(
  values: readonly number[],
  iterations: number,
  seed: number,
): BootstrapMedianConfidenceInterval | null {
  if (values.length === 0) return null;
  const random = createSeededRandom(seed);
  const medians: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      sample.push(values[Math.floor(random() * values.length)]);
    }
    medians.push(median(sample)!);
  }
  medians.sort((left, right) => left - right);
  return {
    lowMs: nearestRank(medians, 0.025),
    highMs: nearestRank(medians, 0.975),
    iterations,
    seed: seed >>> 0,
  };
}

export function pairedCandidateControlStats(
  samples: readonly PairedMetricSample[],
  options: PairedStatsOptions,
): PairedCandidateControlStats {
  const iterations =
    options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const materialThresholdMs =
    options.materialThresholdMs ?? DEFAULT_MATERIAL_THRESHOLD_MS;
  const orderThresholdMs =
    options.orderSensitivityThresholdMs ??
    DEFAULT_ORDER_SENSITIVITY_THRESHOLD_MS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new TypeError('bootstrapIterations must be a positive integer');
  }
  if (!Number.isFinite(options.seed)) {
    throw new TypeError('seed must be finite');
  }
  if (
    !Number.isFinite(materialThresholdMs) ||
    materialThresholdMs < 0 ||
    !Number.isFinite(orderThresholdMs) ||
    orderThresholdMs < 0
  ) {
    throw new TypeError('thresholds must be finite and non-negative');
  }

  const valid = samples.filter((sample) => sample.valid);
  const eligible = valid.filter(
    (
      sample,
    ): sample is PairedMetricSample & {
      controlMs: number;
      candidateMs: number;
    } => sample.controlMs !== null && sample.candidateMs !== null,
  );
  for (const sample of eligible) {
    assertFiniteValues([sample.controlMs, sample.candidateMs]);
  }

  const control = eligible.map((sample) => sample.controlMs);
  const candidate = eligible.map((sample) => sample.candidateMs);
  const deltas = eligible.map(
    (sample) => sample.candidateMs - sample.controlMs,
  );
  const abDeltas = eligible
    .filter((sample) => sample.order === 'AB')
    .map((sample) => sample.candidateMs - sample.controlMs);
  const baDeltas = eligible
    .filter((sample) => sample.order === 'BA')
    .map((sample) => sample.candidateMs - sample.controlMs);
  const abMedian = median(abDeltas);
  const baMedian = median(baDeltas);
  const orderSensitive =
    abMedian !== null &&
    baMedian !== null &&
    abMedian * baMedian < 0 &&
    Math.max(Math.abs(abMedian), Math.abs(baMedian)) >= orderThresholdMs;
  const medianDeltaMs = median(deltas);
  const ci = bootstrapMedianCi95(deltas, iterations, options.seed);

  let decision: BenchmarkDecision = 'inconclusive';
  let decisionReason = 'The confidence interval crosses zero or is immaterial';
  if (valid.length !== samples.length) {
    decision = 'invalid';
    decisionReason = 'At least one pair is invalid';
  } else if (eligible.length === 0) {
    decision = 'invalid';
    decisionReason = 'No valid pair has both candidate and control values';
  } else if (orderSensitive) {
    decisionReason = 'AB and BA medians indicate material order sensitivity';
  } else if (
    ci !== null &&
    medianDeltaMs !== null &&
    ci.highMs < 0 &&
    medianDeltaMs <= -materialThresholdMs
  ) {
    decision = 'improved';
    decisionReason =
      'The candidate is materially faster and the 95% median CI is below zero';
  } else if (
    ci !== null &&
    medianDeltaMs !== null &&
    ci.lowMs > 0 &&
    medianDeltaMs >= materialThresholdMs
  ) {
    decision = 'regressed';
    decisionReason =
      'The candidate is materially slower and the 95% median CI is above zero';
  }

  return {
    totalPairs: samples.length,
    validPairs: valid.length,
    invalidPairs: samples.length - valid.length,
    eligiblePairs: eligible.length,
    missingMetricPairs: valid.length - eligible.length,
    control: percentiles(control),
    candidate: percentiles(candidate),
    deltaCandidateMinusControl: percentiles(deltas),
    medianDeltaMs,
    meanDeltaMs:
      deltas.length === 0
        ? null
        : deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    candidateWins: deltas.filter((delta) => delta < 0).length,
    controlWins: deltas.filter((delta) => delta > 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    bootstrapMedianCi95: ci,
    orderSensitivity: {
      abEligiblePairs: abDeltas.length,
      baEligiblePairs: baDeltas.length,
      abMedianDeltaMs: abMedian,
      baMedianDeltaMs: baMedian,
      thresholdMs: orderThresholdMs,
      orderSensitive,
    },
    decision,
    decisionReason,
  };
}

export const FIRST_OUTPUT_FAILURE_CODES = [
  'invalid_configuration',
  'daemon_boot_timeout',
  'daemon_exited_before_listen',
  'session_create_failed',
  'sse_connect_timeout',
  'sse_stream_ended',
  'prompt_accept_timeout',
  'prompt_rejected',
  'legacy_prompt_response',
  'event_buffer_overflow',
  'provider_request_count_mismatch',
  'unexpected_output_kind',
  'first_output_timeout',
  'terminal_before_first_output',
  'turn_error',
  'terminal_timeout',
  'wrong_final_text',
  'cleanup_timeout',
  'residual_process',
  'harness_error',
] as const;

export type FirstOutputFailureCode =
  (typeof FIRST_OUTPUT_FAILURE_CODES)[number];

export interface FirstOutputFailure {
  code: FirstOutputFailureCode;
  message: string;
}

export type PromptAcceptanceValidation =
  | {
      kind: 'accepted';
      promptId: string;
      lastEventId: number;
    }
  | {
      kind: 'failure';
      failure: FirstOutputFailure;
    };

export function validatePromptAcceptance(
  value: unknown,
): PromptAcceptanceValidation {
  if (!isRecord(value)) {
    return {
      kind: 'failure',
      failure: {
        code: 'prompt_rejected',
        message: 'Prompt acceptance returned a non-object response.',
      },
    };
  }

  const hasAcceptanceField =
    'promptId' in value || 'lastEventId' in value || 'eventEpoch' in value;
  if (!hasAcceptanceField && typeof value['stopReason'] === 'string') {
    return {
      kind: 'failure',
      failure: {
        code: 'legacy_prompt_response',
        message:
          'Benchmark requires the daemon non-blocking prompt protocol (202 with promptId).',
      },
    };
  }

  const promptId = value['promptId'];
  const lastEventId = value['lastEventId'];
  if (
    typeof promptId !== 'string' ||
    promptId.length === 0 ||
    !Number.isInteger(lastEventId) ||
    (lastEventId as number) < 0
  ) {
    return {
      kind: 'failure',
      failure: {
        code: 'prompt_rejected',
        message:
          'Prompt acceptance must contain a non-empty promptId and a non-negative integer lastEventId.',
      },
    };
  }

  return { kind: 'accepted', promptId, lastEventId: lastEventId as number };
}

export function validateExpectedFinalText(
  actual: string | null,
  expected: string,
): FirstOutputFailure | null {
  return actual === expected
    ? null
    : {
        code: 'wrong_final_text',
        message: `Unexpected final answer: ${JSON.stringify(actual)}.`,
      };
}

export interface SingleBundlePrototypeGateInput {
  complete: boolean;
  /** Per-process cold-minus-warm deltas. Cold and warm share a process, so
   * they are paired; the gate is decided on their median, not on a difference
   * of two independent P50s. */
  coldWarmPairedDeltasMs: readonly number[];
  seed: number;
  coldPromptToProviderRequestP50Ms: number | null;
  warmPromptToProviderRequestP50Ms: number | null;
  coldPromptToFirstModelOutputP50Ms: number | null;
  bootstrapIterations?: number;
  absoluteThresholdMs?: number;
  relativeThresholdRatio?: number;
}

export interface SingleBundlePrototypeGateResult {
  passed: boolean;
  providerDeltaMs: number | null;
  pairedMedianDeltaMs: number | null;
  bootstrapMedianCi95: BootstrapMedianConfidenceInterval | null;
  absoluteThresholdMs: number;
  relativeThresholdRatio: number;
}

export function evaluateSingleBundlePrototypeGate(
  input: SingleBundlePrototypeGateInput,
): SingleBundlePrototypeGateResult {
  const absoluteThresholdMs = input.absoluteThresholdMs ?? 25;
  const relativeThresholdRatio = input.relativeThresholdRatio ?? 0.1;
  const iterations = input.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  if (
    !Number.isFinite(absoluteThresholdMs) ||
    absoluteThresholdMs < 0 ||
    !Number.isFinite(relativeThresholdRatio) ||
    relativeThresholdRatio < 0
  ) {
    throw new TypeError('gate thresholds must be finite and non-negative');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new TypeError('bootstrapIterations must be a positive integer');
  }
  if (!Number.isFinite(input.seed)) {
    throw new TypeError('seed must be finite');
  }
  if (input.coldWarmPairedDeltasMs.some((value) => !Number.isFinite(value))) {
    throw new TypeError('coldWarmPairedDeltasMs must all be finite');
  }
  const providerDeltaMs =
    input.coldPromptToProviderRequestP50Ms === null ||
    input.warmPromptToProviderRequestP50Ms === null
      ? null
      : input.coldPromptToProviderRequestP50Ms -
        input.warmPromptToProviderRequestP50Ms;
  const pairedMedianDeltaMs = median(input.coldWarmPairedDeltasMs);
  const ci = bootstrapMedianCi95(
    input.coldWarmPairedDeltasMs,
    iterations,
    input.seed,
  );
  // The lower CI bound, not the point estimate, must clear the threshold: a
  // delta that only just exceeds it is not distinguishable from noise.
  const passed =
    input.complete &&
    ci !== null &&
    input.coldPromptToFirstModelOutputP50Ms !== null &&
    (ci.lowMs >= absoluteThresholdMs ||
      ci.lowMs >=
        relativeThresholdRatio * input.coldPromptToFirstModelOutputP50Ms);
  return {
    passed,
    providerDeltaMs,
    pairedMedianDeltaMs,
    bootstrapMedianCi95: ci,
    absoluteThresholdMs,
    relativeThresholdRatio,
  };
}

export interface FirstOutputSessionTimestamps {
  sessionCreateStart: number;
  sessionReady: number | null;
  sseReady: number | null;
  promptStart: number | null;
  promptAccepted: number | null;
  userEcho: number | null;
  providerRequestArrival: number | null;
  providerReady: number | null;
  firstModelOutput: number | null;
  firstAnswerText: number | null;
  terminal: number | null;
}

export interface FirstOutputSessionTimings {
  processToSessionReadyMs: number | null;
  /** Idle window actually granted by the configured post-session dwell. */
  sseReadyToPromptMs: number | null;
  promptToAcceptanceMs: number | null;
  /**
   * Signed offset from HTTP acceptance to Provider request arrival. A negative
   * value is valid when dispatch reaches the Provider before the client reads
   * the `202` response.
   */
  acceptanceToProviderRequestArrivalMs: number | null;
  promptToUserEchoMs: number | null;
  /**
   * Signed offset from the relayed user echo to Provider request arrival. SSE
   * delivery can lag the already-dispatched Provider request.
   */
  userEchoToProviderRequestArrivalMs: number | null;
  /** Existing daemon FIFO queue-wait duration for this isolated prompt. */
  daemonPromptQueueWaitMs: number | null;
  promptToProviderRequestArrivalMs: number | null;
  promptToFirstModelOutputMs: number | null;
  promptToFirstAnswerTextMs: number | null;
  providerReadyToFirstModelOutputMs: number | null;
  processToFirstModelOutputMs: number | null;
  promptToTerminalMs: number | null;
}

export function computeFirstOutputSessionTimings(
  timestamps: FirstOutputSessionTimestamps,
  processStartedAtMs: number,
  daemonPromptQueueWaitMs: number | null,
): FirstOutputSessionTimings {
  const duration = (end: number | null, start: number | null) =>
    end === null || start === null ? null : end - start;
  return {
    processToSessionReadyMs: duration(
      timestamps.sessionReady,
      processStartedAtMs,
    ),
    sseReadyToPromptMs: duration(timestamps.promptStart, timestamps.sseReady),
    promptToAcceptanceMs: duration(
      timestamps.promptAccepted,
      timestamps.promptStart,
    ),
    acceptanceToProviderRequestArrivalMs: duration(
      timestamps.providerRequestArrival,
      timestamps.promptAccepted,
    ),
    promptToUserEchoMs: duration(timestamps.userEcho, timestamps.promptStart),
    userEchoToProviderRequestArrivalMs: duration(
      timestamps.providerRequestArrival,
      timestamps.userEcho,
    ),
    daemonPromptQueueWaitMs,
    promptToProviderRequestArrivalMs: duration(
      timestamps.providerRequestArrival,
      timestamps.promptStart,
    ),
    promptToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      timestamps.promptStart,
    ),
    promptToFirstAnswerTextMs: duration(
      timestamps.firstAnswerText,
      timestamps.promptStart,
    ),
    providerReadyToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      timestamps.providerReady,
    ),
    processToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      processStartedAtMs,
    ),
    promptToTerminalMs: duration(timestamps.terminal, timestamps.promptStart),
  };
}

export function findInvalidTimings(
  timings: FirstOutputSessionTimings,
): Array<[keyof FirstOutputSessionTimings, number]> {
  const invalid: Array<[keyof FirstOutputSessionTimings, number]> = [];
  for (const key of Object.keys(timings) as Array<
    keyof FirstOutputSessionTimings
  >) {
    const value = timings[key];
    const negativeInvalid =
      value !== null &&
      value < 0 &&
      key !== 'acceptanceToProviderRequestArrivalMs' &&
      key !== 'userEchoToProviderRequestArrivalMs';
    if (value !== null && (!Number.isFinite(value) || negativeInvalid)) {
      invalid.push([key, value]);
    }
  }
  return invalid;
}

export interface FirstOutputSessionRunResult {
  ordinal: number;
  sessionId: string | null;
  promptId: string | null;
  timestamps: FirstOutputSessionTimestamps;
  timings: FirstOutputSessionTimings;
  firstOutput: FirstOutputObservation | null;
  firstAnswer: FirstOutputObservation | null;
  finalAnswerText: string | null;
  terminal: FirstOutputTerminal | null;
  providerRequestCount: number;
  runEligible: boolean;
  answerMetricEligible: boolean;
  failure: FirstOutputFailure | null;
  cleanupFailure: FirstOutputFailure | null;
  diagnostics?: Record<string, unknown>;
}

export interface FirstOutputCleanupResult {
  completed: boolean;
  daemonExited: boolean;
  residualProcessCount: number;
  failure: FirstOutputFailure | null;
}

export interface FirstOutputProcessRunResult {
  variant: BenchmarkVariant;
  sampleIndex: number;
  pairIndex: number | null;
  orderPosition: 1 | 2 | null;
  measured: boolean;
  pid: number | null;
  timestamps: {
    processStart: number | null;
    daemonReady: number | null;
  };
  processToListenMs: number | null;
  sessions: FirstOutputSessionRunResult[];
  failure: FirstOutputFailure | null;
  cleanup: FirstOutputCleanupResult;
  stdout: string;
  stderr: string;
  diagnostics?: Record<string, unknown>;
}

export interface FirstOutputPairResult {
  pairIndex: number;
  order: PairOrder;
  control: FirstOutputProcessRunResult;
  candidate: FirstOutputProcessRunResult;
  valid: boolean;
  invalidReason: string | null;
}

export interface FirstOutputVariantDescriptor {
  cliPath: string;
  realpath: string;
  sha256: string;
  compileCache: {
    policy: 'fixed-private-per-variant-warmed';
    directory: string;
  };
}

export type FirstOutputMetricName =
  | 'processToListenMs'
  | 'processToSessionReadyMs'
  | 'sseReadyToPromptMs'
  | 'promptToAcceptanceMs'
  | 'acceptanceToProviderRequestArrivalMs'
  | 'promptToUserEchoMs'
  | 'userEchoToProviderRequestArrivalMs'
  | 'daemonPromptQueueWaitMs'
  | 'promptToProviderRequestArrivalMs'
  | 'promptToFirstModelOutputMs'
  | 'promptToFirstAnswerTextMs'
  | 'providerReadyToFirstModelOutputMs'
  | 'processToFirstModelOutputMs'
  | 'promptToTerminalMs';

export interface FirstOutputSingleMetricSummary {
  all: NullablePercentileSummary | null;
  bySession: Record<string, NullablePercentileSummary>;
}

export interface FirstOutputPairedMetricSummary {
  all: PairedCandidateControlStats | null;
  bySession: Record<string, PairedCandidateControlStats>;
}

interface FirstOutputBenchmarkArtifactBaseV2 {
  version: typeof FIRST_OUTPUT_BENCHMARK_VERSION;
  benchmark: 'daemon-first-output';
  capturedAt: string;
  harnessGitCommit: string | null;
  platform: {
    os: string;
    arch: string;
    nodeVersion: string;
    cpuModel: string;
    logicalCpuCount: number;
    availableCpuCount: number;
    totalMemoryBytes: number;
    loadAverage: [number, number, number];
  };
}

interface FirstOutputBenchmarkCommonConfig {
  seed: number;
  providerDelayMs: number;
  providerConnection: 'close-per-response';
  postSessionDwellMs: number;
  promptShape: string;
  expectedAnswer: string;
  maxBufferedEvents: number;
  providerRequestsPerSession: number;
  timeoutsMs: Record<string, number>;
}

export interface FirstOutputSingleBenchmarkArtifactV2
  extends FirstOutputBenchmarkArtifactBaseV2 {
  mode: 'single';
  config: FirstOutputBenchmarkCommonConfig & {
    warmupRuns: number;
    measuredRuns: number;
    variant: FirstOutputVariantDescriptor;
  };
  warmupRuns: FirstOutputProcessRunResult[];
  runs: FirstOutputProcessRunResult[];
  summary: {
    expectedRuns: number;
    successfulRuns: number;
    failedRuns: number;
    failuresByCode: Partial<Record<FirstOutputFailureCode, number>>;
    metrics: Partial<
      Record<FirstOutputMetricName, FirstOutputSingleMetricSummary>
    >;
    decision: {
      outcome: 'prototype_allowed' | 'stop' | 'invalid';
      reasons: string[];
      gate: {
        coldPromptToProviderRequestP50Ms: number | null;
        warmPromptToProviderRequestP50Ms: number | null;
        providerDeltaMs: number | null;
        pairedMedianDeltaMs: number | null;
        bootstrapMedianCi95: BootstrapMedianConfidenceInterval | null;
        coldPromptToFirstModelOutputP50Ms: number | null;
        absoluteThresholdMs: number;
        relativeThresholdRatio: number;
        passed: boolean;
      };
    };
  };
}

export interface FirstOutputPairedBenchmarkArtifactV2
  extends FirstOutputBenchmarkArtifactBaseV2 {
  mode: 'paired';
  config: FirstOutputBenchmarkCommonConfig & {
    warmupPairs: number;
    measuredPairs: number;
    bootstrapIterations: number;
    materialThresholdMs: number;
    orderSensitivityThresholdMs: number;
    variants: Record<
      Exclude<BenchmarkVariant, 'single'>,
      FirstOutputVariantDescriptor
    >;
  };
  warmups: FirstOutputPairResult[];
  pairs: FirstOutputPairResult[];
  summary: {
    expectedPairs: number;
    validPairs: number;
    invalidPairs: number;
    failuresByCode: Partial<Record<FirstOutputFailureCode, number>>;
    metrics: Partial<
      Record<FirstOutputMetricName, FirstOutputPairedMetricSummary>
    >;
    decision: {
      outcome: BenchmarkDecision;
      scope: 'primary_metric_only';
      publicationGateEvaluated: false;
      primaryMetric: FirstOutputMetricName;
      primarySession: 1;
      reasons: string[];
    };
  };
}

export interface FirstOutputFailedBenchmarkArtifactV2
  extends FirstOutputBenchmarkArtifactBaseV2 {
  mode: 'failed';
  config: {
    requestedMode: 'single' | 'paired' | 'unknown';
  };
  failure: FirstOutputFailure;
  summary: {
    failuresByCode: Partial<Record<FirstOutputFailureCode, number>>;
    decision: {
      outcome: 'invalid';
      reasons: string[];
    };
  };
}

export type FirstOutputBenchmarkArtifactV2 =
  | FirstOutputSingleBenchmarkArtifactV2
  | FirstOutputPairedBenchmarkArtifactV2
  | FirstOutputFailedBenchmarkArtifactV2;

function formatMilliseconds(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1);
}

function formatConfidenceInterval(
  interval: BootstrapMedianConfidenceInterval | null,
): string {
  return interval === null
    ? 'n/a'
    : `[${interval.lowMs.toFixed(1)}, ${interval.highMs.toFixed(1)}]`;
}

function formatDistribution(distribution: PercentileSummary | null): string {
  return distribution === null
    ? 'n/a'
    : [distribution.p50, distribution.p90, distribution.p99, distribution.mean]
        .map((value) => value.toFixed(1))
        .join('/');
}

export function renderFirstOutputBenchmarkMarkdown(
  artifact: FirstOutputBenchmarkArtifactV2,
): string {
  const decisionLabel =
    artifact.mode === 'paired' ? 'Primary metric decision' : 'Decision';
  const lines = [
    '# Daemon first-output benchmark',
    '',
    `Captured: ${artifact.capturedAt}`,
    '',
    `${decisionLabel}: **${artifact.summary.decision.outcome}**`,
    '',
    ...artifact.summary.decision.reasons.map((reason) => `- ${reason}`),
    '',
  ];

  if (artifact.mode === 'failed') {
    lines.push(
      `Failure: ${artifact.failure.code}`,
      '',
      artifact.failure.message,
    );
  } else if (artifact.mode === 'single') {
    lines.push(
      `Runs: ${artifact.summary.successfulRuns}/${artifact.summary.expectedRuns} successful`,
      '',
      '| Metric | Scope | p50 (ms) | p90 (ms) | p99 (ms) | Mean (ms) | Eligible samples |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const [metric, summary] of Object.entries(artifact.summary.metrics)) {
      if (!summary) continue;
      const scopes = [
        ...(summary.all ? [['all', summary.all] as const] : []),
        ...Object.entries(summary.bySession),
      ];
      for (const [scope, stats] of scopes) {
        lines.push(
          `| ${metric} | ${scope} | ${formatMilliseconds(stats.distribution?.p50 ?? null)} | ${formatMilliseconds(stats.distribution?.p90 ?? null)} | ${formatMilliseconds(stats.distribution?.p99 ?? null)} | ${formatMilliseconds(stats.distribution?.mean ?? null)} | ${stats.eligibleCount} |`,
        );
      }
    }
  } else {
    lines.push(
      `Pairs: ${artifact.summary.validPairs}/${artifact.summary.expectedPairs} valid`,
      '',
      '| Metric | Scope | Control p50/p90/p99/mean (ms) | Candidate p50/p90/p99/mean (ms) | Δ p50/p90/p99/mean (ms) | Median Δ (ms) | 95% bootstrap CI (ms) | Wins candidate/control/ties | AB/BA median Δ (ms) | Eligible pairs | Decision |',
      '| --- | --- | --- | --- | --- | ---: | --- | --- | --- | ---: | --- |',
    );
    for (const [metric, summary] of Object.entries(artifact.summary.metrics)) {
      if (!summary) continue;
      const scopes = [
        ...(summary.all ? [['all', summary.all] as const] : []),
        ...Object.entries(summary.bySession),
      ];
      for (const [scope, stats] of scopes) {
        lines.push(
          `| ${metric} | ${scope} | ${formatDistribution(stats.control)} | ${formatDistribution(stats.candidate)} | ${formatDistribution(stats.deltaCandidateMinusControl)} | ${formatMilliseconds(stats.medianDeltaMs)} | ${formatConfidenceInterval(stats.bootstrapMedianCi95)} | ${stats.candidateWins}/${stats.controlWins}/${stats.ties} | ${formatMilliseconds(stats.orderSensitivity.abMedianDeltaMs)}/${formatMilliseconds(stats.orderSensitivity.baMedianDeltaMs)} | ${stats.eligiblePairs} | ${stats.decision} |`,
        );
      }
    }
  }

  const failures = Object.entries(artifact.summary.failuresByCode);
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const [code, count] of failures) {
      lines.push(`- ${code}: ${count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
