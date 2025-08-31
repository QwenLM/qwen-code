/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  StreamingTimeoutModel,
  ConfigRecommendationSystem,
  type StreamingRequest,
  type SystemMetrics,
} from './streamingTimeoutModel.js';

describe('StreamingTimeoutModel', () => {
  it('should calculate expected time correctly', () => {
    const model = new StreamingTimeoutModel();

    const request: StreamingRequest = {
      dataSize: 100,
      complexity: 5,
      setupTime: 10,
      processingRate: 10,
      networkLatency: 0.1,
      chunkSize: 10,
    };

    const metrics: SystemMetrics = {
      currentLoad: 0.5,
      avgSetupTime: 8,
      avgProcessingRate: 12,
      avgNetworkLatency: 0.05,
    };

    const expectedTime = model.calculateExpectedTime(request, metrics);
    // Expected: (10 * 1.5) + (100/12) + (0.05 * 10) = 15 + 8.33 + 0.5 = 23.83
    expect(expectedTime).toBeCloseTo(23.83, 2);
  });

  it('should correctly identify timeout conditions', () => {
    const model = new StreamingTimeoutModel();

    // Request that should timeout (64s base timeout)
    const timeoutRequest: StreamingRequest = {
      dataSize: 1000,
      complexity: 10,
      setupTime: 30,
      processingRate: 5,
      networkLatency: 0.5,
      chunkSize: 50,
    };

    // Request that should not timeout
    const noTimeoutRequest: StreamingRequest = {
      dataSize: 50,
      complexity: 3,
      setupTime: 5,
      processingRate: 20,
      networkLatency: 0.05,
      chunkSize: 10,
    };

    const metrics: SystemMetrics = {
      currentLoad: 0.3,
      avgSetupTime: 10,
      avgProcessingRate: 15,
      avgNetworkLatency: 0.1,
    };

    const timeoutAnalysis = model.analyzeTimeout(timeoutRequest, metrics);
    expect(timeoutAnalysis.willTimeout).toBe(true);

    const noTimeoutAnalysis = model.analyzeTimeout(noTimeoutRequest, metrics);
    expect(noTimeoutAnalysis.willTimeout).toBe(false);
  });

  it('should calculate adaptive timeouts', () => {
    const model = new StreamingTimeoutModel();

    const request: StreamingRequest = {
      dataSize: 200,
      complexity: 6,
      setupTime: 15,
      processingRate: 10,
      networkLatency: 0.2,
      chunkSize: 20,
    };

    const metrics: SystemMetrics = {
      currentLoad: 0.4,
      avgSetupTime: 12,
      avgProcessingRate: 15,
      avgNetworkLatency: 0.15,
    };

    const adaptiveTimeout = model.calculateAdaptiveTimeout(request, metrics);
    // Should be higher than base timeout of 64s
    expect(adaptiveTimeout).toBeGreaterThan(64);
  });
});

describe('ConfigRecommendationSystem', () => {
  it('should identify configuration issues', () => {
    const config = {
      contentGenerator: {
        timeout: 30000, // Too low
        samplingParams: {
          max_tokens: 5000, // Too high
          temperature: 1.5, // Too high
        },
      },
    };

    const recommendations = ConfigRecommendationSystem.analyzeConfig(config);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.some((rec) => rec.includes('timeout'))).toBe(true);
    expect(recommendations.some((rec) => rec.includes('max_tokens'))).toBe(
      true,
    );
  });

  it('should generate recommended configuration', () => {
    const config = {
      someOtherSetting: 'value',
    };

    const recommended =
      ConfigRecommendationSystem.generateRecommendedConfig(config);

    expect(recommended.contentGenerator).toBeDefined();
    expect(recommended.contentGenerator.timeout).toBe(120000);
    expect(recommended.contentGenerator.maxRetries).toBe(3);
    expect(recommended.contentGenerator.samplingParams).toBeDefined();
    expect(recommended.contentGenerator.samplingParams.temperature).toBe(0.7);
    expect(recommended.contentGenerator.samplingParams.max_tokens).toBe(2048);
    expect(recommended.someOtherSetting).toBe('value'); // Preserved existing settings
  });
});
