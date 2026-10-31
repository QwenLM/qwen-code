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

it('holds only the matching Session once and releases on abort with its reason', async () => {
  const create = approvalHoldFixtures();
  const other = await create('other-session');
  const ordinary = other.run();
  await other.deny();
  await vi.waitFor(() => expect(ordinary.settled).toBe(true), {
    timeout: 10_000,
  });
  expect(ordinary.error).toBeUndefined();
  expect(ordinary.parts?.[0].functionResponse?.response?.['error']).toContain(
    'denied',
  );
  expect(other.holds()).toBe(0);

  const fixture = await create();
  const committed = vi.spyOn(fixture.harness, 'commitDurableWait');
  const outcome = fixture.run();
  await vi.waitFor(() => expect(fixture.holds()).toBe(1), { timeout: 10_000 });
  expect(committed).toHaveBeenCalledOnce();
  expect(fixture.wait).not.toHaveBeenCalled();
  expect(outcome.settled).toBe(false);
  const reason = new Error('cancel held approval');
  fixture.controller.abort(reason);
  await vi.waitFor(() => expect(outcome.settled).toBe(true), {
    timeout: 10_000,
  });
  expect(outcome.error).toBeInstanceOf(Error);
  // execute() wraps an ask failure for recovery while preserving its cause.
  expect((outcome.error as Error).cause).toBe(reason);

  const next = await create();
  const repeated = next.run(2);
  await next.deny(2);
  await vi.waitFor(() => expect(repeated.settled).toBe(true), {
    timeout: 10_000,
  });
  expect(repeated.error).toBeUndefined();
  expect(
    repeated.parts?.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([
    expect.stringContaining('denied'),
    expect.stringContaining('denied'),
  ]);
  expect(next.holds()).toBe(1);
  expect(next.prepare).not.toHaveBeenCalled();
}, 60_000);
