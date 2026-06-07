/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ConnectionRegistry } from './connectionRegistry.js';

describe('ConnectionRegistry', () => {
  it('evict aborts a registered controller', () => {
    const reg = new ConnectionRegistry();
    const ctrl = new AbortController();
    reg.register('tok-1', ctrl);
    reg.evict('tok-1');
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('aborts every controller registered under the same id', () => {
    const reg = new ConnectionRegistry();
    const a = new AbortController();
    const b = new AbortController();
    reg.register('tok-1', a);
    reg.register('tok-1', b);
    reg.evict('tok-1');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('unregister prevents later eviction', () => {
    const reg = new ConnectionRegistry();
    const ctrl = new AbortController();
    const unregister = reg.register('tok-1', ctrl);
    unregister();
    reg.evict('tok-1');
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('evict on an unknown id is a no-op', () => {
    const reg = new ConnectionRegistry();
    expect(() => reg.evict('nobody')).not.toThrow();
  });
});
