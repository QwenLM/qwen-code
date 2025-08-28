/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { TestRig } from './test-helper.js';

test('should be able to run the profile command', async (t) => {
    const rig = new TestRig();
    rig.setup(t.name);

    const result = rig.run('/profile');

    assert.ok(result.includes('Your Profile:'));
});
