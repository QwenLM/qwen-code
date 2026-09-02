/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { BrowserRuntimeError } from './errors.js';
import { TabOperationCoordinator } from './tab-operation-coordinator.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('one tab rejects overlapping actions but permits observers and other tabs', async () => {
  const coordinator = new TabOperationCoordinator();
  const gate = deferred();
  const first = coordinator.run(
    'locator.click',
    { tabId: 'tab-a' },
    async () => {
      await gate.promise;
      return 'first';
    },
  );

  await assert.rejects(
    coordinator.run('locator.fill', { tabId: 'tab-a' }, async () => 'second'),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'CONCURRENT_TAB_OPERATION' &&
      error.details?.activeMethod === 'locator.click',
  );

  assert.equal(
    await coordinator.run(
      'playwright.waitForEvent',
      { tabId: 'tab-a' },
      async () => 'observer',
    ),
    'observer',
  );
  assert.equal(
    await coordinator.run(
      'playwright.domSnapshotWithMetadata',
      { tabId: 'tab-a' },
      async () => 'snapshot',
    ),
    'snapshot',
  );
  assert.equal(
    await coordinator.run(
      'locator.fill',
      { tabId: 'tab-b' },
      async () => 'other-tab',
    ),
    'other-tab',
  );

  gate.resolve();
  assert.equal(await first, 'first');
  assert.equal(
    await coordinator.run(
      'locator.fill',
      { tabId: 'tab-a' },
      async () => 'after',
    ),
    'after',
  );
});

test('split input gestures reject unrelated actions until their matching release', async () => {
  const coordinator = new TabOperationCoordinator();
  coordinator.beginGesture('tab-a', 'pointer');

  assert.equal(
    await coordinator.run('cua.move', { tabId: 'tab-a' }, async () => 'move'),
    'move',
  );
  await assert.rejects(
    coordinator.run('locator.click', { tabId: 'tab-a' }, async () => 'click'),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'CONCURRENT_TAB_OPERATION' &&
      error.details?.activeGesture === 'pointer',
  );

  assert.equal(
    await coordinator.run('tab.url', { tabId: 'tab-a' }, async () => 'observe'),
    'observe',
  );
  coordinator.endGesture('tab-a', 'pointer');
  assert.equal(
    await coordinator.run(
      'locator.click',
      { tabId: 'tab-a' },
      async () => 'after',
    ),
    'after',
  );
});

test('tab lifecycle cleanup preserves an action lease until the owner unwinds', async () => {
  const coordinator = new TabOperationCoordinator();
  const gate = deferred();
  const first = coordinator.run('tab.close', { tabId: 'tab-a' }, async () => {
    await gate.promise;
    return 'closed';
  });

  coordinator.beginGesture('tab-a', 'pointer');
  coordinator.clearTab('tab-a');
  await assert.rejects(
    coordinator.run('locator.click', { tabId: 'tab-a' }, async () => 'overlap'),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'CONCURRENT_TAB_OPERATION' &&
      error.details?.activeMethod === 'tab.close',
  );

  gate.resolve();
  assert.equal(await first, 'closed');
  assert.equal(
    await coordinator.run(
      'locator.click',
      { tabId: 'tab-a' },
      async () => 'after',
    ),
    'after',
  );
});
