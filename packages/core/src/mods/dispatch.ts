/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { MOD_TIMEOUT_MS, MOD_MAX_BYTES, MOD_MAX_DEPTH } from './types.js';
import {
  validateToolInput,
  validToolResult,
  validToolCheck,
} from './tool-events.js';

export const MOD_METHODS = [
  'clock.now',
  'clock.sleep',
  'command.register',
  'session.cwd',
  'session.id',
  'session.model',
  'session.root',
  'session.surface',
  'session.surfaces',
  'session.turns',
  'session.usage',
  'session.version',
  'ui.log',
] as const;
export const MOD_EVENTS = [
  'clock.now',
  'clock.sleep',
  'command.register',
  'command.run',
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
  'tool.call',
  'tool.check',
  'ui.log',
] as const;
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
  } else if (!isDeepStrictEqual(value, original))
    throw new Error('Mod hook changed pinned event fields.');
  if (Buffer.byteLength(JSON.stringify(value)) > MOD_MAX_BYTES)
    throw new Error('Mod event is too large.');
}

export function validateResult(event: ModEvent, value: unknown): void {
  if (!record(value)) throw new Error('Invalid Mod ' + event + ' result.');
  let valid: boolean;
  if (event === 'tool.call') valid = validToolResult(value);
  else if (event === 'tool.check') valid = validToolCheck(value);
  else if (event === 'command.run')
    valid =
      Object.keys(value).every((key) => key === 'text') &&
      (value['text'] === undefined || typeof value['text'] === 'string');
  else if (event === 'session.start' || event === 'session.end') {
    const key = event === 'session.start' ? 'cwd' : 'sessionId';
    valid =
      Object.keys(value).every((k) => k === key) &&
      typeof value[key] === 'string';
  } else {
    valid =
      Object.keys(value).every((key) => key === 'deny' || key === 'value') &&
      (!('deny' in value) ||
        (typeof value['deny'] === 'string' && !('value' in value)));
    const check = API_VALUES[event];
    if (valid && check && !('deny' in value)) valid = check(value['value']);
  }
  if (!valid) throw new Error('Unsupported ' + event + ' result fields.');
}

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
  'session.turns': (value) => Number.isSafeInteger(value) && Number(value) >= 0,
  'session.usage': validUsage,
  'session.version': (value) =>
    record(value) && typeof value['version'] === 'string',
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

export interface ModInvocation {
  id: number;
  epoch: number;
  parent?: ModInvocation;
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
  next: (input: ModInput, frames: ModFrame[]) => Promise<unknown>;
}
