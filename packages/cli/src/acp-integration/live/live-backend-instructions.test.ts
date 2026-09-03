/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { LIVE_BACKEND_START_INSTRUCTIONS } from './live-backend-instructions.js';

describe('Live backend instructions', () => {
  it('keeps explicit task creation out of the current Live session', () => {
    expect(LIVE_BACKEND_START_INSTRUCTIONS).toContain(
      'call create_thread once for the requested work',
    );
    expect(LIVE_BACKEND_START_INSTRUCTIONS).toContain(
      'never satisfy a request to create, open, or start a separate task',
    );
  });

  it('treats a task observation timeout as a normal snapshot', () => {
    expect(LIVE_BACKEND_START_INSTRUCTIONS).toContain(
      'does not mean that the task failed',
    );
  });
});
