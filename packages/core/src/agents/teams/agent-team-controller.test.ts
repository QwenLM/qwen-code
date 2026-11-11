/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  registerTeammateController,
  resetTeammateControllersForTest,
  signalTeammateController,
  tryRegisterTeammateController,
  waitForTeammateControllerSignal,
} from './agent-team-controller.js';

describe('agent team controller', () => {
  afterEach(() => {
    resetTeammateControllersForTest();
  });

  it('wakes a registered teammate without creating another runner', async () => {
    const unregister = registerTeammateController('agent-reviewer');
    const waiting = waitForTeammateControllerSignal(
      'agent-reviewer',
      new AbortController().signal,
      60_000,
    );

    expect(signalTeammateController('agent-reviewer')).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    unregister();
    expect(signalTeammateController('agent-reviewer')).toBe(false);
  });

  it('rejects an idle wait when the teammate lifecycle is stopped', async () => {
    const controller = new AbortController();
    registerTeammateController('agent-reviewer');
    const waiting = waitForTeammateControllerSignal(
      'agent-reviewer',
      controller.signal,
      60_000,
    );

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('allows only one resumed runner to own a teammate', () => {
    const first = tryRegisterTeammateController('agent-reviewer');
    const second = tryRegisterTeammateController('agent-reviewer');

    expect(first).toBeTypeOf('function');
    expect(second).toBeUndefined();

    first?.();
    expect(tryRegisterTeammateController('agent-reviewer')).toBeTypeOf(
      'function',
    );
  });
});
