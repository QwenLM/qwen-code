/**
 * @fileoverview Type definitions for Qwen-Code Core - Production Ready Alpha
 * @version 1.0.0-alpha.1
 * @license MIT
 * @author Qwen-Code Creative Team
 */

// Core Types
export interface BaseRequest {
  id?: string;
  userId: string;
  timestamp: string;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface BaseResponse {
  id: string;
  success: boolean;
  timestamp: string;
  duration: number;
  metadata?: Record<string, any>;
}

// Code Generation Types
export interface CodeGenerationRequest extends BaseRequest {
  prompt: string;
  language: string;
  complexity: 'simple' | 'medium' | 'complex' | 'expert';
  context?: string;
  constraints?: string[];
  style?: 'functional' | 'object-oriented' | 'procedural' | 'declarative';
  framework?: string;
  target?: 'web' | 'mobile' | 'desktop' | 'server' | 'embedded';
  hash: string; // For caching
}

export interface CodeGenerationResponse extends BaseResponse {
  code: string;
  language: string;
  complexity: string;
  explanation?: string;
  tests?: string;
  documentation?: string;
  suggestions?: string[];
  metadata: {
    model: string;
    timestamp: string;
    tokens: number;
    confidence: number;
    version: string;
  };
}

// Creative Processing Types
export type CreativeType = 'dream' | 'recipe' | 'story' | 'music' | 'plant' | 'art' | 'poem' | 'design';

export interface CreativeRequest extends BaseRequest {
  type: CreativeType;
  prompt: string;
  complexity: 'simple' | 'medium' | 'complex' | 'expert';
  style?: string;
  parameters?: Record<string, any>;
  constraints?: string[];
  hash: string; // For caching
}

export interface CreativeResponse extends BaseResponse {
  type: CreativeType;
  content: string | Buffer | any;
  format: 'text' | 'json' | 'binary' | 'structured';
  metadata: {
    model: string;
    timestamp: string;
    creativity: number;
    originality: number;
    quality: number;
    version: string;
  };
}

// AI Model Types
export interface ModelConfig {
  name: string;
  version: string;
  provider: string;
  capabilities: string[];
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  stopSequences: string[];
}

export interface ModelRegistry {
  models: Map<string, ModelConfig>;
  activeModel: string;
  fallbackModel: string;
}

// Performance and Metrics Types
export interface PerformanceMetrics {
  activeRequests: number;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  cacheHitRate: number;
  averageResponseTime: number;
  throughput: number;
  systemMetrics: SystemMetrics;
}

export interface SystemMetrics {
  cpu: {
    usage: number;
    load: number;
    cores: number;
  };
  memory: {
    used: number;
    total: number;
    free: number;
    percentage: number;
  };
  disk: {
    used: number;
    total: number;
    free: number;
    percentage: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    connections: number;
  };
  uptime: number;
  version: string;
}

// Cache Types
export interface CacheEntry<T = any> {
  key: string;
  value: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  keys: number;
  memory: number;
  evictions: number;
}

// Queue Types
export interface QueueJob<T = any> {
  id: string;
  type: string;
  data: T;
  priority: number;
  attempts: number;
  maxAttempts: number;
  delay: number;
  timestamp: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'delayed';
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  delayed: number;
  workers: number;
}

// Rate Limiting Types
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests: boolean;
  skipFailedRequests: boolean;
  keyGenerator: (req: any) => string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter: number;
}

// Security Types
export interface AuthToken {
  userId: string;
  email: string;
  permissions: string[];
  roles: string[];
  issuedAt: number;
  expiresAt: number;
  issuer: string;
}

export interface SecurityContext {
  userId: string;
  sessionId: string;
  ip: string;
  userAgent: string;
  permissions: string[];
  roles: string[];
  metadata: Record<string, any>;
}

// Database Types
export interface DatabaseConfig {
  type: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'redis';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  pool: {
    min: number;
    max: number;
    acquire: number;
    idle: number;
  };
}

export interface DatabaseStats {
  connections: number;
  queries: number;
  slowQueries: number;
  errors: number;
  uptime: number;
}

// Event Types
export interface SystemEvent {
  type: string;
  timestamp: string;
  source: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  data?: any;
  userId?: string;
  sessionId?: string;
  requestId?: string;
}

export interface EventListener {
  event: string;
  handler: (event: SystemEvent) => void | Promise<void>;
  priority: number;
  filter?: (event: SystemEvent) => boolean;
}

// Configuration Types
export interface AppConfig {
  environment: 'development' | 'staging' | 'production';
  version: string;
  port: number;
  host: string;
  cors: {
    origin: string | string[];
    credentials: boolean;
  };
  logging: {
    level: string;
    format: string;
    destination: string;
  };
  security: {
    jwtSecret: string;
    bcryptRounds: number;
    rateLimit: RateLimitConfig;
  };
  database: DatabaseConfig;
  cache: {
    redis: {
      url: string;
      ttl: number;
    };
  };
  queue: {
    redis: {
      url: string;
      prefix: string;
    };
    concurrency: number;
  };
  ai: {
    openai: {
      apiKey: string;
      baseURL: string;
      model: string;
      timeout: number;
    };
    qwen: {
      apiKey: string;
      baseURL: string;
      model: string;
      timeout: number;
    };
  };
}

// Error Types
export interface AppError extends Error {
  code: string;
  statusCode: number;
  isOperational: boolean;
  details?: any;
  context?: string;
  timestamp: string;
  requestId?: string;
  userId?: string;
}

export interface ErrorContext {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  url?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
  timestamp: string;
}

// Validation Types
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: any;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
  value?: any;
}

// Health Check Types
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  duration: number;
  timestamp: string;
  details?: any;
}

// API Response Types
export interface ApiResponse<T = any> extends BaseResponse {
  data?: T;
  error?: AppError;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface PaginatedResponse<T = any> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// WebSocket Types
export interface WebSocketMessage {
  type: string;
  data: any;
  timestamp: string;
  userId?: string;
  sessionId?: string;
}

export interface WebSocketConnection {
  id: string;
  userId?: string;
  sessionId?: string;
  connectedAt: string;
  lastActivity: string;
  metadata: Record<string, any>;
}

// File Types
export interface FileInfo {
  name: string;
  path: string;
  size: number;
  type: string;
  extension: string;
  lastModified: string;
  permissions: string;
  metadata: Record<string, any>;
}

export interface FileUpload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
}

// Export all types
export type {
  BaseRequest,
  BaseResponse,
  CodeGenerationRequest,
  CodeGenerationResponse,
  CreativeRequest,
  CreativeResponse,
  ModelConfig,
  ModelRegistry,
  PerformanceMetrics,
  SystemMetrics,
  CacheEntry,
  CacheStats,
  QueueJob,
  QueueStats,
  RateLimitConfig,
  RateLimitInfo,
  AuthToken,
  SecurityContext,
  DatabaseConfig,
  DatabaseStats,
  SystemEvent,
  EventListener,
  AppConfig,
  AppError,
  ErrorContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  HealthStatus,
  HealthCheck,
  ApiResponse,
  PaginatedResponse,
  WebSocketMessage,
  WebSocketConnection,
  FileInfo,
  FileUpload
};