/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { estimateTokenCountSync } from './tokenCalculation.js';
import type { Part } from '@google/genai';

describe('tokenCalculation', () => {
  describe('estimateTokenCountSync', () => {
    it('should use fast heuristic for massive strings', () => {
      const massiveText = 'a'.repeat(200_000);
      // 200,000 / 4 = 50,000 tokens
      const parts: Part[] = [{ text: massiveText }];
      expect(estimateTokenCountSync(parts)).toBe(50000);
    });

    it('should estimate functionResponse without full stringification', () => {
      const toolResult = 'result'.repeat(1000); // 6000 chars
      const parts: Part[] = [
        {
          functionResponse: {
            name: 'my_tool',
            id: '123',
            response: { output: toolResult },
          },
        },
      ];

      const tokens = estimateTokenCountSync(parts);
      // payload ~6013 chars / 4 = 1503.25
      // name 7 / 4 = 1.75
      // total ~1505
      expect(tokens).toBeGreaterThan(1500);
      expect(tokens).toBeLessThan(1600);
    });

    it('should handle Gemini 3 multimodal nested parts in functionResponse', () => {
      const parts: Part[] = [
        {
          functionResponse: {
            name: 'multimodal_tool',
            id: '456',
            response: { status: 'success' },
            // Gemini 3 nested parts
            parts: [
              { inlineData: { mimeType: 'image/png', data: 'base64...' } },
              { text: 'Look at this image' },
            ] as Part[],
          },
        },
      ];

      const tokens = estimateTokenCountSync(parts);
      // image 3000 + text 4.5 + response 5 = ~3009.5
      expect(tokens).toBeGreaterThan(3000);
      expect(tokens).toBeLessThan(3100);
    });

    it('should respect the maximum recursion depth limit', () => {
      // Create a structure nested to depth 5 (exceeding limit of 3)
      const parts: Part[] = [
        {
          functionResponse: {
            name: 'd0',
            response: { val: 'a' }, // ~12 chars -> 3 tokens
            parts: [
              {
                functionResponse: {
                  name: 'd1',
                  response: { val: 'a' }, // ~12 chars -> 3 tokens
                  parts: [
                    {
                      functionResponse: {
                        name: 'd2',
                        response: { val: 'a' }, // ~12 chars -> 3 tokens
                        parts: [
                          {
                            functionResponse: {
                              name: 'd3',
                              response: { val: 'a' }, // ~12 chars -> 3 tokens
                              parts: [
                                {
                                  functionResponse: {
                                    name: 'd4',
                                    response: { val: 'a' },
                                  },
                                },
                              ] as Part[],
                            },
                          },
                        ] as Part[],
                      },
                    },
                  ] as Part[],
                },
              },
            ] as Part[],
          },
        },
      ];

      const tokens = estimateTokenCountSync(parts);
      // It should count d0, d1, d2, d3 (depth 0, 1, 2, 3) but NOT d4 (depth 4)
      // d0..d3: 4 * ~4 tokens = ~16
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(30);
    });

    it('should handle empty or nullish inputs gracefully', () => {
      expect(estimateTokenCountSync([])).toBe(0);
      expect(estimateTokenCountSync([{ text: '' }])).toBe(0);
      expect(estimateTokenCountSync([{} as Part])).toBe(0);
    });
  });
});
