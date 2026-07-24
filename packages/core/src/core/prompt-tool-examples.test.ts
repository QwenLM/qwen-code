/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt.js';
import { getCoreSystemPrompt } from './prompts.js';

describe('prompt tool call examples', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not append Qwen model-specific tool examples', () => {
    vi.stubEnv('QWEN_CODE_TOOL_CALL_STYLE', 'qwen-vl');
    const prompt = getCoreSystemPrompt();

    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(prompt).not.toContain('# Examples (Illustrating Tone and Workflow)');
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).not.toContain('[tool_call:');
  });
});
