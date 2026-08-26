/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GeminiChat,
  GeminiClient,
  GeminiEventType,
  LlmChat,
  LlmClient,
  LlmEventType,
} from './index.js';
import { LlmChat as LegacyPathLlmChat } from './core/geminiChat.js';

describe('deprecated LLM rename aliases', () => {
  it('keeps the published class, enum, and module-path aliases', () => {
    expect(GeminiClient).toBe(LlmClient);
    expect(GeminiChat).toBe(LlmChat);
    expect(GeminiEventType).toBe(LlmEventType);
    expect(LegacyPathLlmChat).toBe(LlmChat);
  });
});
