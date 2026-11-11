/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createToolUseContext,
  createChildToolUseContext,
} from './tool-use-context-factory.js';
import type { Config } from '../config/config.js';

describe('createToolUseContext', () => {
  it('creates a frozen context with required signal', () => {
    const ac = new AbortController();
    const ctx = createToolUseContext({ signal: ac.signal });

    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.updateOutput).toBeUndefined();
    expect(ctx.options).toBeUndefined();
    expect(ctx.abortController).toBeUndefined();
    expect(ctx.config).toBeUndefined();
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('includes all supplied optional fields', () => {
    const ac = new AbortController();
    const updateOutput = () => {};
    const options = { shellExecutionConfig: {} as never };
    const config = {} as Config;

    const ctx = createToolUseContext({
      signal: ac.signal,
      abortController: ac,
      updateOutput,
      options,
      config,
      callId: 'call-123',
      toolCallScopeId: 'sched-456',
    });

    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.abortController).toBe(ac);
    expect(ctx.updateOutput).toBe(updateOutput);
    expect(ctx.options).toBe(options);
    expect(ctx.config).toBe(config);
    expect(ctx.callId).toBe('call-123');
    expect(ctx.toolCallScopeId).toBe('sched-456');
  });
});

describe('createChildToolUseContext', () => {
  it('creates a child context with independent AbortController', () => {
    const parent = new AbortController();
    const parentCtx = createToolUseContext({
      signal: parent.signal,
      abortController: parent,
      config: {} as Config,
      callId: 'call-parent',
      toolCallScopeId: 'sched-parent',
    });

    const { ctx: childCtx, cleanup } = createChildToolUseContext(parentCtx);

    // Child has a different signal
    expect(childCtx.signal).not.toBe(parentCtx.signal);
    // But inherits other fields
    expect(childCtx.config).toBe(parentCtx.config);
    expect(childCtx.callId).toBe('call-parent');
    expect(childCtx.toolCallScopeId).toBe('sched-parent');
    expect(Object.isFrozen(childCtx)).toBe(true);

    cleanup();
  });

  it('child is aborted when parent aborts', () => {
    const parent = new AbortController();
    const parentCtx = createToolUseContext({
      signal: parent.signal,
      abortController: parent,
    });

    const { ctx: childCtx } = createChildToolUseContext(parentCtx);
    expect(childCtx.signal.aborted).toBe(false);

    parent.abort('parent cancel');
    expect(childCtx.signal.aborted).toBe(true);
  });

  it('aborting child does not affect parent', () => {
    const parent = new AbortController();
    const parentCtx = createToolUseContext({
      signal: parent.signal,
      abortController: parent,
    });

    const { ctx: childCtx } = createChildToolUseContext(parentCtx);
    childCtx.abortController!.abort('child cancel');

    expect(parent.signal.aborted).toBe(false);
  });

  it('cleanup prevents parent abort from propagating to child', () => {
    const parent = new AbortController();
    const parentCtx = createToolUseContext({
      signal: parent.signal,
      abortController: parent,
    });

    const { ctx: childCtx, cleanup } = createChildToolUseContext(parentCtx);
    cleanup();

    parent.abort('late parent cancel');
    expect(childCtx.signal.aborted).toBe(false);
  });
});
