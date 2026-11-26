/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { appEvents, AppEvent } from './events.js';

describe('events', () => {
  it('should work with events without data', () => {
    const callback = vi.fn();
    appEvents.on(AppEvent.Flicker, callback);

    appEvents.emit(AppEvent.Flicker);

    expect(callback).toHaveBeenCalled();

    appEvents.off(AppEvent.Flicker, callback);
  });
});
