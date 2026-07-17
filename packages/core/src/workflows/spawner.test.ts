/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  validateAgainstSchema,
  type AgentSpawner,
  type AgentSpawnRequest,
  type AgentSpawnResult,
} from './spawner.js';

/** A stub spawner proving the AgentSpawner contract without a live model. */
class StubSpawner implements AgentSpawner {
  constructor(private readonly reply: AgentSpawnResult) {}
  async spawn(_req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    return this.reply;
  }
}

describe('AgentSpawner contract', () => {
  it('a stub spawner returns text + tokens', async () => {
    const s = new StubSpawner({ text: 'hello', tokens: 12 });
    const r = await s.spawn({ prompt: 'hi', systemContext: '' });
    expect(r).toEqual({ text: 'hello', tokens: 12 });
  });
});

describe('validateAgainstSchema (schema helper used by HeadlessSpawner)', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  };

  it('accepts clean JSON', () => {
    expect(validateAgainstSchema('{"title":"ok"}', schema)).toEqual({
      valid: true,
      value: { title: 'ok' },
    });
  });

  it('repairs then accepts loose JSON', () => {
    // Trailing comma + prose wrapper — jsonrepair + extraction recover it.
    const res = validateAgainstSchema('Here: {"title":"ok",}', schema);
    expect(res.valid).toBe(true);
  });

  it('rejects schema-violating JSON with an error string', () => {
    const res = validateAgainstSchema('{"nope":1}', schema);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/title/);
  });
});
