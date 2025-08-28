/**
 * @fileoverview Qwen-Code Core - Production Ready Alpha
 * @version 1.0.0-alpha.1
 * @license MIT
 * @author Qwen-Code Creative Team
 */

// Core exports
export { QwenCodeCore } from './core/qwen-code-core.js';
export { CreativeEngine } from './core/creative-engine.js';
export { SynergyOrchestrator } from './core/synergy-orchestrator.js';

// AI and ML components
export { AIManager } from './ai/ai-manager.js';
export { ModelRegistry } from './ai/model-registry.js';
export { PromptEngine } from './ai/prompt-engine.js';
export { ResponseProcessor } from './ai/response-processor.js';

// Creative tools
export { DreamProcessor } from './creative/dream-processor.js';
export { RecipeGenerator } from './creative/recipe-generator.js';
export { StoryEngine } from './creative/story-engine.js';
export { MusicComposer } from './creative/music-composer.js';
export { PlantGrower } from './creative/plant-grower.js';

// Infrastructure
export { DatabaseManager } from './infrastructure/database-manager.js';
export { CacheManager } from './infrastructure/cache-manager.js';
export { QueueManager } from './infrastructure/queue-manager.js';
export { FileManager } from './infrastructure/file-manager.js';

// Security and authentication
export { AuthManager } from './security/auth-manager.js';
export { RateLimiter } from './security/rate-limiter.js';
export { EncryptionService } from './security/encryption-service.js';

// Monitoring and observability
export { Logger } from './monitoring/logger.js';
export { MetricsCollector } from './monitoring/metrics-collector.js';
export { HealthChecker } from './monitoring/health-checker.js';
export { PerformanceMonitor } from './monitoring/performance-monitor.js';

// Utilities
export { ValidationUtils } from './utils/validation-utils.js';
export { ErrorHandler } from './utils/error-handler.js';
export { ConfigManager } from './utils/config-manager.js';
export { EventEmitter } from './utils/event-emitter.js';

// Types
export type * from './types/index.js';

// Constants
export { CONSTANTS } from './constants.js';
export { ERROR_CODES } from './constants.js';

// Initialize core system
import { Logger } from './monitoring/logger.js';
import { ConfigManager } from './utils/config-manager.js';
import { HealthChecker } from './monitoring/health-checker.js';

// Global error handler
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Initialize configuration
ConfigManager.initialize();

// Start health monitoring
HealthChecker.start();

Logger.info('🚀 Qwen-Code Core initialized successfully - Production Ready Alpha v1.0.0-alpha.1');
