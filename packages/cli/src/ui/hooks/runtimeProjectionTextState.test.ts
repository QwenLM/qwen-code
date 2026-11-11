/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createAssistantTextProjectionState,
  markAssistantTextCommitted,
  markAssistantTextStreamed,
  resetAssistantTextProjection,
  shouldProjectFinalAssistantText,
} from './runtimeProjectionTextState.js';

describe('runtimeProjectionTextState', () => {
  it('suppresses final assistant text only after block text is committed', () => {
    const state = createAssistantTextProjectionState();

    expect(shouldProjectFinalAssistantText(state)).toBe(true);

    markAssistantTextStreamed(state);
    expect(shouldProjectFinalAssistantText(state)).toBe(true);

    markAssistantTextCommitted(state);
    expect(shouldProjectFinalAssistantText(state)).toBe(false);

    resetAssistantTextProjection(state);
    expect(shouldProjectFinalAssistantText(state)).toBe(true);
  });
});
