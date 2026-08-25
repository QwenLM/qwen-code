/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-dispatch contract test. Run through vitest (the `describe`
 * guard keeps the assertions wrappable in a suite there). A plain
 * `node --experimental-strip-types` run of this file cannot work: the
 * NodeNext `.js` specifiers only resolve after a build or through vitest's
 * `.js` → `.ts` rewrite, and Node's type stripping does neither — so no
 * standalone runner command is documented here.
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_RENDERER,
  EXPERIMENTAL_RENDERER,
  RENDERER_ENV_VAR,
  isExperimentalRenderer,
  pickRenderer,
  rendererExplicitlyRequested,
  type RendererId,
} from './dispatch.js';

type Case = readonly [string, NodeJS.ProcessEnv, RendererId];

const cases: readonly Case[] = [
  ['empty env', {}, DEFAULT_RENDERER],
  ['variable unset', { PATH: '/usr/bin' }, DEFAULT_RENDERER],
  ['empty value', { QWEN_TUI_RENDERER: '' }, DEFAULT_RENDERER],
  ['garbage value', { QWEN_TUI_RENDERER: 'garbage' }, DEFAULT_RENDERER],
  ['opentui value', { QWEN_TUI_RENDERER: 'opentui' }, EXPERIMENTAL_RENDERER],
  ['ink fallback', { QWEN_TUI_RENDERER: 'ink' }, 'ink'],
];

function runAssertions(): void {
  for (const [name, env, expected] of cases) {
    assert.equal(pickRenderer(env), expected, `pickRenderer: ${name}`);
  }

  delete process.env[RENDERER_ENV_VAR];
  assert.equal(pickRenderer(), DEFAULT_RENDERER, 'pickRenderer: process.env');

  assert.equal(isExperimentalRenderer('opentui'), true);
  assert.equal(isExperimentalRenderer('ink'), false);

  assert.equal(rendererExplicitlyRequested({}), false);
  assert.equal(rendererExplicitlyRequested({ QWEN_TUI_RENDERER: '' }), false);
  assert.equal(
    rendererExplicitlyRequested({ QWEN_TUI_RENDERER: 'garbage' }),
    false,
  );
  assert.equal(
    rendererExplicitlyRequested({ QWEN_TUI_RENDERER: 'opentui' }),
    true,
  );
  assert.equal(rendererExplicitlyRequested({ QWEN_TUI_RENDERER: 'ink' }), true);
}

if (typeof describe === 'function' && typeof it === 'function') {
  describe('renderer dispatch', () => {
    it('defaults to opentui, honors explicit values, and reports explicit requests', () => {
      runAssertions();
    });
  });
} else {
  runAssertions();
  console.log('dispatch.test.ts: all assertions passed');
}
