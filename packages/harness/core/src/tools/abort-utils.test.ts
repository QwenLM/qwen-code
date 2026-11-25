/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createChildAbortController } from './abort-utils.js';

describe('createChildAbortController', () => {
  it('creates a child that is initially not aborted', () => {
    const parent = new AbortController();
    const { controller, cleanup } = createChildAbortController(parent.signal);
    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  it('aborts child when parent aborts', () => {
    const parent = new AbortController();
    const { controller } = createChildAbortController(parent.signal);

    parent.abort('test reason');
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('test reason');
  });

  it('does not abort parent when child aborts', () => {
    const parent = new AbortController();
    const { controller } = createChildAbortController(parent.signal);

    controller.abort('child reason');
    expect(parent.signal.aborted).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it('immediately aborts child if parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort('pre-aborted');

    const { controller, cleanup } = createChildAbortController(parent.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('pre-aborted');
    cleanup();
  });

  it('cleanup removes the parent listener', () => {
    const parent = new AbortController();
    const { controller, cleanup } = createChildAbortController(parent.signal);

    cleanup();
    parent.abort('after cleanup');

    // Child should NOT be aborted since we cleaned up the listener
    expect(controller.signal.aborted).toBe(false);
  });

  it('multiple children are independently cancellable', () => {
    const parent = new AbortController();
    const child1 = createChildAbortController(parent.signal);
    const child2 = createChildAbortController(parent.signal);

    child1.controller.abort('only child1');
    expect(child1.controller.signal.aborted).toBe(true);
    expect(child2.controller.signal.aborted).toBe(false);
    expect(parent.signal.aborted).toBe(false);

    child2.cleanup();
  });

  it('parent abort propagates to all children', () => {
    const parent = new AbortController();
    const child1 = createChildAbortController(parent.signal);
    const child2 = createChildAbortController(parent.signal);

    parent.abort('parent done');
    expect(child1.controller.signal.aborted).toBe(true);
    expect(child2.controller.signal.aborted).toBe(true);
  });
});
