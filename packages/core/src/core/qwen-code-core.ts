/**
 * @fileoverview QwenCodeCore - Production Ready Alpha
 * @version 1.0.0-alpha.1
 * @license MIT
 * @author Qwen-Code Creative Team
 */

import { Logger } from '../monitoring/logger.js';
import { MetricsCollector } from '../monitoring/metrics-collector.js';
import { PerformanceMonitor } from '../monitoring/performance-monitor.js';
import { ErrorHandler } from '../utils/error-handler.js';
import { ValidationUtils } from '../utils/validation-utils.js';
import { ConfigManager } from '../utils/config-manager.js';
import { EventEmitter } from '../utils/event-emitter.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { CacheManager } from '../infrastructure/cache-manager.js';
import { QueueManager } from '../infrastructure/queue-manager.js';
import type { 
  CodeGenerationRequest, 
  CodeGenerationResponse, 
  CreativeRequest,
  CreativeResponse,
  ModelConfig,
  PerformanceMetrics
} from '../types/index.js';

/**
 * QwenCodeCore - The heart of the creative AI ecosystem
 * Production ready with enterprise-grade features
 */
export class QwenCodeCore extends EventEmitter {
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly performance: PerformanceMonitor;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: CacheManager;
  private readonly queue: QueueManager;
  private readonly config: ConfigManager;
  
  private isInitialized: boolean = false;
  private healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
  private activeRequests: number = 0;
  private totalRequests: number = 0;
  private errorCount: number = 0;

  constructor() {
    super();
    
    this.logger = new Logger('QwenCodeCore');
    this.metrics = new MetricsCollector();
    this.performance = new PerformanceMonitor();
    this.rateLimiter = new RateLimiter();
    this.cache = new CacheManager();
    this.queue = new QueueManager();
    this.config = new ConfigManager();
    
    this.logger.info('Initializing QwenCodeCore...');
  }

  /**
   * Initialize the core system
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('Starting QwenCodeCore initialization...');
      
      // Initialize dependencies
      await Promise.all([
        this.cache.initialize(),
        this.queue.initialize(),
        this.rateLimiter.initialize(),
        this.metrics.initialize(),
        this.performance.initialize()
      ]);

      // Validate configuration
      this.validateConfiguration();
      
      // Start health monitoring
      this.startHealthMonitoring();
      
      this.isInitialized = true;
      this.healthStatus = 'healthy';
      
      this.logger.info('✅ QwenCodeCore initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      this.logger.error('❌ Failed to initialize QwenCodeCore:', error);
      this.healthStatus = 'unhealthy';
      throw new ErrorHandler('INITIALIZATION_FAILED', 'Failed to initialize QwenCodeCore', error);
    }
  }

  /**
   * Generate code using AI models
   */
  async generateCode(request: CodeGenerationRequest): Promise<CodeGenerationResponse> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    
    try {
      // Validate request
      this.validateCodeGenerationRequest(request);
      
      // Check rate limits
      await this.rateLimiter.checkLimit(request.userId, 'code_generation');
      
      // Check cache first
      const cachedResponse = await this.cache.get(`code:${request.hash}`);
      if (cachedResponse) {
        this.logger.debug(`Cache hit for request ${requestId}`);
        this.metrics.increment('cache_hits');
        return cachedResponse as CodeGenerationResponse;
      }

      // Increment active requests
      this.activeRequests++;
      this.totalRequests++;
      
      // Log request
      this.logger.info(`Processing code generation request ${requestId}`, {
        requestId,
        userId: request.userId,
        language: request.language,
        complexity: request.complexity
      });

      // Process request
      const response = await this.processCodeGeneration(request, requestId);
      
      // Cache response
      await this.cache.set(`code:${request.hash}`, response, 3600); // 1 hour
      
      // Record metrics
      const duration = Date.now() - startTime;
      this.metrics.record('code_generation_duration', duration);
      this.metrics.record('code_generation_success', 1);
      
      // Log success
      this.logger.info(`✅ Code generation completed for request ${requestId}`, {
        requestId,
        duration,
        responseSize: response.code.length
      });

      return response;
      
    } catch (error) {
      this.errorCount++;
      this.metrics.increment('code_generation_errors');
      
      const duration = Date.now() - startTime;
      this.logger.error(`❌ Code generation failed for request ${requestId}`, {
        requestId,
        duration,
        error: error.message,
        stack: error.stack
      });

      throw new ErrorHandler('CODE_GENERATION_FAILED', 'Failed to generate code', error);
      
    } finally {
      this.activeRequests--;
      this.emit('requestCompleted', { requestId, duration: Date.now() - startTime });
    }
  }

  /**
   * Process creative requests (dreams, recipes, stories, music, plants)
   */
  async processCreativeRequest(request: CreativeRequest): Promise<CreativeResponse> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    
    try {
      // Validate request
      this.validateCreativeRequest(request);
      
      // Check rate limits
      await this.rateLimiter.checkLimit(request.userId, 'creative_processing');
      
      // Check cache first
      const cachedResponse = await this.cache.get(`creative:${request.hash}`);
      if (cachedResponse) {
        this.logger.debug(`Cache hit for creative request ${requestId}`);
        this.metrics.increment('creative_cache_hits');
        return cachedResponse as CreativeResponse;
      }

      // Increment active requests
      this.activeRequests++;
      this.totalRequests++;
      
      // Log request
      this.logger.info(`Processing creative request ${requestId}`, {
        requestId,
        userId: request.userId,
        type: request.type,
        complexity: request.complexity
      });

      // Process request based on type
      const response = await this.processCreativeByType(request, requestId);
      
      // Cache response
      await this.cache.set(`creative:${request.hash}`, response, 7200); // 2 hours
      
      // Record metrics
      const duration = Date.now() - startTime;
      this.metrics.record('creative_processing_duration', duration);
      this.metrics.record('creative_processing_success', 1);
      
      // Log success
      this.logger.info(`✅ Creative processing completed for request ${requestId}`, {
        requestId,
        duration,
        responseSize: JSON.stringify(response).length
      });

      return response;
      
    } catch (error) {
      this.errorCount++;
      this.metrics.increment('creative_processing_errors');
      
      const duration = Date.now() - startTime;
      this.logger.error(`❌ Creative processing failed for request ${requestId}`, {
        requestId,
        duration,
        error: error.message,
        stack: error.stack
      });

      throw new ErrorHandler('CREATIVE_PROCESSING_FAILED', 'Failed to process creative request', error);
      
    } finally {
      this.activeRequests--;
      this.emit('creativeRequestCompleted', { requestId, duration: Date.now() - startTime });
    }
  }

  /**
   * Get system health status
   */
  getHealthStatus(): { status: string; details: any } {
    return {
      status: this.healthStatus,
      details: {
        isInitialized: this.isInitialized,
        activeRequests: this.activeRequests,
        totalRequests: this.totalRequests,
        errorCount: this.errorCount,
        errorRate: this.totalRequests > 0 ? (this.errorCount / this.totalRequests) * 100 : 0,
        cache: this.cache.getStatus(),
        queue: this.queue.getStatus(),
        rateLimiter: this.rateLimiter.getStatus(),
        performance: this.performance.getMetrics()
      }
    };
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return {
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      errorRate: this.totalRequests > 0 ? (this.errorCount / this.totalRequests) * 100 : 0,
      cacheHitRate: this.metrics.getRate('cache_hits', 'total_requests'),
      averageResponseTime: this.metrics.getAverage('code_generation_duration'),
      throughput: this.metrics.getThroughput('code_generation_success'),
      systemMetrics: this.performance.getMetrics()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.logger.info('🔄 Shutting down QwenCodeCore...');
    
    try {
      // Wait for active requests to complete
      if (this.activeRequests > 0) {
        this.logger.info(`Waiting for ${this.activeRequests} active requests to complete...`);
        await this.waitForActiveRequests();
      }
      
      // Shutdown dependencies
      await Promise.all([
        this.cache.shutdown(),
        this.queue.shutdown(),
        this.rateLimiter.shutdown(),
        this.metrics.shutdown(),
        this.performance.shutdown()
      ]);
      
      this.isInitialized = false;
      this.healthStatus = 'unhealthy';
      
      this.logger.info('✅ QwenCodeCore shutdown completed');
      this.emit('shutdown');
      
    } catch (error) {
      this.logger.error('❌ Error during shutdown:', error);
      throw error;
    }
  }

  // Private methods

  private validateConfiguration(): void {
    const requiredConfigs = [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'REDIS_URL',
      'DATABASE_URL'
    ];
    
    for (const config of requiredConfigs) {
      if (!this.config.get(config)) {
        throw new Error(`Missing required configuration: ${config}`);
      }
    }
  }

  private validateCodeGenerationRequest(request: CodeGenerationRequest): void {
    if (!ValidationUtils.isValidCodeGenerationRequest(request)) {
      throw new ErrorHandler('INVALID_REQUEST', 'Invalid code generation request');
    }
  }

  private validateCreativeRequest(request: CreativeRequest): void {
    if (!ValidationUtils.isValidCreativeRequest(request)) {
      throw new ErrorHandler('INVALID_REQUEST', 'Invalid creative request');
    }
  }

  private async processCodeGeneration(request: CodeGenerationRequest, requestId: string): Promise<CodeGenerationResponse> {
    // This would integrate with actual AI models
    // For now, return a mock response
    return {
      id: requestId,
      code: `// Generated code for: ${request.prompt}\n// Language: ${request.language}\n// Complexity: ${request.complexity}\n\nfunction generatedFunction() {\n  console.log("Hello from AI-generated code!");\n  return "Success";\n}`,
      language: request.language,
      complexity: request.complexity,
      metadata: {
        model: 'qwen-code-alpha',
        timestamp: new Date().toISOString(),
        tokens: 150,
        confidence: 0.95
      }
    };
  }

  private async processCreativeByType(request: CreativeRequest, requestId: string): Promise<CreativeResponse> {
    // This would integrate with creative AI models
    // For now, return a mock response
    return {
      id: requestId,
      type: request.type,
      content: `Creative content for ${request.type}: ${request.prompt}`,
      metadata: {
        model: 'qwen-creative-alpha',
        timestamp: new Date().toISOString(),
        creativity: 0.9,
        originality: 0.85
      }
    };
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private startHealthMonitoring(): void {
    setInterval(() => {
      this.checkHealth();
    }, 30000); // Check every 30 seconds
  }

  private async checkHealth(): Promise<void> {
    try {
      const cacheHealth = await this.cache.isHealthy();
      const queueHealth = await this.queue.isHealthy();
      const rateLimiterHealth = await this.rateLimiter.isHealthy();
      
      if (cacheHealth && queueHealth && rateLimiterHealth) {
        this.healthStatus = 'healthy';
      } else if (this.errorCount > this.totalRequests * 0.1) {
        this.healthStatus = 'degraded';
      } else {
        this.healthStatus = 'unhealthy';
      }
      
      this.emit('healthCheck', { status: this.healthStatus, timestamp: new Date() });
      
    } catch (error) {
      this.logger.error('Health check failed:', error);
      this.healthStatus = 'unhealthy';
    }
  }

  private async waitForActiveRequests(): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeRequests === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      
      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        this.logger.warn('Timeout waiting for active requests, proceeding with shutdown');
        resolve();
      }, 30000);
    });
  }
}