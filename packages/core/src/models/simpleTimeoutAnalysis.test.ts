/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { 
  enhanceTimeoutErrorMessage, 
  suggestTimeoutConfig 
} from './simpleTimeoutAnalysis.js';

describe('Simple Timeout Analysis', () => {
  it('should enhance timeout error message with general troubleshooting', () => {
    const baseMessage = 'Streaming setup timeout after 64s. Try reducing input length or increasing timeout in config.';
    const enhancedMessage = enhanceTimeoutErrorMessage(baseMessage);
    
    expect(enhancedMessage).toContain('Streaming setup timeout troubleshooting:');
    expect(enhancedMessage).toContain('- Reduce input length or complexity');
    expect(enhancedMessage).toContain('- Increase timeout in config: contentGenerator.timeout');
    expect(enhancedMessage).toContain('- Check network connectivity and firewall settings');
    expect(enhancedMessage).toContain('- Consider using non-streaming mode for very long inputs');
  });

  it('should add size-specific recommendations for large requests', () => {
    const baseMessage = 'Streaming setup timeout after 64s. Try reducing input length or increasing timeout in config.';
    const enhancedMessage = enhanceTimeoutErrorMessage(baseMessage, 150, 5);
    
    expect(enhancedMessage).toContain('Additional recommendations for large requests (150 MB):');
    expect(enhancedMessage).toContain('- Consider breaking your request into smaller chunks');
    expect(enhancedMessage).toContain('- Use progressive summarization for context');
    expect(enhancedMessage).toContain('- Enable checkpointing if available');
  });

  it('should add complexity-specific recommendations for complex requests', () => {
    const baseMessage = 'Streaming setup timeout after 64s. Try reducing input length or increasing timeout in config.';
    const enhancedMessage = enhanceTimeoutErrorMessage(baseMessage, 50, 8);
    
    expect(enhancedMessage).toContain('Additional recommendations for complex requests (complexity 8/10):');
    expect(enhancedMessage).toContain('- Simplify request structure if possible');
    expect(enhancedMessage).toContain('- Use more specific prompts');
    expect(enhancedMessage).toContain('- Consider using tool-based approaches for complex tasks');
  });

  it('should suggest appropriate timeout configuration', () => {
    // Test base case
    const baseTimeout = suggestTimeoutConfig();
    expect(baseTimeout).toBe(64000);
    
    // Test with large request size
    const largeRequestTimeout = suggestTimeoutConfig(100, 5);
    expect(largeRequestTimeout).toBeGreaterThan(64000);
    expect(largeRequestTimeout).toBeLessThanOrEqual(300000);
    
    // Test with high complexity
    const complexRequestTimeout = suggestTimeoutConfig(50, 8);
    expect(complexRequestTimeout).toBeGreaterThan(64000);
    expect(complexRequestTimeout).toBeLessThanOrEqual(300000);
    
    // Test with both large size and high complexity
    const largeComplexTimeout = suggestTimeoutConfig(200, 9);
    expect(largeComplexTimeout).toBeGreaterThan(64000);
    expect(largeComplexTimeout).toBeLessThanOrEqual(300000);
  });

  it('should cap timeout suggestions at reasonable maximum', () => {
    // Test with extremely large request
    const extremeTimeout = suggestTimeoutConfig(10000, 10);
    expect(extremeTimeout).toBeLessThanOrEqual(300000); // Should be capped at 5 minutes (300000ms)
    expect(extremeTimeout).toBeGreaterThanOrEqual(280000); // But should be close to the cap
  });
});