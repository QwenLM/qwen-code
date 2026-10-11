/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from 'vitest';

test('passes', () => {
  expect(2).toBe(2);
});
test.skip('explicitly skipped', () => {});
test.todo('not implemented');
test('skipped at runtime', (context) => {
  context.skip();
});
