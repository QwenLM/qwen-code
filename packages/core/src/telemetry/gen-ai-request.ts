/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  createContextKey,
  ROOT_CONTEXT,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import {
  extractAnthropicContent,
  extractGeminiContent,
  extractOpenAiContent,
  GenAiOutputAccumulator,
  stringifyGenAiJson,
  type GenAiContentAttributes,
} from './gen-ai-content.js';
import { createDebugLogger } from '../utils/debugLogger.js';

type RequestRecord = Record<string, unknown>;
const debugLogger = createDebugLogger('GEN_AI_EXCHANGE');

const requestObserverKey = createContextKey(
  'qwen-code.gen-ai-request-observer',
);
const DISABLED_OBSERVER = Symbol('disabled-gen-ai-exchange');

export interface GenAiExchangeOptions {
  captureContent: boolean;
  sensitiveAttributeMaxLength: number;
}

export interface GenAiAttemptHandle {
  readonly controller: GenAiExchangeController;
  readonly generation: number;
}

export interface GenAiExchange {
  context: Context;
  controller: GenAiExchangeController;
}

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

export class GenAiExchangeController {
  private requestConsumed = false;
  private generation = 0;
  private finalized = false;
  private output: GenAiOutputAccumulator;
  private responseConversionFailed = false;

  constructor(
    private readonly span: Span,
    private readonly options: GenAiExchangeOptions,
    private readonly enabled: boolean,
  ) {
    this.output = this.newOutput();
  }

  beginRequest(
    request: object,
    extractRequest: (request: object) => Attributes,
    extractContent: (request: object) => GenAiContentAttributes,
  ): GenAiAttemptHandle | undefined {
    if (!this.enabled || this.finalized) return undefined;
    const generation = ++this.generation;
    this.output = this.newOutput();
    this.responseConversionFailed = false;

    if (!this.requestConsumed) {
      this.requestConsumed = true;
      const attributes: Attributes = {};
      try {
        Object.assign(attributes, extractRequest(request));
        if (this.options.captureContent) {
          const content = extractContent(request);
          this.assignJsonAttribute(
            attributes,
            'gen_ai.input.messages',
            content.inputMessages,
          );
          this.assignJsonAttribute(
            attributes,
            'gen_ai.system_instructions',
            content.systemInstructions,
          );
          this.assignJsonAttribute(
            attributes,
            'gen_ai.tool.definitions',
            content.toolDefinitions,
          );
        }
      } catch {
        debugLogger.debug('Failed to convert GenAI request attributes');
        // The first snapshot remains consumed when conversion fails.
      }
      try {
        this.span.setAttributes(attributes);
      } catch {
        debugLogger.debug('Failed to set GenAI request span attributes');
      }
    }

    return { controller: this, generation };
  }

  beginFollowingRequest(
    handle: GenAiAttemptHandle,
    request: object,
    extractRequest: (request: object) => Attributes,
    extractContent: (request: object) => GenAiContentAttributes,
  ): GenAiAttemptHandle | undefined {
    if (
      handle.controller !== this ||
      handle.generation !== this.generation ||
      this.finalized
    ) {
      return undefined;
    }
    return this.beginRequest(request, extractRequest, extractContent);
  }

  record(
    handle: GenAiAttemptHandle | undefined,
    update: (output: GenAiOutputAccumulator) => void,
  ): void {
    if (
      !handle ||
      handle.controller !== this ||
      handle.generation !== this.generation ||
      this.finalized
    ) {
      return;
    }
    try {
      update(this.output);
    } catch {
      this.output.discardContent();
      this.responseConversionFailed = true;
      debugLogger.debug('Failed to convert GenAI response content');
    }
  }

  finalize(success: boolean): string[] | undefined {
    if (this.finalized) return undefined;
    this.finalized = true;
    let finishReasons: string[] | undefined;
    try {
      const outputMessages = this.output.finalize(success);
      finishReasons = this.responseConversionFailed
        ? undefined
        : this.output.finishReasons;
      if (outputMessages !== undefined) {
        this.span.setAttribute('gen_ai.output.messages', outputMessages);
      }
    } catch {
      debugLogger.debug('Failed to finalize GenAI response attributes');
    } finally {
      this.output = this.newOutput();
    }
    return finishReasons;
  }

  private assignJsonAttribute(
    attributes: Attributes,
    key: string,
    value: unknown,
  ): void {
    if (value === undefined) return;
    let serialized: string | undefined;
    try {
      serialized = stringifyGenAiJson(
        value,
        this.options.sensitiveAttributeMaxLength,
      );
    } catch {
      debugLogger.debug(`Failed to serialize ${key} span attribute`);
      return;
    }
    if (serialized !== undefined) attributes[key] = serialized;
  }

  private newOutput(): GenAiOutputAccumulator {
    return new GenAiOutputAccumulator(
      this.options.captureContent,
      this.options.sensitiveAttributeMaxLength,
    );
  }
}

function disabledFallbackContext(parent: Context): Context {
  const fallback = Object.create(parent) as Context;
  fallback.getValue = (key) => {
    if (key === requestObserverKey) return DISABLED_OBSERVER;
    try {
      return parent.getValue(key);
    } catch {
      return undefined;
    }
  };
  fallback.setValue = (key, value) => {
    if (key === requestObserverKey) return fallback;
    try {
      return disabledFallbackContext(parent.setValue(key, value));
    } catch {
      return fallback;
    }
  };
  fallback.deleteValue = (key) => {
    if (key === requestObserverKey) return fallback;
    try {
      return disabledFallbackContext(parent.deleteValue(key));
    } catch {
      return fallback;
    }
  };
  return fallback;
}

export function createGenAiExchange(
  parent: Context,
  span: Span,
  options: GenAiExchangeOptions,
): GenAiExchange {
  let enabled = false;
  try {
    enabled = span.isRecording();
  } catch {
    enabled = false;
  }
  const controller = new GenAiExchangeController(span, options, enabled);
  try {
    return {
      context: parent.setValue(
        requestObserverKey,
        enabled ? controller : DISABLED_OBSERVER,
      ),
      controller,
    };
  } catch {
    return {
      context:
        parent === ROOT_CONTEXT
          ? ROOT_CONTEXT
          : disabledFallbackContext(parent),
      controller,
    };
  }
}

/**
 * @deprecated Use createGenAiExchange so response attempts can be finalized.
 */
export function createGenAiRequestObserverContext(
  parent: Context,
  span: Span,
): Context {
  return createGenAiExchange(parent, span, {
    captureContent: false,
    sensitiveAttributeMaxLength: 1,
  }).context;
}

function activeController(
  requestContext?: Context,
): GenAiExchangeController | undefined {
  let observer: unknown;
  try {
    observer = (requestContext ?? context.active()).getValue(
      requestObserverKey,
    );
  } catch {
    return undefined;
  }
  return observer instanceof GenAiExchangeController ? observer : undefined;
}

function reportRequest(
  request: object,
  extractRequest: (request: object) => Attributes,
  extractContent: (request: object) => GenAiContentAttributes,
  requestContext?: Context,
  previousAttempt?: GenAiAttemptHandle,
): GenAiAttemptHandle | undefined {
  try {
    if (previousAttempt) {
      return previousAttempt.controller.beginFollowingRequest(
        previousAttempt,
        request,
        extractRequest,
        extractContent,
      );
    }
    return activeController(requestContext)?.beginRequest(
      request,
      extractRequest,
      extractContent,
    );
  } catch {
    return undefined;
  }
}

export function reportOpenAiRequest(
  request: object,
  requestContext?: Context,
): GenAiAttemptHandle | undefined {
  return reportRequest(
    request,
    extractOpenAiRequestAttributes,
    extractOpenAiContent,
    requestContext,
  );
}

export function reportAnthropicRequest(
  request: object,
  requestContext?: Context,
): GenAiAttemptHandle | undefined {
  return reportRequest(
    request,
    extractAnthropicRequestAttributes,
    extractAnthropicContent,
    requestContext,
  );
}

export function reportAnthropicFollowingRequest(
  request: object,
  previousAttempt: GenAiAttemptHandle | undefined,
): GenAiAttemptHandle | undefined {
  if (!previousAttempt) return undefined;
  return reportRequest(
    request,
    extractAnthropicRequestAttributes,
    extractAnthropicContent,
    undefined,
    previousAttempt,
  );
}

export function reportGeminiRequest(
  request: object,
  requestContext?: Context,
): GenAiAttemptHandle | undefined {
  return reportRequest(
    request,
    extractGeminiRequestAttributes,
    extractGeminiContent,
    requestContext,
  );
}

export function reportOpenAiResponse(
  handle: GenAiAttemptHandle | undefined,
  response: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordOpenAiResponse(response),
  );
}

export function reportOpenAiChunk(
  handle: GenAiAttemptHandle | undefined,
  chunk: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordOpenAiChunk(chunk),
  );
}

export function reportAnthropicResponse(
  handle: GenAiAttemptHandle | undefined,
  response: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordAnthropicResponse(response),
  );
}

export function reportAnthropicEvent(
  handle: GenAiAttemptHandle | undefined,
  event: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordAnthropicEvent(event),
  );
}

export function reportGeminiResponse(
  handle: GenAiAttemptHandle | undefined,
  response: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordGeminiResponse(response),
  );
}

export function reportGeminiChunk(
  handle: GenAiAttemptHandle | undefined,
  chunk: object,
): void {
  handle?.controller.record(handle, (output) =>
    output.recordGeminiChunk(chunk),
  );
}
