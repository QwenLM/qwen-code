/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `session-registry.ts` is reachable from `config.ts` and from the package
 * barrel, so anything it evaluates at module scope is evaluated by every
 * consumer that imports either. Reading `fs.constants` at module scope
 * turned that into a hard dependency: six suites that substitute `node:fs`
 * without a `constants` export failed to load at all — no assertion ran,
 * they simply never started.
 *
 * This suite pins the load-time contract from the outside: a `node:fs`
 * substitute that omits `constants` must still let the module initialize.
 * It lives in its own file because the mock below is process-wide and would
 * otherwise defeat `session-registry.test.ts`, which exercises real I/O.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', () => ({
  // Deliberately no `constants` — this is the shape the failing suites use.
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('session-registry module initialization', () => {
  it('loads when node:fs is substituted without a constants export', async () => {
    const mod = await import('./session-registry.js');

    expect(typeof mod.registerSession).toBe('function');
    expect(typeof mod.listLiveSessions).toBe('function');
  });
});
