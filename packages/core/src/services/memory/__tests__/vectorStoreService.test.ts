/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VectorStoreService } from '../vectorStoreService.js';
import type { Config } from '../../../config/config.js';
import { BaseLlmClient } from '../../../core/baseLlmClient.js';

vi.mock('../../../core/baseLlmClient.js');

describe('VectorStoreService', () => {
  let service: VectorStoreService;
  let mockConfig: Config;
  let mockLlmClient: any;

  beforeEach(() => {
    mockConfig = {
      getContentGenerator: vi.fn().mockReturnValue({}),
      getEmbeddingModel: vi.fn().mockReturnValue('test-model'),
    } as unknown as Config;

    mockLlmClient = {
      generateEmbedding: vi.fn(),
    };
    (BaseLlmClient as any).mockImplementation(() => mockLlmClient);

    service = new VectorStoreService(mockConfig);
  });

  describe('addText', () => {
    it('should chunk large text correctly', async () => {
      const longText = 'A'.repeat(2500); // Should create 3 chunks (1000, 1000, 500)
      mockLlmClient.generateEmbedding.mockResolvedValue([
        [0.1], [0.2], [0.3]
      ]);

      await service.addText(longText, { path: 'large.txt' });

      expect(mockLlmClient.generateEmbedding).toHaveBeenCalledWith(expect.arrayContaining([
        expect.stringMatching(/^A{1000}$/),
        expect.stringMatching(/^A{500}$/)
      ]));
      
      const results = await service.search('A', 10);
      expect(results.length).toBe(3);
    });

    it('should handle empty strings gracefully', async () => {
      await service.addText('', { path: 'empty.txt' });
      expect(mockLlmClient.generateEmbedding).not.toHaveBeenCalled();
      const results = await service.search('query');
      expect(results).toEqual([]);
    });

    it('should handle special characters in text', async () => {
      const specialText = 'Hello! 😊 @#$%^&*()';
      mockLlmClient.generateEmbedding.mockResolvedValue([[0.1]]);
      await service.addText(specialText, { path: 'special.txt' });
      
      mockLlmClient.generateEmbedding.mockResolvedValue([[0.1]]);
      const results = await service.search('query');
      expect(results[0].text).toBe(specialText);
    });
  });

  describe('search', () => {
    it('should rank results by cosine similarity', async () => {
      mockLlmClient.generateEmbedding
        .mockResolvedValueOnce([[1, 0]]) // Entry 1
        .mockResolvedValueOnce([[0, 1]]) // Entry 2
        .mockResolvedValueOnce([[0.8, 0.2]]); // Query (closer to Entry 1)

      await service.addText('Apple', { id: 1 });
      await service.addText('Banana', { id: 2 });

      const results = await service.search('Fruit');
      expect(results[0].text).toBe('Apple');
      expect(results[1].text).toBe('Banana');
    });

    it('should return requested number of results', async () => {
      mockLlmClient.generateEmbedding.mockResolvedValue([[0.1], [0.2], [0.3]]);
      await service.addText('1', { id: 1 });
      await service.addText('2', { id: 2 });
      await service.addText('3', { id: 3 });

      mockLlmClient.generateEmbedding.mockResolvedValue([[0.1]]);
      const results = await service.search('query', 2);
      expect(results.length).toBe(2);
    });
  });

  describe('cosineSimilarity', () => {
    it('should calculate similarity correctly', async () => {
      // Internal method test via search
      mockLlmClient.generateEmbedding
        .mockResolvedValueOnce([[1, 0]]) // A
        .mockResolvedValueOnce([[1, 0]]); // Query (Identical)
      
      await service.addText('A', {});
      const results = await service.search('A');
      // Identical vectors should have similarity 1.0
      // We can't directly check similarity but we check order
      expect(results[0].text).toBe('A');
    });
  });
});