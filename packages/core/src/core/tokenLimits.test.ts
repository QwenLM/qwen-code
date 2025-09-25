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

  it('should remove version numbers with dots when they are at the end', () => {
    expect(normalize('gpt-4.1.1-latest')).toBe('gpt-4.1.1');
    expect(normalize('gpt-4.1-latest')).toBe('gpt-4.1');
  });
});

describe('tokenLimit', () => {
  // Test cases for each model family
  describe('Google Gemini', () => {
    it('should return the correct limit for Gemini 1.5 Pro', () => {
      expect(tokenLimit('gemini-1.5-pro')).toBe(2097152);
    });
    it('should return the correct limit for Gemini 1.5 Flash', () => {
      expect(tokenLimit('gemini-1.5-flash')).toBe(1048576);
    });
    it('should return the correct limit for Gemini 2.5 Pro', () => {
      expect(tokenLimit('gemini-2.5-pro')).toBe(1048576);
    });
    it('should return the correct limit for Gemini 2.5 Flash', () => {
      expect(tokenLimit('gemini-2.5-flash')).toBe(1048576);
    });
    it('should return the correct limit for Gemini 2.0 Flash with image generation', () => {
      expect(tokenLimit('gemini-2.0-flash-image-generation')).toBe(32768);
    });
    it('should return the correct limit for Gemini 2.0 Flash', () => {
      expect(tokenLimit('gemini-2.0-flash')).toBe(1048576);
    });
  });

  describe('OpenAI', () => {
    it('should return the correct limit for o3-mini', () => {
      expect(tokenLimit('o3-mini')).toBe(200000);
    });
    it('should return the correct limit for o3 models', () => {
      expect(tokenLimit('o3')).toBe(200000);
    });
    it('should return the correct limit for o4-mini', () => {
      expect(tokenLimit('o4-mini')).toBe(200000);
    });
    it('should return the correct limit for gpt-4o-mini', () => {
      expect(tokenLimit('gpt-4o-mini')).toBe(131072);
    });
    it('should return the correct limit for gpt-4o', () => {
      expect(tokenLimit('gpt-4o')).toBe(131072);
    });
    it('should return the correct limit for gpt-4.1-mini', () => {
      expect(tokenLimit('gpt-4.1-mini')).toBe(1048576);
    });
    it('should return the correct limit for gpt-4.1 models', () => {
      expect(tokenLimit('gpt-4.1')).toBe(1048576);
    });
    it('should return the correct limit for gpt-4', () => {
      expect(tokenLimit('gpt-4')).toBe(131072);
    });
  });

  describe('Anthropic Claude', () => {
    it('should return the correct limit for Claude 3.5 Sonnet', () => {
      expect(tokenLimit('claude-3.5-sonnet')).toBe(200000);
    });
    it('should return the correct limit for Claude 3.7 Sonnet', () => {
      expect(tokenLimit('claude-3.7-sonnet')).toBe(1048576);
    });
    it('should return the correct limit for Claude Sonnet 4', () => {
      expect(tokenLimit('claude-sonnet-4')).toBe(1048576);
    });
    it('should return the correct limit for Claude Opus 4', () => {
      expect(tokenLimit('claude-opus-4')).toBe(1048576);
    });
  });

  describe('Alibaba Qwen', () => {
    it('should return the correct limit for qwen3-coder commercial models', () => {
      expect(tokenLimit('qwen3-coder-plus')).toBe(1048576);
      expect(tokenLimit('qwen3-coder-plus-20250601')).toBe(1048576);
      expect(tokenLimit('qwen3-coder-flash')).toBe(1048576);
      expect(tokenLimit('qwen3-coder-flash-20250601')).toBe(1048576);
    });

    it('should return the correct limit for qwen3-coder open source models', () => {
      expect(tokenLimit('qwen3-coder-7b')).toBe(262144);
      expect(tokenLimit('qwen3-coder-480b-a35b-instruct')).toBe(262144);
      expect(tokenLimit('qwen3-coder-30b-a3b-instruct')).toBe(262144);
    });

    it('should return the correct limit for qwen3 2507 variants', () => {
      expect(tokenLimit('qwen3-some-model-2507-instruct')).toBe(262144);
    });

    it('should return the correct limit for qwen2.5-1m', () => {
      expect(tokenLimit('qwen2.5-1m')).toBe(1048576);
      expect(tokenLimit('qwen2.5-1m-instruct')).toBe(1048576);
    });

    it('should return the correct limit for qwen2.5', () => {
      expect(tokenLimit('qwen2.5')).toBe(131072);
      expect(tokenLimit('qwen2.5-instruct')).toBe(131072);
    });

    it('should return the correct limit for qwen-plus', () => {
      expect(tokenLimit('qwen-plus-latest')).toBe(1048576);
      expect(tokenLimit('qwen-plus')).toBe(131072);
    });

    it('should return the correct limit for qwen-flash', () => {
      expect(tokenLimit('qwen-flash-latest')).toBe(1048576);
    });

    it('should return the correct limit for qwen-turbo', () => {
      expect(tokenLimit('qwen-turbo')).toBe(131072);
      expect(tokenLimit('qwen-turbo-latest')).toBe(131072);
    });
  });

  describe('ByteDance Seed-OSS', () => {
    it('should return the correct limit for seed-oss', () => {
      expect(tokenLimit('seed-oss')).toBe(524288);
    });
  });

  describe('Zhipu GLM', () => {
    it('should return the correct limit for glm-4.5v', () => {
      expect(tokenLimit('glm-4.5v')).toBe(65536);
    });
    it('should return the correct limit for glm-4.5-air', () => {
      expect(tokenLimit('glm-4.5-air')).toBe(131072);
    });
    it('should return the correct limit for glm-4.5', () => {
      expect(tokenLimit('glm-4.5')).toBe(131072);
    });
  });

  describe('Other models', () => {
    it('should return the correct limit for deepseek-r1', () => {
      expect(tokenLimit('deepseek-r1')).toBe(131072);
    });
    it('should return the correct limit for deepseek-v3', () => {
      expect(tokenLimit('deepseek-v3')).toBe(131072);
    });
    it('should return the correct limit for deepseek-v3.1', () => {
      expect(tokenLimit('deepseek-v3.1')).toBe(131072);
    });
    it('should return the correct limit for kimi-k2-instruct', () => {
      expect(tokenLimit('kimi-k2-instruct')).toBe(131072);
    });
    it('should return the correct limit for gpt-oss', () => {
      expect(tokenLimit('gpt-oss')).toBe(131072);
    });
    it('should return the correct limit for llama-4-scout', () => {
      expect(tokenLimit('llama-4-scout')).toBe(10485760);
    });
    it('should return the correct limit for mistral-large-2', () => {
      expect(tokenLimit('mistral-large-2')).toBe(131072);
    });
  });

  // Test for default limit
  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit('unknown-model-v1.0')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  // Test with complex model string
  it('should return the correct limit for a complex model string', () => {
    expect(tokenLimit('  a/b/c|GPT-4o:gpt-4o-2024-05-13-q4  ')).toBe(131072);
  });

  // Test case-insensitive matching
  it('should handle case-insensitive model names', () => {
    expect(tokenLimit('GPT-4O')).toBe(131072);
    expect(tokenLimit('CLAUDE-3.5-SONNET')).toBe(200000);
  });
});

describe('tokenLimit with output type', () => {
  describe('Qwen models with output limits', () => {
    it('should return the correct output limit for qwen3-coder-plus', () => {
      expect(tokenLimit('qwen3-coder-plus', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-coder-plus-20250601', 'output')).toBe(65536);
    });

    it('should return the correct output limit for qwen-vl-max-latest', () => {
      expect(tokenLimit('qwen-vl-max-latest', 'output')).toBe(8192);
    });
  });

  describe('Default output limits', () => {
    it('should return the default output limit for unknown models', () => {
      expect(tokenLimit('unknown-model', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
      expect(tokenLimit('gpt-4', 'output')).toBe(DEFAULT_OUTPUT_TOKEN_LIMIT);
      expect(tokenLimit('claude-3.5-sonnet', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
    });

    it('should return the default output limit for models without specific output patterns', () => {
      expect(tokenLimit('qwen3-coder-7b', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
      expect(tokenLimit('qwen-plus', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
      expect(tokenLimit('qwen-vl-max', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      );
    });
  });

  describe('Input vs Output limits comparison', () => {
    it('should return different limits for input vs output for qwen3-coder-plus', () => {
      expect(tokenLimit('qwen3-coder-plus', 'input')).toBe(1048576); // 1M input
      expect(tokenLimit('qwen3-coder-plus', 'output')).toBe(65536); // 64K output
    });

    it('should return different limits for input vs output for qwen-vl-max-latest', () => {
      expect(tokenLimit('qwen-vl-max-latest', 'input')).toBe(131072); // 128K input
      expect(tokenLimit('qwen-vl-max-latest', 'output')).toBe(8192); // 8K output
    });

    it('should return different limits for input vs output for qwen3-vl-plus', () => {
      expect(tokenLimit('qwen3-vl-plus', 'input')).toBe(262144); // 256K input
      expect(tokenLimit('qwen3-vl-plus', 'output')).toBe(32768); // 32K output
    });

    it('should return same default limits for unknown models', () => {
      expect(tokenLimit('unknown-model', 'input')).toBe(DEFAULT_TOKEN_LIMIT); // 128K input
      expect(tokenLimit('unknown-model', 'output')).toBe(
        DEFAULT_OUTPUT_TOKEN_LIMIT,
      ); // 4K output
    });
  });

  describe('Backward compatibility', () => {
    it('should default to input type when no type is specified', () => {
      expect(tokenLimit('qwen3-coder-plus')).toBe(1048576); // Should be input limit
      expect(tokenLimit('qwen-vl-max-latest')).toBe(131072); // Should be input limit
      expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT); // Should be input default
    });

    it('should work with explicit input type', () => {
      expect(tokenLimit('qwen3-coder-plus', 'input')).toBe(1048576);
      expect(tokenLimit('qwen-vl-max-latest', 'input')).toBe(131072);
      expect(tokenLimit('unknown-model', 'input')).toBe(DEFAULT_TOKEN_LIMIT);
    });
  });

  describe('Model normalization with output limits', () => {
    it('should handle normalized model names for output limits', () => {
      expect(tokenLimit('QWEN3-CODER-PLUS', 'output')).toBe(65536);
      expect(tokenLimit('qwen3-coder-plus-20250601', 'output')).toBe(65536);
      expect(tokenLimit('QWEN-VL-MAX-LATEST', 'output')).toBe(8192);
    });

    it('should handle complex model strings for output limits', () => {
      expect(
        tokenLimit(
          '  a/b/c|QWEN3-CODER-PLUS:qwen3-coder-plus-2024-05-13  ',
          'output',
        ),
      ).toBe(65536);
      expect(
        tokenLimit(
          'provider/qwen-vl-max-latest:qwen-vl-max-latest-v1',
          'output',
        ),
      ).toBe(8192);
    });
  });
});
