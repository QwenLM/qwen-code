/**
 * UsageTracker
 *
 * Tracks token usage and context window consumption for agent sessions.
 * Provides accurate per-message tracking (not cumulative billing totals)
 * for real-time context window display.
 *
 * Used by backend agents to:
 * - Track input/output tokens per message
 * - Calculate cache hit/miss rates
 * - Emit usage_update events for UI display
 * - Track cumulative session usage (for billing display)
 */

// ============================================================
// Types
// ============================================================

/**
 * Token usage for a single message.
 */
export interface MessageUsage {
  /** Total input tokens (includes cache tokens) */
  inputTokens: number;

  /** Output tokens generated */
  outputTokens: number;

  /** Tokens read from cache */
  cacheReadTokens: number;

  /** Tokens written to cache */
  cacheCreationTokens: number;

  /** Timestamp of this usage record */
  timestamp: number;
}

/**
 * Cumulative session usage (for billing/totals).
 */
export interface SessionUsage {
  /** Total input tokens across all messages */
  totalInputTokens: number;

  /** Total output tokens across all messages */
  totalOutputTokens: number;

  /** Total cache read tokens */
  totalCacheReadTokens: number;

  /** Total cache creation tokens */
  totalCacheCreationTokens: number;

  /** Number of messages/turns */
  messageCount: number;

  /** Session start timestamp */
  startedAt: number;
}

/**
 * Usage update event data (for UI display).
 */
export interface UsageUpdate {
  /** Current context size (input tokens for last message) */
  inputTokens: number;

  /** Context window size (model's maximum) */
  contextWindow?: number;

  /** Cache hit rate (0-1) */
  cacheHitRate?: number;
}

/**
 * Configuration for UsageTracker.
 */
export interface UsageTrackerConfig {
  /** Context window size for the model being used */
  contextWindow?: number;

  /** Callback when usage is updated */
  onUsageUpdate?: (update: UsageUpdate) => void;

  /** Debug callback */
  onDebug?: (message: string) => void;
}

// ============================================================
// UsageTracker Class
// ============================================================

/**
 * Tracks token usage for an agent session.
 *
 * Provides:
 * - Per-message usage tracking (for accurate context window display)
 * - Cumulative session usage (for billing totals)
 * - Cache efficiency metrics
 * - Real-time usage update events
 */
export class UsageTracker {
  private config: UsageTrackerConfig;
  private sessionUsage: SessionUsage;
  private lastMessageUsage: MessageUsage | null = null;
  private cachedContextWindow?: number;

  constructor(config: UsageTrackerConfig = {}) {
    this.config = config;
    this.cachedContextWindow = config.contextWindow;
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
  }

  /**
   * Record usage from an assistant message.
   * This is called during message processing to track real-time usage.
   */
  recordMessageUsage(usage: {
    inputTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    const now = Date.now();

    // Calculate total input including cache
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const totalInput = usage.inputTokens + cacheRead + cacheCreation;

    // Update last message usage (for per-message display)
    this.lastMessageUsage = {
      inputTokens: totalInput,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      timestamp: now,
    };

    this.debug(`Message usage: ${totalInput} input, ${usage.outputTokens ?? 0} output, ${cacheRead} cache read`);

    // Emit usage update
    this.emitUsageUpdate();
  }

  /**
   * Record final usage when a turn completes.
   * Updates cumulative session totals.
   */
  recordTurnComplete(usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    // Use provided usage or last tracked message usage
    const finalUsage = usage ?? this.lastMessageUsage;

    if (finalUsage) {
      this.sessionUsage.totalInputTokens += finalUsage.inputTokens;
      this.sessionUsage.totalOutputTokens += finalUsage.outputTokens;
      this.sessionUsage.totalCacheReadTokens += finalUsage.cacheReadTokens ?? 0;
      this.sessionUsage.totalCacheCreationTokens += finalUsage.cacheCreationTokens ?? 0;
      this.sessionUsage.messageCount++;
    }

    this.debug(`Turn complete: ${this.sessionUsage.messageCount} messages, ${this.sessionUsage.totalInputTokens} total input`);
  }

  /**
   * Set/update the context window size.
   * This can be updated dynamically as model info becomes available.
   */
  setContextWindow(contextWindow: number): void {
    this.cachedContextWindow = contextWindow;
    this.debug(`Context window set: ${contextWindow}`);
  }

  /**
   * Get the current context window size.
   */
  getContextWindow(): number | undefined {
    return this.cachedContextWindow;
  }

  /**
   * Get the last message's usage (for per-message display).
   */
  getLastMessageUsage(): MessageUsage | null {
    return this.lastMessageUsage ? { ...this.lastMessageUsage } : null;
  }

  /**
   * Get cumulative session usage (for billing/totals).
   */
  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  /**
   * Get the current input tokens (from last message).
   * This represents the actual context size sent to the API.
   */
  getCurrentInputTokens(): number {
    return this.lastMessageUsage?.inputTokens ?? 0;
  }

  /**
   * Calculate cache hit rate (0-1).
   * Higher is better - more tokens served from cache.
   */
  getCacheHitRate(): number {
    const total = this.sessionUsage.totalInputTokens;
    if (total === 0) return 0;

    const cacheRead = this.sessionUsage.totalCacheReadTokens;
    return cacheRead / total;
  }

  /**
   * Get context usage as a percentage (0-100).
   * Returns undefined if context window is not set.
   */
  getContextUsagePercent(): number | undefined {
    if (!this.cachedContextWindow || !this.lastMessageUsage) {
      return undefined;
    }

    return (this.lastMessageUsage.inputTokens / this.cachedContextWindow) * 100;
  }

  /**
   * Check if context is getting full (> 80% used).
   */
  isContextFilling(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 80;
  }

  /**
   * Check if context is critically full (> 95% used).
   */
  isContextCritical(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 95;
  }

  /**
   * Reset all tracking (for new session).
   */
  reset(): void {
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
    this.lastMessageUsage = null;
    this.debug('Usage tracker reset');
  }

  /**
   * Build a UsageUpdate object for emitting events.
   */
  buildUsageUpdate(): UsageUpdate {
    return {
      inputTokens: this.getCurrentInputTokens(),
      contextWindow: this.cachedContextWindow,
      cacheHitRate: this.getCacheHitRate(),
    };
  }

  private emitUsageUpdate(): void {
    this.config.onUsageUpdate?.(this.buildUsageUpdate());
  }

  private debug(message: string): void {
    this.config.onDebug?.(`[UsageTracker] ${message}`);
  }
}

/**
 * Create a new UsageTracker.
 */
export function createUsageTracker(config?: UsageTrackerConfig): UsageTracker {
  return new UsageTracker(config);
}
