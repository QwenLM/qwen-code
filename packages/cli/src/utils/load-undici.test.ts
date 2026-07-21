/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { UndiciModule } from './load-undici.js';

const makeModule = (partial: Partial<UndiciModule> = {}): UndiciModule =>
  ({
    Agent: class {},
    ProxyAgent: class {},
    EnvHttpProxyAgent: class {},
    fetch: vi.fn(),
    setGlobalDispatcher: vi.fn(),
    ...partial,
  }) as unknown as UndiciModule;

describe('loadUndici CJS interop normalization', () => {
  it('unwraps a default-only esbuild chunk', async () => {
    vi.resetModules();
    vi.doMock('undici', () => ({
      default: makeModule({ Agent: class DefaultAgent {} }),
    }));
    const { loadUndici } = await import('./load-undici.js');
    const mod = await loadUndici();
    expect(mod.Agent.name).toBe('DefaultAgent');
    vi.doUnmock('undici');
  });

  it('uses named exports when the module is not default-only', async () => {
    vi.resetModules();
    vi.doMock('undici', () => makeModule({ Agent: class NamedAgent {} }));
    const { loadUndici } = await import('./load-undici.js');
    const mod = await loadUndici();
    expect(mod.Agent.name).toBe('NamedAgent');
    vi.doUnmock('undici');
  });

  it('handles mixed default + named shape by preferring named exports', async () => {
    vi.resetModules();
    vi.doMock('undici', () => ({
      ...makeModule({ Agent: class NamedAgent {} }),
      default: makeModule({ Agent: class DefaultAgent {} }),
    }));
    const { loadUndici } = await import('./load-undici.js');
    const mod = await loadUndici();
    expect(mod.Agent.name).toBe('NamedAgent');
    vi.doUnmock('undici');
  });
});
