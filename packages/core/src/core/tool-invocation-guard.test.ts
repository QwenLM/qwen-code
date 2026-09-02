/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluateToolInvocationGuard } from './tool-invocation-guard.js';

const context = () => ({
  callId: 'call-1',
  toolName: 'read_file',
  args: { path: '/tmp/input.txt', nested: { value: 'original' } },
  signal: new AbortController().signal,
});

describe('evaluateToolInvocationGuard', () => {
  it('allows calls when the guard permits them', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ allowed: true }),
        context(),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it('returns the configured denial reason', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ allowed: false, reason: 'blocked' }),
        context(),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'blocked' });
  });

  it('uses a stable reason when the guard denies without one', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ allowed: false }),
        context(),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation denied by host policy',
    });
  });

  it('uses a stable reason when the guard denies with a blank reason', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ allowed: false, reason: ' ' }),
        context(),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation denied by host policy',
    });
  });

  it('uses a stable reason when the guard denies with a non-string reason', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ allowed: false, reason: 42 }),
        context(),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation denied by host policy',
    });
  });

  it('fails closed when the guard throws', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockRejectedValue(new Error('sensitive provider error')),
        context(),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation guard failed',
    });
  });

  it('fails closed when the guard returns a malformed decision', async () => {
    await expect(
      evaluateToolInvocationGuard(
        vi.fn().mockResolvedValue({ result: 'allow' }),
        context(),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation guard failed',
    });
  });

  it('fails closed when invocation arguments cannot be cloned', async () => {
    const guard = vi.fn();

    await expect(
      evaluateToolInvocationGuard(guard, {
        ...context(),
        args: { callback: () => undefined },
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation guard failed',
    });
    expect(guard).not.toHaveBeenCalled();
  });

  it('does not call the guard for an already-aborted invocation', async () => {
    const controller = new AbortController();
    const guard = vi.fn();
    controller.abort();

    await expect(
      evaluateToolInvocationGuard(guard, {
        ...context(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation guard failed',
    });
    expect(guard).not.toHaveBeenCalled();
  });

  it('fails closed when the invocation is aborted while awaiting the guard', async () => {
    const controller = new AbortController();
    let resolveGuard!: (decision: { allowed: true }) => void;
    const guard = vi.fn(
      () =>
        new Promise<{ allowed: true }>((resolve) => {
          resolveGuard = resolve;
        }),
    );
    const evaluation = evaluateToolInvocationGuard(guard, {
      ...context(),
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
    controller.abort();
    resolveGuard({ allowed: true });

    await expect(evaluation).resolves.toEqual({
      allowed: false,
      reason: 'Tool invocation guard failed',
    });
  });

  it('does not let the guard mutate invocation arguments', async () => {
    const original = context();
    await evaluateToolInvocationGuard((received) => {
      (received.args['nested'] as { value: string }).value = 'changed';
      return { allowed: true };
    }, original);

    expect(original.args['nested'].value).toBe('original');
  });
});
