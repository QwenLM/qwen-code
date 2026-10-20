/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { MOD_TIMEOUT_MS, MOD_MAX_BYTES } from './types.js';
import {
  validateToolInput,
  validToolResult,
  validToolCheck,
} from './tool-events.js';

export type ModEvent =
  | 'session.start'
  | 'session.end'
  | 'command.run'
  | 'command.register'
  | 'tool.call'
  | 'tool.check'
  | 'ui.log';
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
    if (valid && event === 'command.register' && !('deny' in value))
      valid =
        record(value['value']) && typeof value['value']['command'] === 'string';
  }
  if (!valid) throw new Error('Unsupported ' + event + ' result fields.');
}

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
  async lend<T>(run: () => Promise<T>): Promise<T> {
    if (!this.pauses++) this.left -= performance.now() - this.since;
    try {
      return await run();
    } finally {
      if (!--this.pauses) this.since = performance.now();
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
