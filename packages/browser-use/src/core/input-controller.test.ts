/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { InputController } from './input-controller.js';
import { parseKeyCombination } from './input.js';

test('keypress sequences release ordinary keys and modifiers after a dispatch failure', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let failed = false;
  const controller = new InputController<string, null>(
    async (_tab, _method, params) => {
      calls.push(params);
      if (
        !failed &&
        (params.type === 'keyDown' || params.type === 'rawKeyDown') &&
        params.key === 'a'
      ) {
        failed = true;
        throw new Error('renderer detached');
      }
      return null;
    },
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(
    controller.keypressSequence('tab', ['Control', 'a']),
    /renderer detached/,
  );
  assert.ok(calls.some((call) => call.type === 'keyUp' && call.key === 'a'));
  assert.ok(
    calls.some(
      (call) =>
        call.type === 'keyUp' && call.key === 'Control' && call.modifiers === 0,
    ),
  );
});

test('locator key combinations release modifiers when the key-up dispatch fails', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let failed = false;
  const controller = new InputController<string, null>(
    async (_tab, _method, params) => {
      calls.push(params);
      if (!failed && params.type === 'keyUp' && params.key === 'a') {
        failed = true;
        throw new Error('key-up failed');
      }
      return null;
    },
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(
    controller.pressCombination('tab', parseKeyCombination('Shift+a')),
    /key-up failed/,
  );
  assert.equal(
    calls.filter((call) => call.type === 'keyUp' && call.key === 'a').length,
    2,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.type === 'keyUp' && call.key === 'Shift' && call.modifiers === 0,
    ),
  );
});

test('atomic pointer and text input retry releases after an uncertain dispatch failure', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let failedMouseRelease = false;
  let failedKeyRelease = false;
  const controller = new InputController<string, null>(
    async (_tab, _method, params) => {
      calls.push(params);
      if (!failedMouseRelease && params.type === 'mouseReleased') {
        failedMouseRelease = true;
        throw new Error('mouse release transport failure');
      }
      if (!failedKeyRelease && params.type === 'keyUp' && params.key === 'a') {
        failedKeyRelease = true;
        throw new Error('key release transport failure');
      }
      return null;
    },
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(
    controller.mouseClick(
      'tab',
      10,
      20,
      { button: 'left', modifiers: 0, clicks: 1 },
      null,
    ),
    /mouse release transport failure/,
  );
  await assert.rejects(
    controller.typeText('tab', 'a'),
    /key release transport failure/,
  );

  assert.equal(calls.filter((call) => call.type === 'mouseReleased').length, 2);
  assert.equal(
    calls.filter((call) => call.type === 'keyUp' && call.key === 'a').length,
    2,
  );
});

test('failed split input presses do not retain empty per-tab state', async () => {
  const controller = new InputController<string, null>(
    async (_tab, _method, params) => {
      if (params.type === 'mousePressed' || params.type === 'keyDown')
        throw new Error('dispatch failed');
      return null;
    },
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(
    controller.executeCoordinate(
      'cua.mouse_down',
      'mouse-tab',
      { x: 1, y: 2, button: 1 },
      null,
    ),
    /dispatch failed/,
  );
  await assert.rejects(
    controller.executeCoordinate('cua.key_down', 'key-tab', { key: 'a' }, null),
    /dispatch failed/,
  );

  const states = (controller as unknown as { states: Map<string, unknown> })
    .states;
  assert.equal(states.size, 0);
});
