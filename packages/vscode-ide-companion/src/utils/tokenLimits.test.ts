/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { tokenLimit, DEFAULT_TOKEN_LIMIT } from './tokenLimits.js';

// This mirror must stay behavior-compatible with
// packages/core/src/core/tokenLimits.ts. These cases match the core suite so a
// drift on either side turns red.
describe('vscode-ide-companion tokenLimit (browser-safe mirror)', () => {
  describe('Anthropic Claude input limits', () => {
    it('returns 1M for canonical hyphenated / bare Opus 4.6-4.8 and 5.x', () => {
      expect(tokenLimit('claude-opus-4-6')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4-7')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4-8')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-5')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-5-0')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-5-1')).toBe(1_000_000);
    });

    it('returns 1M for dotted-minor Opus aliases (LiteLLM/Vertex/Bedrock)', () => {
      expect(tokenLimit('claude-opus-4.6')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4.7')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4.8')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-5.0')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-5.1')).toBe(1_000_000);
    });

    it('returns 1M for dotted-revision and space-separated Opus aliases', () => {
      expect(tokenLimit('claude-opus-4.8.0')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4-8.0')).toBe(1_000_000);
      expect(tokenLimit('claude-opus-4-8.1')).toBe(1_000_000);
      expect(tokenLimit('Claude Opus 4.8')).toBe(1_000_000);
      expect(tokenLimit('claude opus 4.8')).toBe(1_000_000);
    });

    it('returns 1M for vertex/bedrock-prefixed Opus aliases', () => {
      expect(tokenLimit('vertex/claude-opus-4-8')).toBe(1_000_000);
      expect(tokenLimit('vertex/claude-opus-4.8')).toBe(1_000_000);
      expect(tokenLimit('bedrock/claude-opus-4.8')).toBe(1_000_000);
      expect(tokenLimit('bedrock/claude-opus-5-0')).toBe(1_000_000);
      expect(tokenLimit('vertex/claude-opus-5.1')).toBe(1_000_000);
    });

    it('returns 200K for other Claude models', () => {
      expect(tokenLimit('claude-sonnet-4-6')).toBe(200_000);
      expect(tokenLimit('claude-opus-4')).toBe(200_000);
      expect(tokenLimit('claude-3.5-sonnet')).toBe(200_000);
    });
  });

  describe('Anthropic Claude output limits', () => {
    it('returns the vendor-declared 128_000 (not 131_072) for extended Opus tiers', () => {
      // Guards the mirror against re-drifting to LIMITS['128k'].
      expect(tokenLimit('claude-opus-4-6', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-4-7', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-4-8', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-5', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-5-1', 'output')).toBe(128_000);
    });

    it('returns 128K output for dotted, dotted-revision, and space-separated Opus aliases', () => {
      expect(tokenLimit('claude-opus-4.6', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-4.8', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-5.0', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-4.8.0', 'output')).toBe(128_000);
      expect(tokenLimit('claude-opus-4-8.0', 'output')).toBe(128_000);
      expect(tokenLimit('Claude Opus 4.8', 'output')).toBe(128_000);
      expect(tokenLimit('claude opus 4.8', 'output')).toBe(128_000);
    });

    it('returns 128K output for vertex/bedrock-prefixed Opus aliases', () => {
      expect(tokenLimit('vertex/claude-opus-4.8', 'output')).toBe(128_000);
      expect(tokenLimit('bedrock/claude-opus-5-0', 'output')).toBe(128_000);
    });

    it('returns 64K output for other Claude models', () => {
      expect(tokenLimit('claude-sonnet-4-6', 'output')).toBe(65_536);
      expect(tokenLimit('claude-opus-4', 'output')).toBe(65_536);
    });
  });

  describe('fallbacks', () => {
    it('returns the default input limit for unknown models', () => {
      expect(tokenLimit('some-unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
    });

    it('returns the default output limit for unknown models', () => {
      expect(tokenLimit('some-unknown-model', 'output')).toBe(32_000);
    });
  });

  describe('DeepSeek limits', () => {
    it('returns 1M input and 384K output for DeepSeek V4 models', () => {
      expect(tokenLimit('deepseek-v4-flash')).toBe(1_000_000);
      expect(tokenLimit('deepseek-v4-pro')).toBe(1_000_000);
      expect(tokenLimit('deepseek-v4-flash', 'output')).toBe(384_000);
      expect(tokenLimit('deepseek-v4-pro', 'output')).toBe(384_000);
    });
  });

  describe('Zhipu GLM limits', () => {
    it('returns 1M input for GLM-5.2+ while preserving 200K for GLM-5.1 and earlier', () => {
      expect(tokenLimit('glm-5.2')).toBe(1_000_000);
      expect(tokenLimit('GLM-5.2')).toBe(1_000_000);
      expect(tokenLimit('zai/GLM-5.2')).toBe(1_000_000);
      expect(tokenLimit('glm-6')).toBe(1_000_000);
      expect(tokenLimit('glm-10')).toBe(1_000_000);
      expect(tokenLimit('glm-5.1')).toBe(202_752);
      expect(tokenLimit('glm-4.7')).toBe(202_752);
    });

    it('returns 128K output for GLM-5.x and 16K for GLM-4.7', () => {
      expect(tokenLimit('glm-5.2', 'output')).toBe(131_072);
      expect(tokenLimit('GLM-5.2', 'output')).toBe(131_072);
      expect(tokenLimit('glm-5.1', 'output')).toBe(131_072);
      expect(tokenLimit('glm-5', 'output')).toBe(131_072);
      expect(tokenLimit('glm-4.7', 'output')).toBe(16_384);
    });
  });

  describe('MiniMax limits', () => {
    it('returns 1M input for MiniMax-M3 while preserving existing MiniMax limits', () => {
      expect(tokenLimit('MiniMax-M3')).toBe(1_000_000);
      expect(tokenLimit('MiniMax-M2.5')).toBe(196_608);
      expect(tokenLimit('MiniMax-M2.1')).toBe(200_000);
    });
  });
});
