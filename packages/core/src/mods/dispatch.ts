/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import {
  MOD_TIMEOUT_MS,
  MOD_MAX_BYTES,
  MOD_MAX_DEPTH,
  MOD_MODEL_EFFORTS,
} from './types.js';
import {
  validateToolInput,
  validToolResult,
  validToolCheck,
} from './tool-events.js';
import {
  INVALIDATABLE_EVENTS,
  MOD_RENDER_PINNED_PROPS,
  invalidRenderText,
  validateRenderTree,
  type ModRenderSite,
} from './render-tree.js';

export const MOD_METHODS = [
  'clock.now',
  'clock.sleep',
  'command.register',
  'model.complete',
  'prompt.submit',
  'session.cwd',
  'session.id',
  'session.model',
  'session.root',
  'session.surface',
  'session.surfaces',
  'session.turns',
  'session.usage',
  'session.version',
  'store.delete',
  'store.get',
  'store.keys',
  'store.set',
  'turn.abort',
  'ui.invalidate',
  'ui.log',
] as const;
export const MOD_EVENTS = [
  'clock.now',
  'clock.sleep',
  'command.register',
  'command.run',
  'model.complete',
  'prompt.submit',
  'session.cwd',
  'session.end',
  'session.id',
  'session.model',
  'session.root',
  'session.start',
  'session.surface',
  'session.surfaces',
  'session.turns',
  'session.usage',
  'session.version',
  'store.delete',
  'store.get',
  'store.keys',
  'store.set',
  'tool.call',
  'tool.check',
  'turn.abort',
  'turn.complete',
  'turn.start',
  'ui.invalidate',
  'ui.log',
  'ui.render',
] as const;
// Events only some hosts raise: the load request names the sites a host
// draws, whether it raises `prompt.submit`, and whether it keeps a store.
export const MOD_STORE_EVENTS: readonly ModEvent[] = [
  'store.delete',
  'store.get',
  'store.keys',
  'store.set',
];
export const MOD_HOST_EVENTS: readonly ModEvent[] = [
  'prompt.submit',
  'ui.render',
  ...MOD_STORE_EVENTS,
];
// `$` methods that read rather than dispatch, so no hook hears them.
export const MOD_READS = ['ui.resolve'] as const;
export type ModEvent = (typeof MOD_EVENTS)[number];
export type ModMethod = (typeof MOD_METHODS)[number];
export const isModMethod = (name: string): name is ModMethod =>
  (MOD_METHODS as readonly string[]).includes(name);
export type ModInput = Record<string, unknown>;
export interface ModFrame {
  plugin: number;
  registration: number;
}
export interface ModOrigin {
  plugin: string;
  tier: 'user' | 'core';
}
export const engineOrigin: ModOrigin = { plugin: 'engine', tier: 'core' };
export const record = (value: unknown): value is ModInput =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: ModInput, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown) => typeof value === 'string';
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const SURFACES: readonly unknown[] = [
  'terminal',
  'desktop',
  'mobile',
  'vscode',
];

// Counts nesting without walking a value, so one too deep for V8 or QuickJS
// to traverse is refused before anything traverses it.
export function jsonDepth(json: string): number {
  let depth = 0;
  let deepest = 0;
  let quoted = false;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (quoted) {
      if (code === 0x5c) i++;
      else if (code === 0x22) quoted = false;
    } else if (code === 0x22) quoted = true;
    else if (code === 0x7b || code === 0x5b)
      deepest = Math.max(deepest, ++depth);
    else if (code === 0x7d || code === 0x5d) depth--;
  }
  return deepest;
}

export function assertModDepth(json: string, label: string): void {
  if (jsonDepth(json) > MOD_MAX_DEPTH)
    throw new Error(`${label} nests deeper than ${MOD_MAX_DEPTH} levels.`);
}

/**
 * The event input a `$.prompt.submit({ text, asUser? })` call raises: the
 * caller's own name as its origin, and no wait, since it runs once idle.
 */
export function promptSubmitCall(value: unknown, plugin: string): ModInput {
  if (
    !record(value) ||
    !only(value, ['text', 'asUser']) ||
    !text(value['text']) ||
    (value['asUser'] !== undefined && value['asUser'] !== true)
  )
    throw new Error(
      record(value) && 'attachments' in value
        ? 'Mod prompt.submit does not take attachments.'
        : 'Mod prompt.submit takes { text, asUser? } with asUser true when given.',
    );
  return {
    text: value['text'],
    wait: false,
    origin: {
      kind: 'plugin',
      name: plugin,
      ...(value['asUser'] === true && { asUser: true }),
    },
  };
}

// Claude Code's ceilings: a reply's tokens (the model's own limit may be
// lower, which the host judges) and a timer's longest wait.
export const MOD_MODEL_MAX_TOKENS = 64_000;
const MAX_TIMER_MS = 2_147_483_647;
const MODEL_REQUEST_KEYS = [
  'model',
  'prompt',
  'system',
  'maxTokens',
  'effort',
  'timeoutMs',
] as const;

// A string, or blocks of `{ text, cache? }` with `cache` true when given.
function textBlocks(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (block) =>
        record(block) &&
        only(block, ['text', 'cache']) &&
        text(block['text']) &&
        (block['cache'] === undefined || block['cache'] === true),
    )
  );
}

function modelText(
  value: unknown,
  key: string,
): { text: string; blocks?: Array<{ text: string; cache?: true }> } {
  if (text(value)) return { text: value };
  if (!textBlocks(value))
    throw new Error(
      `Mod model.complete takes ${key} as a string or a list of { text, cache? } blocks.`,
    );
  const blocks = value.map((block) => ({
    text: block['text'] as string,
    ...(block['cache'] === true && { cache: true as const }),
  }));
  return { text: blocks.map((block) => block.text).join(''), blocks };
}

function modelLimits(value: ModInput): void {
  const maxTokens = value['maxTokens'];
  if (
    maxTokens !== undefined &&
    !(Number.isSafeInteger(maxTokens) && Number(maxTokens) > 0)
  )
    throw new Error(
      'Mod model.complete takes maxTokens as a positive whole number.',
    );
  if (Number(maxTokens) > MOD_MODEL_MAX_TOKENS)
    throw new Error(
      `Mod model.complete maxTokens ${maxTokens} is over the limit of ${MOD_MODEL_MAX_TOKENS}.`,
    );
  if (
    value['effort'] !== undefined &&
    !(MOD_MODEL_EFFORTS as readonly unknown[]).includes(value['effort'])
  )
    throw new Error(
      `Mod model.complete takes effort as one of ${MOD_MODEL_EFFORTS.join(', ')}.`,
    );
  const timeoutMs = value['timeoutMs'];
  if (
    timeoutMs !== undefined &&
    !(
      Number.isSafeInteger(timeoutMs) &&
      Number(timeoutMs) > 0 &&
      Number(timeoutMs) <= MAX_TIMER_MS
    )
  )
    throw new Error(
      `Mod model.complete takes timeoutMs as a whole number from 1 to ${MAX_TIMER_MS}.`,
    );
}

/**
 * The event input a `$.model.complete(request)` call raises, in Claude Code's
 * `ModelCompleteInput`: the caller's blocks joined into `prompt` and `system`
 * and kept beside them as given.
 */
export function modelCompleteCall(value: unknown): ModInput {
  if (!record(value) || !only(value, MODEL_REQUEST_KEYS))
    throw new Error(
      'Mod model.complete takes { model, prompt, system?, maxTokens?, effort?, timeoutMs? }.',
    );
  if (!text(value['model']) || !value['model'].trim())
    throw new Error('Mod model.complete needs a model.');
  modelLimits(value);
  const prompt = modelText(value['prompt'], 'prompt');
  const system =
    value['system'] === undefined
      ? undefined
      : modelText(value['system'], 'system');
  return {
    model: value['model'],
    prompt: prompt.text,
    ...(system && { system: system.text }),
    ...(prompt.blocks && { promptBlocks: prompt.blocks }),
    ...(system?.blocks && { systemBlocks: system.blocks }),
    ...(value['maxTokens'] !== undefined && { maxTokens: value['maxTokens'] }),
    ...(value['effort'] !== undefined && { effort: value['effort'] }),
    ...(value['timeoutMs'] !== undefined && { timeoutMs: value['timeoutMs'] }),
  };
}

// What a hook passes down: the request as text, its blocks beside it.
function validateModelInput(value: ModInput): void {
  if (
    !only(value, [
      'model',
      'prompt',
      'system',
      'promptBlocks',
      'systemBlocks',
      'maxTokens',
      'effort',
      'timeoutMs',
    ]) ||
    !text(value['model']) ||
    !value['model'].trim() ||
    !text(value['prompt']) ||
    !(
      value['system'] === undefined ||
      value['system'] === null ||
      value['system'] === false ||
      text(value['system'])
    ) ||
    (value['promptBlocks'] !== undefined &&
      !textBlocks(value['promptBlocks'])) ||
    (value['systemBlocks'] !== undefined && !textBlocks(value['systemBlocks']))
  )
    throw new Error(
      'Mod model.complete takes { model, prompt, system?, promptBlocks?, systemBlocks?, maxTokens?, effort?, timeoutMs? } with prompt and system as text.',
    );
  modelLimits(value);
}

// Claude Code's `ModelCompleteResult`, answered by a hook or by the host.
export function validModelResult(value: unknown): boolean {
  if (
    !record(value) ||
    !record(value['usage']) ||
    !only(value['usage'], TURN_TOKENS) ||
    !TURN_TOKENS.every((key) => count((value['usage'] as ModInput)[key]))
  )
    return false;
  if (value['isAnswered'] === true)
    return only(value, ['isAnswered', 'text', 'usage']) && text(value['text']);
  if (value['isAnswered'] !== false) return false;
  if (value['reason'] === 'api-error')
    return (
      only(value, ['isAnswered', 'reason', 'status', 'error', 'usage']) &&
      (value['status'] === null ||
        (Number.isInteger(value['status']) &&
          Number(value['status']) >= 100 &&
          Number(value['status']) <= 599)) &&
      text(value['error'])
    );
  return (
    only(value, ['isAnswered', 'reason', 'usage']) &&
    (value['reason'] === 'empty-reply' || value['reason'] === 'aborted')
  );
}

export function validateInput(
  event: ModEvent,
  value: unknown,
  original: ModInput,
): asserts value is ModInput {
  if (!record(value)) throw new Error('Invalid Mod event input.');
  if (event === 'tool.call') {
    validateToolInput(value, original);
  } else if (event === 'command.run') {
    if (
      typeof value['args'] !== 'string' ||
      !isDeepStrictEqual({ ...value, args: '' }, { ...original, args: '' })
    )
      throw new Error('Mod hook changed pinned event fields.');
  } else if (event === 'prompt.submit') {
    if (
      !only(value, ['text', 'context', 'origin', 'wait', 'turnId']) ||
      !text(value['text']) ||
      !validContext(value['context']) ||
      ['origin', 'wait', 'turnId'].some(
        (key) => !isDeepStrictEqual(value[key], original[key]),
      )
    )
      throw new Error(
        'Mod prompt.submit takes { text, context } as a list of texts; origin, wait and turnId are pinned.',
      );
  } else if (event === 'command.register') {
    if (
      Object.keys(value).some(
        (key) => !['name', 'description', 'argumentHint'].includes(key),
      ) ||
      typeof value['name'] !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(value['name']) ||
      typeof value['description'] !== 'string' ||
      !value['description'].trim() ||
      value['description'].length > 2000 ||
      (value['argumentHint'] !== undefined &&
        typeof value['argumentHint'] !== 'string')
    )
      throw new Error('Invalid Mod command specification.');
  } else if (event === 'ui.log') {
    if (
      Object.keys(value).some((key) => !['text', 'to'].includes(key)) ||
      typeof value['text'] !== 'string' ||
      value['text'].length > 10000 ||
      (value['to'] !== 'debug' && value['to'] !== 'transcript')
    )
      throw new Error('Invalid or oversized Mod log.');
  } else if (event === 'session.usage') {
    if (
      !only(value, ['breakdown', 'columns']) ||
      (value['breakdown'] !== undefined &&
        value['breakdown'] !== 'full' &&
        value['breakdown'] !== 'summary') ||
      (value['columns'] !== undefined &&
        !(
          Number.isSafeInteger(value['columns']) && Number(value['columns']) > 0
        ))
    )
      throw new Error('Invalid Mod session.usage arguments.');
  } else if (event === 'clock.sleep') {
    if (!only(value, ['ms']) || !amount(value['ms']))
      throw new Error('Mod sleep needs a non-negative number of milliseconds.');
  } else if (event === 'turn.abort') {
    if (!only(value, ['turnId']) || !text(value['turnId']))
      throw new Error(
        'Mod turn.abort takes { turnId } (the id turn.start carried).',
      );
  } else if (event === 'ui.invalidate') {
    if (
      !only(value, ['event']) ||
      !(INVALIDATABLE_EVENTS as readonly unknown[]).includes(value['event'])
    )
      throw new Error(
        'Mod ui.invalidate takes ui.render or a cached-answer event.',
      );
  } else if (event === 'model.complete') {
    validateModelInput(value);
  } else if (MOD_STORE_EVENTS.includes(event)) {
    validateStoreInput(event, value, original);
  } else if (event === 'ui.render') {
    validateRenderInput(value, original);
  } else if (!isDeepStrictEqual(value, original))
    throw new Error('Mod hook changed pinned event fields.');
  if (Buffer.byteLength(JSON.stringify(value)) > MOD_MAX_BYTES)
    throw new Error('Mod event is too large.');
}

// A store call names its key; a hook above may write another value, never
// another key.
function validateStoreInput(
  event: ModEvent,
  value: ModInput,
  original: ModInput,
): void {
  const fields =
    event === 'store.keys'
      ? []
      : event === 'store.set'
        ? ['key', 'value']
        : ['key'];
  if (
    !only(value, fields) ||
    (event !== 'store.keys' && !text(value['key'])) ||
    (event === 'store.set' && value['value'] === undefined)
  )
    throw new Error(
      event === 'store.keys'
        ? 'Mod store.keys takes no arguments.'
        : event === 'store.set'
          ? 'Mod store.set takes a string key and a JSON value.'
          : `Mod ${event} takes a string key.`,
    );
  if (Object.keys(original).length && value['key'] !== original['key'])
    throw new Error('Mod hook changed pinned event fields.');
}

// The envelope and each site's pinned props are pinned; the other props keep
// their kind, and a row's text keeps a tree's text rules.
function validateRenderInput(value: ModInput, original: ModInput): void {
  const props = value['props'];
  const before = original['props'] as ModInput;
  for (const key of ['surface', 'component', 'requestId', 'viewport'])
    if (!isDeepStrictEqual(value[key], original[key]))
      throw new Error('Mod hook changed pinned event fields.');
  if (
    !only(value, ['surface', 'component', 'requestId', 'viewport', 'props']) ||
    !record(props) ||
    !isDeepStrictEqual(Object.keys(props).sort(), Object.keys(before).sort()) ||
    (
      MOD_RENDER_PINNED_PROPS[original['component'] as ModRenderSite] ?? []
    ).some((key) => !isDeepStrictEqual(props[key], before[key]))
  )
    throw new Error('Mod hook changed pinned event fields.');
  for (const key of Object.keys(before)) {
    const kindOf = (item: unknown) =>
      item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (kindOf(props[key]) !== kindOf(before[key]))
      throw new Error(
        `Mod ui.render props.${key} is ${kindOf(props[key])}, not ${kindOf(before[key])}.`,
      );
  }
  // Checked only once rewritten: the reply's own text may hold anything.
  if (
    original['component'] === 'AssistantMessage' &&
    props['text'] !== before['text']
  ) {
    const why = invalidRenderText(props['text'] as string);
    if (why) throw new Error(`Mod ui.render props.text ${why}.`);
  }
}

/** A hook's tree that does not validate, in Claude Code's words. */
export class ModRenderShapeError extends Error {
  constructor(component: string, reason: string) {
    super(`returned the wrong shape (a tree ${component} refuses: ${reason})`);
  }
}

// The engine events whose answer is the one field core echoes back.
const ECHOES: Partial<Record<ModEvent, string>> = {
  'session.start': 'cwd',
  'session.end': 'sessionId',
  'turn.start': 'turnId',
};

export function validateResult(
  event: ModEvent,
  value: unknown,
  input?: ModInput,
): void {
  if (event === 'ui.render') {
    try {
      validateRenderTree(value);
    } catch (error) {
      throw new ModRenderShapeError(
        String(input?.['component'] ?? 'the site'),
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (!record(value)) throw new Error('Invalid Mod ' + event + ' result.');
  let valid: boolean;
  const echoed = ECHOES[event];
  if (event === 'tool.call') valid = validToolResult(value);
  else if (event === 'tool.check') valid = validToolCheck(value);
  else if (event === 'command.run')
    valid =
      Object.keys(value).every((key) => key === 'text') &&
      (value['text'] === undefined || typeof value['text'] === 'string');
  else if (echoed)
    valid =
      Object.keys(value).every((key) => key === echoed) &&
      typeof value[echoed] === 'string';
  else if (event === 'prompt.submit')
    valid =
      'drop' in value
        ? only(value, ['drop']) && text(value['drop'])
        : only(value, ['text', 'context', 'origin']) &&
          text(value['text']) &&
          validContext(value['context']) &&
          // An answer may leave the origin out, never set another.
          (value['origin'] === undefined ||
            isDeepStrictEqual(value['origin'], input?.['origin']));
  else if (event === 'turn.complete')
    valid =
      only(value, ['text', 'usage']) &&
      text(value['text']) &&
      (value['usage'] === undefined || validTurnUsage(value['usage']));
  else {
    valid =
      Object.keys(value).every((key) => key === 'deny' || key === 'value') &&
      (!('deny' in value) ||
        (typeof value['deny'] === 'string' && !('value' in value)));
    const check = API_VALUES[event];
    if (valid && check && !('deny' in value)) valid = check(value['value']);
  }
  if (!valid) throw new Error('Unsupported ' + event + ' result fields.');
}

// What the model reads beside a prompt: a list of texts.
const validContext = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every(text));

function validUsage(value: unknown): boolean {
  if (
    !record(value) ||
    !only(value, ['startedAt', 'context', 'rateLimits', 'cost'])
  )
    return false;
  const { startedAt, context, rateLimits, cost } = value;
  return (
    amount(startedAt) &&
    record(context) &&
    only(context, ['tokens', 'window', 'percent', 'breakdown']) &&
    amount(context['window']) &&
    (context['tokens'] === undefined || amount(context['tokens'])) &&
    (context['percent'] === undefined ||
      (Number.isInteger(context['percent']) &&
        amount(context['percent']) &&
        context['percent'] <= 100)) &&
    (context['breakdown'] === undefined || record(context['breakdown'])) &&
    Array.isArray(rateLimits) &&
    rateLimits.every(
      (limit) =>
        record(limit) &&
        only(limit, ['kind', 'percentUsed', 'resetsAt']) &&
        typeof limit['kind'] === 'string' &&
        amount(limit['percentUsed']) &&
        (limit['resetsAt'] === undefined ||
          typeof limit['resetsAt'] === 'string'),
    ) &&
    (cost === undefined ||
      (record(cost) && only(cost, ['usd']) && amount(cost['usd'])))
  );
}

const TURN_TOKENS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

function validTurnUsage(value: unknown): boolean {
  return (
    record(value) &&
    only(value, [...TURN_TOKENS, 'model']) &&
    TURN_TOKENS.every((key) => count(value[key])) &&
    text(value['model'])
  );
}

// The answers an API event may carry as `{value}`, in Claude Code's shapes.
const API_VALUES: Partial<Record<ModEvent, (value: unknown) => boolean>> = {
  'clock.now': amount,
  'clock.sleep': (value) => value === undefined,
  'command.register': (value) =>
    record(value) && typeof value['command'] === 'string',
  'session.cwd': text,
  'session.id': text,
  'session.model': text,
  'session.root': text,
  'session.surface': (value) => value === null || SURFACES.includes(value),
  'session.surfaces': (value) =>
    Array.isArray(value) && value.every((item) => SURFACES.includes(item)),
  'session.turns': count,
  'session.usage': validUsage,
  'session.version': (value) =>
    record(value) && typeof value['version'] === 'string',
  'store.delete': (value) => value === undefined,
  // Any JSON value, or undefined for a key never set.
  'store.get': () => true,
  'store.keys': (value) => Array.isArray(value) && value.every(text),
  'store.set': (value) => value === undefined,
  'turn.abort': (value) => value === undefined,
  'ui.invalidate': (value) => value === undefined,
  'model.complete': validModelResult,
};

export class ModTimeoutError extends Error {
  constructor() {
    super('Mod hook timed out.');
  }
}

export class ModBudget {
  private left: number;
  private since = performance.now();
  private pauses = 0;
  constructor(readonly ms = MOD_TIMEOUT_MS) {
    this.left = ms;
  }
  get remainingMs(): number {
    return Math.max(
      0,
      this.left - (this.pauses ? 0 : performance.now() - this.since),
    );
  }
  get expired(): boolean {
    return this.remainingMs <= 0;
  }
  get lending(): boolean {
    return this.pauses > 0;
  }
  pause(): void {
    if (!this.pauses++) this.left -= performance.now() - this.since;
  }
  resume(): void {
    if (!--this.pauses) this.since = performance.now();
  }
  async lend<T>(run: () => Promise<T>): Promise<T> {
    this.pause();
    try {
      return await run();
    } finally {
      this.resume();
    }
  }
}

export interface ModModelScope {
  signal: AbortSignal;
  deadline: number;
}

export interface ModInvocation {
  id: number;
  epoch: number;
  parent?: ModInvocation;
  modelScope?: ModModelScope;
  closed: boolean;
  plugin: number;
  event: ModEvent;
  input: ModInput;
  toNativeInput: (input: ModInput) => ModInput;
  origin: ModOrigin;
  frames: ModFrame[];
  budget: ModBudget;
  live: boolean;
  recovering: boolean;
  aborted: boolean;
  last?: Promise<unknown>;
  // A local late-drop fallback does not count as a host continuation.
  promptFallback?: Promise<unknown>;
  next: (input: ModInput, frames: ModFrame[]) => Promise<unknown>;
}
