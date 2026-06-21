/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  defaultModalities,
  detectDefaultModalities,
} from './modalityDefaults.js';

describe('defaultModalities', () => {
  describe('Google Gemini', () => {
    it('returns full multimodal for gemini-3-pro', () => {
      expect(defaultModalities('gemini-3-pro-preview')).toEqual({
        image: true,
        pdf: true,
        audio: true,
        video: true,
      });
    });

    it('returns full multimodal for gemini-3-flash', () => {
      expect(defaultModalities('gemini-3-flash-preview')).toEqual({
        image: true,
        pdf: true,
        audio: true,
        video: true,
      });
    });

    it('returns full multimodal for gemini-3.1-pro', () => {
      expect(defaultModalities('gemini-3.1-pro-preview')).toEqual({
        image: true,
        pdf: true,
        audio: true,
        video: true,
      });
    });

    it('returns full multimodal for gemini-2.5-pro', () => {
      expect(defaultModalities('gemini-2.5-pro')).toEqual({
        image: true,
        pdf: true,
        audio: true,
        video: true,
      });
    });

    it('returns full multimodal for gemini-1.5-flash', () => {
      expect(defaultModalities('gemini-1.5-flash')).toEqual({
        image: true,
        pdf: true,
        audio: true,
        video: true,
      });
    });
  });

  describe('OpenAI', () => {
    it('returns image for gpt-5.2', () => {
      const m = defaultModalities('gpt-5.2');
      expect(m.image).toBe(true);
      expect(m.audio).toBeUndefined();
      expect(m.pdf).toBeUndefined();
      expect(m.video).toBeUndefined();
    });

    it('returns image for gpt-5-mini', () => {
      expect(defaultModalities('gpt-5-mini').image).toBe(true);
    });

    it('returns image for gpt-4o', () => {
      expect(defaultModalities('gpt-4o').image).toBe(true);
    });

    it('returns image for o3', () => {
      expect(defaultModalities('o3').image).toBe(true);
    });
  });

  describe('Anthropic Claude', () => {
    it('returns image + pdf for claude-opus-4-6', () => {
      const m = defaultModalities('claude-opus-4-6');
      expect(m.image).toBe(true);
      expect(m.pdf).toBe(true);
      expect(m.audio).toBeUndefined();
      expect(m.video).toBeUndefined();
    });

    it('returns image + pdf for claude-sonnet-4-6', () => {
      const m = defaultModalities('claude-sonnet-4-6');
      expect(m.image).toBe(true);
      expect(m.pdf).toBe(true);
    });

    it('returns image + pdf for claude-sonnet-4', () => {
      const m = defaultModalities('claude-sonnet-4');
      expect(m.image).toBe(true);
      expect(m.pdf).toBe(true);
    });

    it('returns image + pdf for claude-3.5-sonnet', () => {
      const m = defaultModalities('claude-3.5-sonnet');
      expect(m.image).toBe(true);
      expect(m.pdf).toBe(true);
    });
  });

  describe('Qwen', () => {
    it('returns image + video for qwen-vl-max', () => {
      const m = defaultModalities('qwen-vl-max');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns image + video for qwen3-vl-plus', () => {
      const m = defaultModalities('qwen3-vl-plus');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
    });

    it('returns text-only for qwen3-coder-plus', () => {
      expect(defaultModalities('qwen3-coder-plus')).toEqual({});
    });

    it('returns image + video for coder-model (same as qwen3.5-plus)', () => {
      expect(defaultModalities('coder-model')).toEqual({
        image: true,
        video: true,
      });
    });

    it('returns image + video for qwen3.5-plus', () => {
      const m = defaultModalities('qwen3.5-plus');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns image + video for qwen3.7-plus', () => {
      const m = defaultModalities('qwen3.7-plus');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns text-only for qwen3.7-max', () => {
      expect(defaultModalities('qwen3.7-max')).toEqual({});
    });

    it('returns image + video for qwen3.6-35b variants', () => {
      const m = defaultModalities('qwen3.6-35b-a3b-nvfp4');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns text-only for qwen-turbo', () => {
      expect(defaultModalities('qwen-turbo')).toEqual({});
    });
  });

  describe('DeepSeek', () => {
    it('returns text-only for deepseek-chat', () => {
      expect(defaultModalities('deepseek-chat')).toEqual({});
    });

    it('returns text-only for deepseek-reasoner', () => {
      expect(defaultModalities('deepseek-reasoner')).toEqual({});
    });
  });

  describe('Zhipu GLM', () => {
    it('returns image for glm-4.5v', () => {
      const m = defaultModalities('glm-4.5v');
      expect(m.image).toBe(true);
      expect(m.pdf).toBeUndefined();
    });

    it('returns text-only for glm-5', () => {
      expect(defaultModalities('glm-5')).toEqual({});
    });

    it('returns text-only for glm-4.7', () => {
      expect(defaultModalities('glm-4.7')).toEqual({});
    });
  });

  describe('MiniMax', () => {
    it('returns image + video for MiniMax-M3', () => {
      const m = defaultModalities('MiniMax-M3');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns text-only for MiniMax-M2.5', () => {
      expect(defaultModalities('MiniMax-M2.5')).toEqual({});
    });
  });

  describe('Kimi', () => {
    it('returns image + video for kimi-k2.5', () => {
      const m = defaultModalities('kimi-k2.5');
      expect(m.image).toBe(true);
      expect(m.video).toBe(true);
      expect(m.pdf).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns text-only for kimi-k2', () => {
      expect(defaultModalities('kimi-k2')).toEqual({});
    });
  });

  describe('ByteDance Doubao', () => {
    it('returns image for doubao-seed-2.0-pro (issue #4876)', () => {
      const m = defaultModalities('doubao-seed-2.0-pro');
      expect(m.image).toBe(true);
      expect(m.video).toBeUndefined();
      expect(m.audio).toBeUndefined();
    });

    it('returns image for doubao-seed-1.6', () => {
      expect(defaultModalities('doubao-seed-1.6').image).toBe(true);
    });

    it('returns image for doubao-1.5-vision-pro', () => {
      expect(defaultModalities('doubao-1.5-vision-pro').image).toBe(true);
    });

    it('returns image for doubao-vision', () => {
      expect(defaultModalities('doubao-vision').image).toBe(true);
    });

    it('returns text-only for doubao-seedance (text→video generation model)', () => {
      expect(defaultModalities('doubao-seedance-1.0-pro')).toEqual({});
    });

    it('returns text-only for doubao-seedream (text→image generation model)', () => {
      expect(defaultModalities('doubao-seedream-3.0')).toEqual({});
    });

    it('returns text-only for doubao-pro-32k', () => {
      expect(defaultModalities('doubao-pro-32k')).toEqual({});
    });

    it('returns text-only for doubao-lite-4k', () => {
      expect(defaultModalities('doubao-lite-4k')).toEqual({});
    });
  });

  describe('unknown models', () => {
    it('returns text-only for unrecognized models', () => {
      expect(defaultModalities('some-random-model-xyz')).toEqual({});
    });

    it('returns undefined from known-only detection for unrecognized models', () => {
      expect(detectDefaultModalities('some-random-model-xyz')).toBeUndefined();
    });

    it('returns known text-only modalities from known-only detection', () => {
      expect(detectDefaultModalities('qwen3.7-max')).toEqual({});
    });
  });

  describe('normalization', () => {
    it('normalizes provider prefixes', () => {
      expect(defaultModalities('openai/gpt-4o')).toEqual(
        defaultModalities('gpt-4o'),
      );
    });

    it('returns a fresh copy each time', () => {
      const a = defaultModalities('gemini-2.5-pro');
      const b = defaultModalities('gemini-2.5-pro');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });
});
