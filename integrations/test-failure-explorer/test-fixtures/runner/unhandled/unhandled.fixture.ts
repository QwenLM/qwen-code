/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from 'vitest';

test('assertion passes despite an unhandled rejection', async () => {
  void Promise.reject(new Error('Fixture unhandled rejection'));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(2 + 2).toBe(4);
});
