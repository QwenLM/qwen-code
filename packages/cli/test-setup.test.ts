/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { getUserSettingsDir } from './src/config/settings.js';

// Witness for the QWEN_HOME pin in test-setup.ts: the suite must never
// resolve operator settings from the ambient $HOME/.qwen, where one malformed
// settings.json on a shared runner fails every reader at once. Holds whether
// the pin applied or the environment legitimately selected its own QWEN_HOME.
// This file must never set, stub, or delete QWEN_HOME — it would then observe
// its own mutation instead of the pin.
describe('test-setup QWEN_HOME pin', () => {
  it('keeps the resolved user settings dir off the ambient $HOME/.qwen', () => {
    expect(getUserSettingsDir()).not.toBe(path.join(homedir(), '.qwen'));
  });
});
