/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  createContextKey,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';

type RequestObserver = (attributes: Attributes) => void;
type RequestRecord = Record<string, unknown>;

const requestObserverKey = createContextKey(
  'qwen-code.gen-ai-request-observer',
);

function ownValue(record: RequestRecord, key: string): unknown | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function stopSequences(
  value: unknown,
  allowSingleString: boolean,
): string[] | undefined {
  if (allowSingleString && typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    return undefined;
  return [...value];
}

function outputBudget(record: RequestRecord): number | undefined {
  const values = ['max_tokens', 'max_completion_tokens', 'max_new_tokens']
    .map((key) => ownValue(record, key))
    .filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return undefined;

  const integers = values.map(safeInteger);
  if (integers.some((value) => value === undefined)) return undefined;
  const first = integers[0]!;
  return integers.every((value) => value === first) ? first : undefined;
}

function assignNumber(
  attributes: Attributes,
  key: string,
  value: unknown,
): void {
  const number = finiteNumber(value);
  if (number !== undefined) attributes[key] = number;
}

function assignInteger(
  attributes: Attributes,
  key: string,
  value: unknown,
): void {
  const integer = safeInteger(value);
  if (integer !== undefined) attributes[key] = integer;
}

function assignStopSequences(
  attributes: Attributes,
  value: unknown,
  allowSingleString: boolean,
): void {
  const sequences = stopSequences(value, allowSingleString);
  if (sequences !== undefined)
    attributes['gen_ai.request.stop_sequences'] = sequences;
}

export function extractOpenAiRequestAttributes(request: object): Attributes {
  const record = request as RequestRecord;
  const attributes: Attributes = {};
  const choiceCount = safeInteger(ownValue(record, 'n'));
  if (choiceCount !== undefined && choiceCount !== 1) {
    attributes['gen_ai.request.choice.count'] = choiceCount;
  }
  const maxTokens = outputBudget(record);
  if (maxTokens !== undefined) {
    attributes['gen_ai.request.max_tokens'] = maxTokens;
  }
  assignNumber(
    attributes,
    'gen_ai.request.temperature',
    ownValue(record, 'temperature'),
  );
  assignNumber(attributes, 'gen_ai.request.top_p', ownValue(record, 'top_p'));
  assignNumber(
    attributes,
    'gen_ai.request.frequency_penalty',
    ownValue(record, 'frequency_penalty'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.presence_penalty',
    ownValue(record, 'presence_penalty'),
  );
  assignStopSequences(attributes, ownValue(record, 'stop'), true);
  return attributes;
}

export function extractAnthropicRequestAttributes(request: object): Attributes {
  const record = request as RequestRecord;
  const attributes: Attributes = {};
  assignInteger(
    attributes,
    'gen_ai.request.max_tokens',
    ownValue(record, 'max_tokens'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.temperature',
    ownValue(record, 'temperature'),
  );
  assignNumber(attributes, 'gen_ai.request.top_p', ownValue(record, 'top_p'));
  assignStopSequences(attributes, ownValue(record, 'stop_sequences'), false);
  return attributes;
}

export function extractGeminiRequestAttributes(request: object): Attributes {
  const record = request as RequestRecord;
  const config = ownValue(record, 'config');
  if (typeof config !== 'object' || config === null) return {};
  const configRecord = config as RequestRecord;
  const attributes: Attributes = {};
  const choiceCount = safeInteger(ownValue(configRecord, 'candidateCount'));
  if (choiceCount !== undefined && choiceCount !== 1) {
    attributes['gen_ai.request.choice.count'] = choiceCount;
  }
  assignInteger(
    attributes,
    'gen_ai.request.max_tokens',
    ownValue(configRecord, 'maxOutputTokens'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.temperature',
    ownValue(configRecord, 'temperature'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.top_p',
    ownValue(configRecord, 'topP'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.frequency_penalty',
    ownValue(configRecord, 'frequencyPenalty'),
  );
  assignNumber(
    attributes,
    'gen_ai.request.presence_penalty',
    ownValue(configRecord, 'presencePenalty'),
  );
  assignStopSequences(
    attributes,
    ownValue(configRecord, 'stopSequences'),
    false,
  );
  return attributes;
}

export function createGenAiRequestObserverContext(
  parent: Context,
  span: Span,
): Context {
  try {
    if (!span.isRecording()) return parent;
  } catch {
    return parent;
  }

  let consumed = false;
  const observer: RequestObserver = (attributes) => {
    if (consumed) return;
    consumed = true;
    try {
      span.setAttributes(attributes);
    } catch {
      // Telemetry must not affect the provider request.
    }
  };
  try {
    return parent.setValue(requestObserverKey, observer);
  } catch {
    return parent;
  }
}

function reportRequest(
  request: object,
  extract: (request: object) => Attributes,
  requestContext: Context,
): void {
  let observer: unknown;
  try {
    observer = requestContext.getValue(requestObserverKey);
  } catch {
    return;
  }
  if (typeof observer !== 'function') return;

  let attributes: Attributes = {};
  try {
    attributes = extract(request);
  } catch {
    // Consume the first request snapshot even if extraction fails.
  }
  try {
    (observer as RequestObserver)(attributes);
  } catch {
    // Telemetry must not affect the provider request.
  }
}

function reportActiveRequest(
  request: object,
  extract: (request: object) => Attributes,
  requestContext?: Context,
): void {
  try {
    reportRequest(request, extract, requestContext ?? context.active());
  } catch {
    // Telemetry must not affect the provider request.
  }
}

export function reportOpenAiRequest(
  request: object,
  requestContext?: Context,
): void {
  reportActiveRequest(request, extractOpenAiRequestAttributes, requestContext);
}

export function reportAnthropicRequest(
  request: object,
  requestContext?: Context,
): void {
  reportActiveRequest(
    request,
    extractAnthropicRequestAttributes,
    requestContext,
  );
}

export function reportGeminiRequest(
  request: object,
  requestContext?: Context,
): void {
  reportActiveRequest(request, extractGeminiRequestAttributes, requestContext);
}
