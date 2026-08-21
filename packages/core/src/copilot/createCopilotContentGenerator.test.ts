/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createCopilotContentGenerator } from './createCopilotContentGenerator.js';
import type {
  ContentGeneratorConfig,
  AuthType,
} from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';

// Minimal Config stub: the underlying generators call getCliVersion() and
// getProxy() eagerly in their constructors. We don't exercise the network
// here — we only assert the generator is constructed and exposes the
// ContentGenerator shape.
function mockConfig(): Config {
  return {
    getCliVersion: () => 'test',
    getProxy: () => undefined,
  } as unknown as Config;
}

describe('createCopilotContentGenerator', () => {
  it('returns a ContentGenerator for a claude model (messages wire)', async () => {
    const genConfig: ContentGeneratorConfig = {
      model: 'claude-opus-4.7',
      apiKey: 'test-key',
      authType: 'copilot' as AuthType,
    };
    const gen = await createCopilotContentGenerator(genConfig, mockConfig());
    expect(gen).toBeDefined();
    expect(typeof (gen as { generateContent: unknown }).generateContent).toBe(
      'function',
    );
  });

  it('returns a ContentGenerator for a gpt-5 model (responses wire)', async () => {
    const genConfig: ContentGeneratorConfig = {
      model: 'gpt-5.2',
      apiKey: 'test-key',
      authType: 'copilot' as AuthType,
    };
    const gen = await createCopilotContentGenerator(genConfig, mockConfig());
    expect(gen).toBeDefined();
  });
});
