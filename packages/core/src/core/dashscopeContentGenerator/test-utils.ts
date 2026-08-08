/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { parseDashScopeSse, type DashScopeSseFrame } from './sse.js';
import type { DashScopeRequest, DashScopeResponsePayload } from './types.js';
import type { DashScopeTransport } from './transport.js';

/**
 * Scripted in-memory {@link DashScopeTransport} for generator-level tests.
 * Records every call it receives; `postJson` shifts one response per call
 * (throwing once the script is exhausted), and `postSse` replays the next
 * frames array as an async generator.
 */
export class FakeDashScopeTransport implements DashScopeTransport {
  readonly calls: Array<{
    kind: 'json' | 'sse';
    body: DashScopeRequest;
    signal: AbortSignal;
  }> = [];

  constructor(
    private readonly script: {
      json?: DashScopeResponsePayload[];
      frames?: DashScopeSseFrame[][];
    },
  ) {}

  async postJson(
    body: DashScopeRequest,
    opts: { signal: AbortSignal },
  ): Promise<DashScopeResponsePayload> {
    this.calls.push({ kind: 'json', body, signal: opts.signal });
    const next = this.script.json?.shift();
    if (!next) {
      throw new Error('FakeDashScopeTransport: postJson script exhausted');
    }
    return next;
  }

  async postSse(
    body: DashScopeRequest,
    opts: { signal: AbortSignal },
  ): Promise<AsyncGenerator<DashScopeSseFrame>> {
    this.calls.push({ kind: 'sse', body, signal: opts.signal });
    const next = this.script.frames?.shift();
    if (!next) {
      throw new Error('FakeDashScopeTransport: postSse script exhausted');
    }
    return (async function* (): AsyncGenerator<DashScopeSseFrame> {
      for (const frame of next) {
        yield frame;
      }
    })();
  }
}

export function createDashScopeGeneratorConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    apiKey: 'test-key',
    model: 'qwen3.8-max',
    authType: AuthType.USE_DASHSCOPE,
    ...overrides,
  } as ContentGeneratorConfig;
}

export function createFakeCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getResolvedModelConfig: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

/**
 * Decodes raw DashScope SSE text (e.g. a fixture file's contents) into
 * frames via the real {@link parseDashScopeSse} decoder, so tests exercise
 * the same parsing path production code uses.
 */
export async function framesFromSseText(
  raw: string,
): Promise<DashScopeSseFrame[]> {
  const stream = new Blob([raw]).stream() as ReadableStream<Uint8Array>;
  const frames: DashScopeSseFrame[] = [];
  for await (const frame of parseDashScopeSse(stream)) {
    frames.push(frame);
  }
  return frames;
}
