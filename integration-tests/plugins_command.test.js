/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { TestRig } from './test-helper.js';

test('should be able to run the plugins list command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/plugins list');

    assert.ok(result.includes('Available plugins:'));
});

test('should be able to run the plugins install command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/plugins install my-plugin');

    assert.ok(result.includes('Installing plugin my-plugin... (Not implemented in this MVP)'));
});

test('should be able to run the plugins uninstall command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/plugins uninstall my-plugin');

    assert.ok(result.includes('Uninstalling plugin my-plugin... (Not implemented in this MVP)'));
});
