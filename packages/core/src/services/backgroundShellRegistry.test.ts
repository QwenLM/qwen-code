/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BackgroundShellRegistry,
  type BackgroundShellEntry,
} from './backgroundShellRegistry.js';

function makeEntry(
  overrides: Partial<BackgroundShellEntry> = {},
): BackgroundShellEntry {
  return {
    shellId: 's1',
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: 1000,
    outputPath: '/tmp/s1.output',
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('BackgroundShellRegistry', () => {
  describe('register / get / getAll', () => {
    it('round-trips a registered entry by id', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeEntry({ shellId: 'a' });
      reg.register(e);
      expect(reg.get('a')).toBe(e);
    });

    it('returns undefined for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(reg.get('missing')).toBeUndefined();
    });

    it('lists all entries via getAll', () => {
      const reg = new BackgroundShellRegistry();
      const a = makeEntry({ shellId: 'a' });
      const b = makeEntry({ shellId: 'b' });
      reg.register(a);
      reg.register(b);
      const all = reg.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });
  });

  describe('complete', () => {
    it('transitions running → completed with exitCode and endTime', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.exitCode).toBe(0);
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.cancel('a', 1500);
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.exitCode).toBeUndefined();
    });

    it('is a no-op for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.complete('missing', 0, 0)).not.toThrow();
    });
  });

  describe('fail', () => {
    it('transitions running → failed with error and endTime', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.fail('a', 'spawn error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('failed');
      expect(e.error).toBe('spawn error');
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 1500);
      reg.fail('a', 'late error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.error).toBeUndefined();
    });
  });

  describe('cancel', () => {
    it('transitions running → cancelled and aborts the signal', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.endTime).toBe(2000);
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op when entry is already terminal', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));
      reg.complete('a', 0, 1500);
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.cancel('missing', 0)).not.toThrow();
    });
  });
});
