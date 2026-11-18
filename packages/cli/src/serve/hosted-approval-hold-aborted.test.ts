/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { approvalHoldFixtures } from '../test-utils/hosted-approval-hold.js';

vi.hoisted(() => {
  vi.stubEnv('QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL', 'approval-hold-session');
});

it('releases a hold already aborted during its durable commit without a reason', async () => {
  const fixture = await approvalHoldFixtures()();
  const commit = fixture.harness.commitDurableWait.bind(fixture.harness);
  vi.spyOn(fixture.harness, 'commitDurableWait').mockImplementationOnce(
    async (...args) => {
      const boundary = await commit(...args);
      fixture.controller.abort(null);
      return boundary;
    },
  );
  const outcome = fixture.run();
  await vi.waitFor(() => expect(outcome.settled).toBe(true), {
    timeout: 10_000,
  });
  expect(fixture.holds()).toBe(1);
  expect(outcome.error).toBeInstanceOf(Error);
  expect((outcome.error as Error).cause).toEqual(new Error('aborted'));
  expect(fixture.wait).not.toHaveBeenCalled();
  expect(fixture.prepare).not.toHaveBeenCalled();
});
