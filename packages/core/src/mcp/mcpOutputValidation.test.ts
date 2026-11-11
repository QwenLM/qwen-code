/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateAndTruncateMcpTextOutput,
  getMaxMcpOutputTokens,
} from './mcpOutputValidation.js';
import type { Part } from '@google/genai';
import * as fs from 'node:fs';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { ENV_MAX_MCP_OUTPUT_TOKENS } from '../config/brand.js';

// Mock fs to avoid actual file writes in tests
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

describe('mcpOutputValidation', () => {
  /** Content handed to the most recent spill write. */
  function lastPersistedContent(): string {
    expect(fs.writeFileSync).toHaveBeenCalled();
    const calls = vi.mocked(fs.writeFileSync).mock.calls;
    return String(calls[calls.length - 1][1]);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getMaxMcpOutputTokens', () => {
    it('should return default value when env var is not set', () => {
      expect(getMaxMcpOutputTokens()).toBe(25000);
    });

    it('should return env var value when set', () => {
      vi.stubEnv(ENV_MAX_MCP_OUTPUT_TOKENS, '10000');
      expect(getMaxMcpOutputTokens()).toBe(10000);
    });

    it('should return default for invalid env var', () => {
      vi.stubEnv(ENV_MAX_MCP_OUTPUT_TOKENS, 'invalid');
      expect(getMaxMcpOutputTokens()).toBe(25000);
    });

    it('should return default for zero env var', () => {
      vi.stubEnv(ENV_MAX_MCP_OUTPUT_TOKENS, '0');
      expect(getMaxMcpOutputTokens()).toBe(25000);
    });

    it('should return default for negative env var', () => {
      vi.stubEnv(ENV_MAX_MCP_OUTPUT_TOKENS, '-100');
      expect(getMaxMcpOutputTokens()).toBe(25000);
    });
  });

  describe('validateAndTruncateMcpTextOutput', () => {
    it('should return empty array as-is', () => {
      const result = validateAndTruncateMcpTextOutput([], 'server', 'tool');
      expect(result).toEqual([]);
    });

    it('should return small text output unchanged', () => {
      const parts: Part[] = [{ text: 'Hello world' }];
      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');
      expect(result).toEqual(parts);
    });

    it('should return multiple small parts unchanged', () => {
      const parts: Part[] = [
        { text: 'Part 1' },
        { text: 'Part 2' },
        { text: 'Part 3' },
      ];
      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');
      expect(result).toEqual(parts);
    });

    it('should truncate text exceeding token budget', () => {
      // 25000 tokens * 3 chars/token = 75000 chars threshold
      // Create content that clearly exceeds this
      const longText = 'x'.repeat(100_000);
      const parts: Part[] = [{ text: longText }];

      const result = validateAndTruncateMcpTextOutput(
        parts,
        'my-server',
        'my-tool',
      );

      // Should return a single Part with truncation instructions
      expect(result).toHaveLength(1);
      expect(result[0].text).toContain('OUTPUT TRUNCATED');
      expect(result[0].text).toContain('my-server');
      expect(result[0].text).toContain('my-tool');
      expect(result[0].text).toContain(READ_FILE_TOOL_NAME);
      expect(result[0].text).toContain('Preview');
    });

    it('should persist full output to disk when truncating', () => {
      const longText = 'x'.repeat(100_000);
      const parts: Part[] = [{ text: longText }];

      validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      // writeFileSync is called by persistFullOutput
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('server_tool'),
        longText,
        'utf-8',
      );
    });

    it('should reflow a single-line JSON payload so line reads can slice it', () => {
      const rows = Array.from({ length: 4000 }, (_, i) => ({
        id: i,
        label: `row-${i}`,
      }));
      const singleLine = JSON.stringify({ rows });
      expect(singleLine).not.toContain('\n');

      validateAndTruncateMcpTextOutput([{ text: singleLine }], 'server', 'tool');

      const written = lastPersistedContent();
      expect(written.split('\n').length).toBeGreaterThan(100);
      expect(written).toContain('"rows": [');
      expect(JSON.parse(written)).toEqual({ rows });
    });

    it('should reflow each text part so multi-part JSON stays readable', () => {
      const part = (tag: string) =>
        JSON.stringify({
          tag,
          rows: Array.from({ length: 5000 }, (_, i) => ({ id: i })),
        });

      validateAndTruncateMcpTextOutput(
        [{ text: part('first') }, { text: part('second') }],
        'server',
        'tool',
      );

      const written = lastPersistedContent();
      expect(written).toContain('"tag": "first"');
      expect(written).toContain('"tag": "second"');
      expect(written.split('\n').length).toBeGreaterThan(100);
    });

    it('should persist malformed JSON-looking output unchanged', () => {
      const malformed = `{"rows":[${'1,'.repeat(60_000)}`;

      validateAndTruncateMcpTextOutput([{ text: malformed }], 'server', 'tool');

      expect(lastPersistedContent()).toBe(malformed);
    });

    it('should include file path in truncated output', () => {
      const longText = 'x'.repeat(100_000);
      const parts: Part[] = [{ text: longText }];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      // The file path should be in the output
      expect(result[0].text).toContain('Full output has been saved to:');
      expect(result[0].text).toContain('server_tool');
    });

    it('should include preview of first 2000 bytes', () => {
      const longText = 'A'.repeat(5000) + 'B'.repeat(95_000);
      const parts: Part[] = [{ text: longText }];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      // Preview should contain the start of the content
      expect(result[0].text).toContain('A'.repeat(2000));
      // But not the entire content
      expect(result[0].text).not.toContain('B'.repeat(1000));
    });

    it('should concatenate multiple text parts for truncation', () => {
      // Each part has 40000 chars => ~13333 tokens each => ~40000 total > 25000
      const parts: Part[] = [
        { text: 'A'.repeat(40_000) },
        { text: 'B'.repeat(40_000) },
        { text: 'C'.repeat(40_000) },
      ];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      expect(result).toHaveLength(1);
      expect(result[0].text).toContain('OUTPUT TRUNCATED');

      // Persisted content should include all parts joined
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const persistedContent = writeCall[1] as string;
      expect(persistedContent).toContain('A'.repeat(40_000));
      expect(persistedContent).toContain('B'.repeat(40_000));
      expect(persistedContent).toContain('C'.repeat(40_000));
    });

    it('should preserve image positions when truncating interleaved content', () => {
      const firstImage: Part = {
        inlineData: { data: 'first-image', mimeType: 'image/png' },
      };
      const secondImage: Part = {
        inlineData: { data: 'second-image', mimeType: 'image/jpeg' },
      };
      const parts: Part[] = [
        { text: 'before-first-image' },
        firstImage,
        { text: 'between-images' },
        secondImage,
        { text: 'x'.repeat(100_000) },
      ];

      const result = validateAndTruncateMcpTextOutput(
        parts,
        'server',
        'tool',
      );

      expect(result[0]).toEqual({ text: 'before-first-image' });
      expect(result[1]).toBe(firstImage);
      expect(result[2]).toEqual({ text: 'between-images' });
      expect(result[3]).toBe(secondImage);
      expect(result[4].text).toMatch(/^x+$/);
      expect(result.at(-1)?.text).toContain('OUTPUT TRUNCATED');
      expect(result.at(-1)?.text).toContain('image positions are preserved');
    });

    it('should ignore inlineData when estimating text output tokens', () => {
      const largeBase64 = 'A'.repeat(300_000); // ~225k raw bytes, many tokens
      const parts: Part[] = [
        {
          inlineData: {
            data: largeBase64,
            mimeType: 'image/png',
          },
        },
        { text: 'Small text' },
      ];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      expect(result).toEqual(parts);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should use fast path for very small output', () => {
      // Content well below 50% of threshold should skip estimation entirely
      const parts: Part[] = [{ text: 'tiny' }];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      expect(result).toEqual(parts);
      // No file operations should occur
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should respect custom token limit from env var', () => {
      // Set a very low limit so even short content triggers truncation
      vi.stubEnv(ENV_MAX_MCP_OUTPUT_TOKENS, '10');

      // 10 tokens * 3 chars/token = 30 chars, content of 100 chars will exceed
      const parts: Part[] = [{ text: 'x'.repeat(100) }];

      const result = validateAndTruncateMcpTextOutput(parts, 'server', 'tool');

      expect(result).toHaveLength(1);
      expect(result[0].text).toContain('OUTPUT TRUNCATED');
    });

    it('should sanitize server and tool names in filename', () => {
      const longText = 'x'.repeat(100_000);
      const parts: Part[] = [{ text: longText }];

      validateAndTruncateMcpTextOutput(
        parts,
        'server/with:special',
        'tool@name!',
      );

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const filePath = writeCall[0] as string;
      // Special characters should be replaced with underscores
      expect(filePath).not.toContain('/with:special');
      expect(filePath).not.toContain('@');
      expect(filePath).not.toContain('!');
    });
  });
});
