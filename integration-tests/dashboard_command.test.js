/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { TestRig } from './test-helper.js';

test('should be able to run the dashboard command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/dashboard');

    assert.ok(result.includes('Opening the usage analytics dashboard in your browser...'));
});
