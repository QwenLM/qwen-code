/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { TestRig } from './test-helper.js';

test('should be able to run the community command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/community');

    assert.ok(result.includes('Opening the community hub in your browser: http://localhost:3001'));
});

test('should be able to run the share command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/share "My test snippet"');

    assert.ok(result.includes('Successfully shared to the community hub.'));
});
