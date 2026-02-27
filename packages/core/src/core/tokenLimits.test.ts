import { describe, it, expect } from 'vitest';
import {
  normalize,
  tokenLimit,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_OUTPUT_TOKEN_LIMIT,
} from './tokenLimits.js';

describe('normalize', () => {
  it('should lowercase and trim the model string', () => {
    expect(normalize('  GEMINI-1.5-PRO  ')).toBe('gemini-1.5-pro');
  });

  it('should strip provider prefixes', () => {
    expect(normalize('google/gemini-1.5-pro')).toBe('gemini-1.5-pro');
    expect(normalize('anthropic/claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
  });

  it('should handle pipe and colon separators', () => {
    expect(normalize('qwen|qwen2.5:qwen2.5-1m')).toBe('qwen2.5-1m');
  });

  it('should collapse whitespace to a single hyphen', () => {
    expect(normalize('claude 3.5 sonnet')).toBe('claude-3.5-sonnet');
  });

  it('should remove date and version suffixes', () => {
    expect(normalize('gemini-1.5-pro-20250219')).toBe('gemini-1.5-pro');
    expect(normalize('gpt-4o-mini-v1')).toBe('gpt-4o-mini');
    expect(normalize('claude-3.7-sonnet-20240715')).toBe('claude-3.7-sonnet');
    expect(normalize('gpt-4.1-latest')).toBe('gpt-4.1');
    expect(normalize('gemini-2.0-flash-preview-20250520')).toBe(
      'gemini-2.0-flash',
    );
  });

  it('should remove quantization and numeric suffixes', () => {
    expect(normalize('qwen3-coder-7b-4bit')).toBe('qwen3-coder-7b');
    expect(normalize('llama-4-scout-int8')).toBe('llama-4-scout');
    expect(normalize('mistral-large-2-bf16')).toBe('mistral-large-2');
    expect(normalize('deepseek-v3.1-q4')).toBe('deepseek-v3.1');
    expect(normalize('qwen2.5-quantized')).toBe('qwen2.5');
  });

  it('should handle a combination of normalization rules', () => {
    expect(normalize('  Google/GEMINI-2.5-PRO:gemini-2.5-pro-20250605  ')).toBe(
      'gemini-2.5-pro',
    );
  });

  it('should handle empty or null input', () => {
    expect(normalize('')).toBe('');
    expect(normalize(undefined as unknown as string)).toBe('');
    expect(normalize(null as unknown as string)).toBe('');
  });

  it('should remove preview suffixes', () => {
    expect(normalize('gemini-2.0-flash-preview')).toBe('gemini-2.0-flash');
  });

  it('should not remove "-latest" from specific Qwen model names', () => {
    expect(normalize('qwen-plus-latest')).toBe('qwen-plus-latest');
    expect(normalize('qwen-flash-latest')).toBe('qwen-flash-latest');
    expect(normalize('qwen-vl-max-latest')).toBe('qwen-vl-max-latest');
  });

  it('should preserve date suffixes for Kimi K2 models', () => {
    expect(normalize('kimi-k2-0905-preview')).toBe('kimi-k2-0905');
    expect(normalize('kimi-k2-0711-preview')).toBe('kimi-k2-0711');
    expect(normalize('kimi-k2-turbo-preview')).toBe('kimi-k2-turbo');
  });

  it('should remove date like suffixes', () => {
    expect(normalize('deepseek-r1-0528')).toBe('deepseek-r1');
  });

  it('should remove literal "-latest" "-exp" suffixes', () => {
    expect(normalize('gpt-4.1-latest')).toBe('gpt-4.1');
    expect(normalize('deepseek-v3.2-exp')).toBe('deepseek-v3.2');
  });

  it('should remove suffix version numbers with "v" prefix', () => {
    expect(normalize('model-test-v1.1')).toBe('model-test');
    expect(normalize('model-v1.1')).toBe('model');
  });

  it('should remove suffix version numbers w/o "v" prefix only if they are preceded by another dash', () => {
    expect(normalize('model-test-1.1')).toBe('model-test');
    expect(normalize('gpt-4.1')).toBe('gpt-4.1');
  });
});

describe('tokenLimit', () => {
  describe('Google Gemini', () => {
    it('should return 1M for Gemini 3.x (latest)', () => {
      expect(tokenLimit('gemini-3-pro-preview')).toBe(1000000);
      expect(tokenLimit('gemini-3-flash-preview')).toBe(1000000);
      expect(tokenLimit('gemini-3.1-pro-preview')).toBe(1000000);
    });

    it('should return 1M for legacy Gemini (fallback)', () => {
      expect(tokenLimit('gemini-2.5-pro')).toBe(1000000);
      expect(tokenLimit('gemini-2.5-flash')).toBe(1000000);
      expect(tokenLimit('gemini-2.0-flash')).toBe(1000000);
      expect(tokenLimit('gemini-1.5-pro')).toBe(1000000);
      expect(tokenLimit('gemini-1.5-flash')).toBe(1000000);
    });
  });

  describe('OpenAI', () => {
    it('should return 400K for GPT-5.x (latest)', () => {
      expect(tokenLimit('gpt-5')).toBe(400000);
      expect(tokenLimit('gpt-5-mini')).toBe(400000);
      expect(tokenLimit('gpt-5.2')).toBe(400000);
      expect(tokenLimit('gpt-5.2-pro')).toBe(400000);
    });

    it('should return 128K for legacy GPT (fallback)', () => {
      expect(tokenLimit('gpt-4o')).toBe(131072);
      expect(tokenLimit('gpt-4o-mini')).toBe(131072);
      expect(tokenLimit('gpt-4.1')).toBe(131072);
      expect(tokenLimit('gpt-4')).toBe(131072);
    });

    it('should return 200K for o-series', () => {
      expect(tokenLimit('o3')).toBe(200000);
      expect(tokenLimit('o3-mini')).toBe(200000);
      expect(tokenLimit('o4-mini')).toBe(200000);
    });
  });

  describe('Anthropic Claude', () => {
    it('should return 200K for all Claude models', () => {
      expect(tokenLimit('claude-opus-4-6')).toBe(200000);
      expect(tokenLimit('claude-sonnet-4-6')).toBe(200000);
      expect(tokenLimit('claude-sonnet-4')).toBe(200000);
      expect(tokenLimit('claude-opus-4')).toBe(200000);
      expect(tokenLimit('claude-3.5-sonnet')).toBe(200000);
      expect(tokenLimit('claude-3.7-sonnet')).toBe(200000);
    });
  });

  describe('Alibaba Qwen', () => {
    it('should return 1M for commercial Qwen3 models', () => {
      expect(tokenLimit('qwen3-coder-plus')).toBe(1000000);
      expect(tokenLimit('qwen3-coder-plus-20250601')).toBe(1000000);
      expect(tokenLimit('qwen3-coder-flash')).toBe(1000000);
      expect(tokenLimit('qwen3.5-plus')).toBe(1000000);
      expect(tokenLimit('coder-model')).toBe(1000000);
    });

    it('should return 256K for Qwen3 non-commercial models', () => {
      expect(tokenLimit('qwen3-max')).toBe(262144);
      expect(tokenLimit('qwen3-max-2026-01-23')).toBe(262144);
      expect(tokenLimit('qwen3-vl-plus')).toBe(262144);
      expect(tokenLimit('qwen3-coder-7b')).toBe(262144);
      expect(tokenLimit('qwen3-coder-next')).toBe(262144);
    });

    it('should return 1M for studio latest models', () => {
      expect(tokenLimit('qwen-plus-latest')).toBe(1000000);
      expect(tokenLimit('qwen-flash-latest')).toBe(1000000);
    });

    it('should return 256K for Qwen fallback', () => {
      expect(tokenLimit('qwen-plus')).toBe(262144);
      expect(tokenLimit('qwen-turbo')).toBe(262144);
      expect(tokenLimit('qwen2.5')).toBe(262144);
      expect(tokenLimit('qwen-vl-max-latest')).toBe(262144);
      expect(tokenLimit('vision-model')).toBe(262144);
    });
  });

  describe('DeepSeek', () => {
    it('should return 128K for DeepSeek models', () => {
      expect(tokenLimit('deepseek-r1')).toBe(131072);
      expect(tokenLimit('deepseek-v3')).toBe(131072);
      expect(tokenLimit('deepseek-chat')).toBe(131072);
    });
  });

  describe('Zhipu GLM', () => {
    it('should return 200K for GLM-5 and GLM-4.7 (latest)', () => {
      expect(tokenLimit('glm-5')).toBe(202752);
      expect(tokenLimit('glm-4.7')).toBe(202752);
    });

    it('should return 200K for legacy GLM (fallback)', () => {
      expect(tokenLimit('glm-4.5')).toBe(202752);
      expect(tokenLimit('glm-4.5v')).toBe(202752);
      expect(tokenLimit('glm-4.5-air')).toBe(202752);
    });
  });

  describe('MiniMax', () => {
    it('should return 1M for MiniMax-M2.5 (latest)', () => {
      expect(tokenLimit('MiniMax-M2.5')).toBe(1000000);
    });

    it('should return 200K for MiniMax fallback', () => {
      expect(tokenLimit('MiniMax-M2.1')).toBe(200000);
    });
  });

  describe('Moonshot Kimi', () => {
    it('should return 256K for Kimi models', () => {
      expect(tokenLimit('kimi-k2.5')).toBe(262144);
      expect(tokenLimit('kimi-k2-0905')).toBe(262144);
      expect(tokenLimit('kimi-k2-turbo')).toBe(262144);
    });
  });

  describe('Other models', () => {
    it('should return correct limits for other known models', () => {
      expect(tokenLimit('seed-oss')).toBe(524288);
    });

    it('should return the default token limit for unknown models', () => {
      expect(tokenLimit('llama-4-scout')).toBe(DEFAULT_TOKEN_LIMIT);
    });
  });

  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit('unknown-model-v1.0')).toBe(DEFAULT_TOKEN_LIMIT);
    expect(tokenLimit('mistral-large-2')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return the correct limit for a complex model string', () => {
    expect(tokenLimit('  a/b/c|GPT-4o:gpt-4o-2024-05-13-q4  ')).toBe(131072);
  });

  it('should handle case-insensitive model names', () => {
    expect(tokenLimit('GPT-4O')).toBe(131072);
    expect(tokenLimit('CLAUDE-3.5-SONNET')).toBe(200000);
  });
});

describe('tokenLimit with output type', () => {
  describe('latest models output limits', () => {
    it('should return correct output limits for GPT-5.x', () => {
      expect(tokenLimit('gpt-5.2', 'output')).toBe(131072);
      expect(tokenLimit('gpt-5-mini', 'output')).toBe(131072);
    });

    it('should return correct output limits for Gemini 3.x', () => {
      expect(tokenLimit('gemini-3-pro-preview', 'output')).toBe(65536);
      expect(tokenLimit('gemini-3-flash-preview', 'output')).toBe(65536);
    });

    it('should return correct output limits for Claude 4.6', () => {
      expect(tokenLimit('claude-opus-4-6', 'output')).toBe(131072);
      expect(tokenLimit('claude-sonnet-4-6', 'output')).toBe(65536);
    });
  });

  describe('legacy model output fallbacks', () => {
    it('should return fallback output limits for legacy GPT', () => {
      expect(tokenLimit('gpt-4o', 'output')).toBe(16384);
    });

    it('should return fallback output limits for legacy Gemini', () => {
      expect(tokenLimit('gemini-2.5-pro', 'output')).toBe(8192);
    });

    it('should return fallback output limits for legacy Claude', () => {
      expect(tokenLimit('claude-sonnet-4', 'output')).toBe(65536);
      expect(tokenLimit('claude-opus-4', 'output')).toBe(65536);
    });
  });

  describe('Qwen output limits', () => {
    it('should return correct output limits for Qwen models', () => {
      expect(tokenLimit('qwen3-coder-plus', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-coder-next', 'output')).toBe(65536);
      expect(tokenLimit('qwen3.5-plus', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-max', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-max-2026-01-23', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-vl-plus', 'output')).toBe(32768);
      expect(tokenLimit('qwen-vl-max-latest', 'output')).toBe(8192);
      expect(tokenLimit('vision-model', 'output')).toBe(32768);
    });
  });

  describe('other output limits', () => {
    it('should return correct output limits for DeepSeek', () => {
      expect(tokenLimit('deepseek-reasoner', 'output')).toBe(65536);
      expect(tokenLimit('deepseek-chat', 'output')).toBe(8192);
    });

    it('should return correct output limits for GLM', () => {
      expect(tokenLimit('glm-5', 'output')).toBe(16384);
      expect(tokenLimit('glm-4.7', 'output')).toBe(16384);
    });

    it('should return correct output limits for MiniMax', () => {
      expect(tokenLimit('MiniMax-M2.5', 'output')).toBe(65536);
    });

    it('should return correct output limits for Kimi', () => {
      expect(tokenLimit('kimi-k2.5', 'output')).toBe(32768);
    });
  });

  describe('default output limits', () => {
    it('should return the default output limit for unknown models', () => {
      expect(tokenLimit('unknown-model', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
    });
  });

  describe('input vs output comparison', () => {
    it('should return different limits for input vs output', () => {
      expect(tokenLimit('qwen3-coder-plus', 'input')).toBe(1000000);
      expect(tokenLimit('qwen3-coder-plus', 'output')).toBe(65536);
    });

    it('should default to input type when no type is specified', () => {
      expect(tokenLimit('qwen3-coder-plus')).toBe(1000000);
      expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
    });
  });

  describe('normalization with output limits', () => {
    it('should handle normalized model names for output limits', () => {
      expect(tokenLimit('QWEN3-CODER-PLUS', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-coder-plus-20250601', 'output')).toBe(65536);
      expect(tokenLimit('QWEN-VL-MAX-LATEST', 'output')).toBe(8192);
    });
  });
});
