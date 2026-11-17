/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { approvalHoldFixtures } from '../test-utils/hosted-approval-hold.js';

vi.hoisted(() => {
  vi.stubEnv('QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL', undefined);
});

it('continues through approval when the hold env is unset', async () => {
  const fixture = await approvalHoldFixtures()();
  const outcome = fixture.run();
  await fixture.deny();
  await vi.waitFor(() => expect(outcome.settled).toBe(true), {
    timeout: 10_000,
  });
  expect(outcome.error).toBeUndefined();
  expect(outcome.parts?.[0].functionResponse?.response?.['error']).toContain(
    'denied',
  );
  expect(fixture.holds()).toBe(0);
  expect(fixture.prepare).not.toHaveBeenCalled();
});
