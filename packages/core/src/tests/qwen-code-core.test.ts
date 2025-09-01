/**
 * @fileoverview QwenCodeCore Tests - Production Ready Alpha
 * @version 1.0.0-alpha.1
 * @license MIT
 * @author Qwen-Code Creative Team
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QwenCodeCore } from '../core/qwen-code-core.js';
import type { CodeGenerationRequest, CreativeRequest } from '../types/index.js';

// Mock dependencies
vi.mock('../monitoring/logger.js');
vi.mock('../monitoring/metrics-collector.js');
vi.mock('../monitoring/performance-monitor.js');
vi.mock('../utils/error-handler.js');
vi.mock('../utils/validation-utils.js');
vi.mock('../utils/config-manager.js');
vi.mock('../utils/event-emitter.js');
vi.mock('../security/rate-limiter.js');
vi.mock('../infrastructure/cache-manager.js');
vi.mock('../infrastructure/queue-manager.js');

describe('QwenCodeCore', () => {
  let qwenCodeCore: QwenCodeCore;
  
  const mockCodeRequest: CodeGenerationRequest = {
    userId: 'user123',
    timestamp: new Date().toISOString(),
    prompt: 'Create a simple function',
    language: 'javascript',
    complexity: 'simple',
    hash: 'hash123'
  };

  const mockCreativeRequest: CreativeRequest = {
    userId: 'user123',
    timestamp: new Date().toISOString(),
    type: 'dream',
    prompt: 'Generate a dream visualization',
    complexity: 'medium',
    hash: 'hash456'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    qwenCodeCore = new QwenCodeCore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize successfully with all dependencies', async () => {
      // Mock successful initialization
      vi.mocked(qwenCodeCore['cache'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue('test-value');

      await qwenCodeCore.initialize();

      expect(qwenCodeCore['isInitialized']).toBe(true);
      expect(qwenCodeCore['healthStatus']).toBe('healthy');
    });

    it('should handle initialization failures gracefully', async () => {
      // Mock cache initialization failure
      vi.mocked(qwenCodeCore['cache'].initialize).mockRejectedValue(new Error('Cache init failed'));

      await expect(qwenCodeCore.initialize()).rejects.toThrow('Failed to initialize QwenCodeCore');
      expect(qwenCodeCore['healthStatus']).toBe('unhealthy');
    });

    it('should validate required configuration', async () => {
      // Mock missing configuration
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue(undefined);

      await expect(qwenCodeCore.initialize()).rejects.toThrow('Missing required configuration');
    });
  });

  describe('Code Generation', () => {
    beforeEach(async () => {
      // Setup successful initialization
      vi.mocked(qwenCodeCore['cache'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue('test-value');
      
      await qwenCodeCore.initialize();
    });

    it('should generate code successfully', async () => {
      // Mock successful processing
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      const result = await qwenCodeCore.generateCode(mockCodeRequest);

      expect(result).toBeDefined();
      expect(result.code).toContain('Hello from AI-generated code!');
      expect(result.language).toBe('javascript');
      expect(result.complexity).toBe('simple');
    });

    it('should return cached response when available', async () => {
      const cachedResponse = {
        id: 'cached123',
        code: 'cached code',
        language: 'javascript',
        complexity: 'simple',
        metadata: { model: 'test', timestamp: '', tokens: 100, confidence: 0.9 }
      };

      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(cachedResponse);

      const result = await qwenCodeCore.generateCode(mockCodeRequest);

      expect(result).toEqual(cachedResponse);
      expect(qwenCodeCore['metrics'].increment).toHaveBeenCalledWith('cache_hits');
    });

    it('should handle rate limiting', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(qwenCodeCore.generateCode(mockCodeRequest)).rejects.toThrow('Rate limit exceeded');
    });

    it('should track metrics correctly', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      await qwenCodeCore.generateCode(mockCodeRequest);

      expect(qwenCodeCore['metrics'].record).toHaveBeenCalledWith('code_generation_duration', expect.any(Number));
      expect(qwenCodeCore['metrics'].record).toHaveBeenCalledWith('code_generation_success', 1);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockRejectedValue(new Error('Processing failed'));

      await expect(qwenCodeCore.generateCode(mockCodeRequest)).rejects.toThrow('Failed to generate code');
      expect(qwenCodeCore['errorCount']).toBe(1);
    });
  });

  describe('Creative Processing', () => {
    beforeEach(async () => {
      // Setup successful initialization
      vi.mocked(qwenCodeCore['cache'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue('test-value');
      
      await qwenCodeCore.initialize();
    });

    it('should process creative requests successfully', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      const result = await qwenCodeCore.processCreativeRequest(mockCreativeRequest);

      expect(result).toBeDefined();
      expect(result.type).toBe('dream');
      expect(result.content).toContain('Creative content for dream');
    });

    it('should cache creative responses', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      await qwenCodeCore.processCreativeRequest(mockCreativeRequest);

      expect(qwenCodeCore['cache'].set).toHaveBeenCalledWith(
        'creative:hash456',
        expect.any(Object),
        7200
      );
    });

    it('should track creative processing metrics', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      await qwenCodeCore.processCreativeRequest(mockCreativeRequest);

      expect(qwenCodeCore['metrics'].record).toHaveBeenCalledWith('creative_processing_duration', expect.any(Number));
      expect(qwenCodeCore['metrics'].record).toHaveBeenCalledWith('creative_processing_success', 1);
    });
  });

  describe('Health Monitoring', () => {
    it('should provide accurate health status', () => {
      const healthStatus = qwenCodeCore.getHealthStatus();

      expect(healthStatus).toHaveProperty('status');
      expect(healthStatus).toHaveProperty('details');
      expect(healthStatus.details).toHaveProperty('isInitialized');
      expect(healthStatus.details).toHaveProperty('activeRequests');
      expect(healthStatus.details).toHaveProperty('errorCount');
    });

    it('should track performance metrics', () => {
      const metrics = qwenCodeCore.getPerformanceMetrics();

      expect(metrics).toHaveProperty('activeRequests');
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('errorCount');
      expect(metrics).toHaveProperty('errorRate');
      expect(metrics).toHaveProperty('cacheHitRate');
      expect(metrics).toHaveProperty('averageResponseTime');
      expect(metrics).toHaveProperty('throughput');
    });
  });

  describe('Shutdown', () => {
    beforeEach(async () => {
      // Setup successful initialization
      vi.mocked(qwenCodeCore['cache'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue('test-value');
      
      await qwenCodeCore.initialize();
    });

    it('should shutdown gracefully', async () => {
      vi.mocked(qwenCodeCore['cache'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].shutdown).mockResolvedValue();

      await qwenCodeCore.shutdown();

      expect(qwenCodeCore['isInitialized']).toBe(false);
      expect(qwenCodeCore['healthStatus']).toBe('unhealthy');
    });

    it('should wait for active requests to complete', async () => {
      // Simulate active requests
      qwenCodeCore['activeRequests'] = 2;
      
      vi.mocked(qwenCodeCore['cache'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].shutdown).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].shutdown).mockResolvedValue();

      // Simulate requests completing
      setTimeout(() => {
        qwenCodeCore['activeRequests'] = 0;
      }, 100);

      await qwenCodeCore.shutdown();

      expect(qwenCodeCore['isInitialized']).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle validation errors', async () => {
      // Mock validation failure
      vi.mocked(qwenCodeCore['validationUtils'].isValidCodeGenerationRequest).mockReturnValue(false);

      await expect(qwenCodeCore.generateCode(mockCodeRequest)).rejects.toThrow('Invalid code generation request');
    });

    it('should handle cache errors gracefully', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockRejectedValue(new Error('Cache error'));

      await expect(qwenCodeCore.generateCode(mockCodeRequest)).rejects.toThrow('Failed to generate code');
    });

    it('should handle queue errors gracefully', async () => {
      vi.mocked(qwenCodeCore['queue'].initialize).mockRejectedValue(new Error('Queue error'));

      await expect(qwenCodeCore.initialize()).rejects.toThrow('Failed to initialize QwenCodeCore');
    });
  });

  describe('Event Emission', () => {
    it('should emit initialization events', async () => {
      const eventSpy = vi.fn();
      qwenCodeCore.on('initialized', eventSpy);

      vi.mocked(qwenCodeCore['cache'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['queue'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['rateLimiter'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['metrics'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['performance'].initialize).mockResolvedValue();
      vi.mocked(qwenCodeCore['config'].get).mockReturnValue('test-value');

      await qwenCodeCore.initialize();

      expect(eventSpy).toHaveBeenCalled();
    });

    it('should emit request completion events', async () => {
      const eventSpy = vi.fn();
      qwenCodeCore.on('requestCompleted', eventSpy);

      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      await qwenCodeCore.generateCode(mockCodeRequest);

      expect(eventSpy).toHaveBeenCalledWith({
        requestId: expect.any(String),
        duration: expect.any(Number)
      });
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle concurrent requests', async () => {
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      const concurrentRequests = Array(10).fill(null).map(() => 
        qwenCodeCore.generateCode(mockCodeRequest)
      );

      const results = await Promise.all(concurrentRequests);

      expect(results).toHaveLength(10);
      expect(qwenCodeCore['totalRequests']).toBe(10);
    });

    it('should maintain performance under load', async () => {
      const startTime = Date.now();
      
      vi.mocked(qwenCodeCore['rateLimiter'].checkLimit).mockResolvedValue();
      vi.mocked(qwenCodeCore['cache'].get).mockResolvedValue(null);
      vi.mocked(qwenCodeCore['cache'].set).mockResolvedValue();

      for (let i = 0; i < 100; i++) {
        await qwenCodeCore.generateCode(mockCodeRequest);
      }

      const totalTime = Date.now() - startTime;
      const averageTime = totalTime / 100;

      // Should process requests in under 10ms average
      expect(averageTime).toBeLessThan(10);
    });
  });
});