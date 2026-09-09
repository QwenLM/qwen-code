/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
  MAX_DAEMON_WORKSPACES,
} from './channel-control-timeouts.js';

describe('channel-control compatibility', () => {
  it('preserves the public legacy capacity export', () => {
    expect(MAX_DAEMON_WORKSPACES).toBe(25);
  });

  it('preserves the transaction and rollback timeout budget', () => {
    expect(CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS).toBe(2_130_000);
  });
});
