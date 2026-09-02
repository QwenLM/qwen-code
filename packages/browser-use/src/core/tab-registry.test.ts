/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { TabRegistry } from './tab-registry.js';

test('tab registry keeps public and provider identities in sync', () => {
  const registry = new TabRegistry<{
    id: string;
    providerTabId: number;
    title: string;
  }>();
  const first = { id: 'tab-1', providerTabId: 41, title: 'first' };
  registry.set(first);

  assert.equal(registry.get('tab-1'), first);
  assert.equal(registry.getByProviderId(41), first);

  const replacement = { id: 'tab-2', providerTabId: 41, title: 'replacement' };
  registry.set(replacement);
  assert.equal(registry.get('tab-1'), undefined);
  assert.equal(registry.getByProviderId(41), replacement);

  assert.equal(registry.delete('tab-2'), true);
  assert.equal(registry.getByProviderId(41), undefined);
  assert.equal(registry.delete('tab-2'), false);
});
