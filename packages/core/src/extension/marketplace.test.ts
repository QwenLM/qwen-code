/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseMarketplaceSource } from './marketplace.js';

describe('Marketplace Installation', () => {
  describe('parseMarketplaceSource', () => {
    it('should parse valid marketplace source with http URL', () => {
      const result = parseMarketplaceSource(
        'http://example.com/marketplace:my-plugin',
      );
      expect(result).toEqual({
        marketplaceSource: 'http://example.com/marketplace',
        pluginName: 'my-plugin',
      });
    });

    it('should parse valid marketplace source with https URL', () => {
      const result = parseMarketplaceSource(
        'https://github.com/example/marketplace:awesome-plugin',
      );
      expect(result).toEqual({
        marketplaceSource: 'https://github.com/example/marketplace',
        pluginName: 'awesome-plugin',
      });
    });

    it('should handle plugin names with hyphens', () => {
      const result = parseMarketplaceSource(
        'https://example.com:my-super-plugin',
      );
      expect(result).toEqual({
        marketplaceSource: 'https://example.com',
        pluginName: 'my-super-plugin',
      });
    });

    it('should handle URLs with ports', () => {
      const result = parseMarketplaceSource(
        'https://example.com:8080/marketplace:plugin',
      );
      expect(result).toEqual({
        marketplaceSource: 'https://example.com:8080/marketplace',
        pluginName: 'plugin',
      });
    });

    it('should return null for source without colon separator', () => {
      const result = parseMarketplaceSource('https://example.com/plugin');
      expect(result).toBeNull();
    });

    it('should return null for source without URL', () => {
      const result = parseMarketplaceSource('not-a-url:plugin');
      expect(result).toBeNull();
    });

    it('should return null for source with empty plugin name', () => {
      const result = parseMarketplaceSource('https://example.com:');
      expect(result).toBeNull();
    });

    it('should use last colon as separator', () => {
      // URLs with ports have colons, should use the last one
      const result = parseMarketplaceSource(
        'https://example.com:8080:my-plugin',
      );
      expect(result).toEqual({
        marketplaceSource: 'https://example.com:8080',
        pluginName: 'my-plugin',
      });
    });
  });
});
