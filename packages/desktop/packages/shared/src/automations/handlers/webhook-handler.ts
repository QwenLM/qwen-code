/**
 * WebhookHandler - Processes webhook actions for App events
 *
 * Subscribes to App events and executes HTTP webhook requests.
 * Sends requests to configured HTTP/HTTPS endpoints with configurable
 * method, headers, and body format (JSON or raw).
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import { APP_EVENTS, type AutomationEvent, type WebhookAction, type WebhookActionResult, type AppEvent } from '../types.ts';
import { matcherMatches, buildWebhookEnv, expandEnvVars } from '../utils.ts';
import { executeWithRetry, redactUrl, isTransientFailure, createWebhookHistoryEntry, expandWebhookAction } from '../webhook-utils.ts';
import { RetryScheduler } from '../retry-scheduler.ts';
import { appendAutomationHistoryEntry } from '../history-store.ts';

const log = createLogger('webhook-handler');

// ============================================================================
// Types
// ============================================================================

export interface WebhookHandlerOptions {
  /** Workspace ID */
  workspaceId: string;
  /** Workspace root path */
  workspaceRootPath: string;
  /** Called when webhook results are available */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** Called when a webhook execution fails */
  onError?: (event: AutomationEvent, error: Error) => void;
}

/** A webhook action paired with the matcher that triggered it */
interface WebhookTask {
  action: WebhookAction;
  matcherId: string;
}

// ============================================================================
// Per-Endpoint Rate Limiter
// ============================================================================

/** Sliding-window rate limiter per URL origin. Prevents flooding a single server. */
class EndpointRateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxPerMinute: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxPerMinute = 30) {
    this.maxPerMinute = maxPerMinute;
    // Prune stale origins every 5 minutes
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 120_000;
      for (const [origin, timestamps] of this.windows) {
        if (timestamps.every(t => t < cutoff)) {
          this.windows.delete(origin);
        }
      }
    }, 300_000);
  }

  /** Returns true if the request is allowed */
  allow(url: string): boolean {
    const origin = this.getOrigin(url);
    const now = Date.now();
    const windowStart = now - 60_000;

    let timestamps = this.windows.get(origin);
    if (timestamps) {
      timestamps = timestamps.filter(t => t > windowStart);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.maxPerMinute) {
      return false;
    }

    timestamps.push(now);
    this.windows.set(origin, timestamps);
    return true;
  }

  private getOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

// ============================================================================
// WebhookHandler Implementation
// ============================================================================

export class WebhookHandler implements AutomationHandler {
  private readonly options: WebhookHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  private readonly rateLimiter = new EndpointRateLimiter(30);
  private readonly retryScheduler: RetryScheduler;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: WebhookHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
    this.retryScheduler = new RetryScheduler({ workspaceRootPath: options.workspaceRootPath });
  }

  /**
   * Subscribe to App events on the bus.
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    this.retryScheduler.start();
    log.debug(`[WebhookHandler] Subscribed to event bus`);
  }

  /**
   * Handle an event by processing matching webhook actions.
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // Only process App events for webhook actions
    if (!APP_EVENTS.includes(event as AppEvent)) {
      return;
    }

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    // Collect webhook actions from matching matchers, threading matcher IDs for history
    const webhookTasks: WebhookTask[] = [];

    for (const matcher of matchers) {
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue;

      for (const action of matcher.actions) {
        if (action.type === 'webhook') {
          webhookTasks.push({ action, matcherId: matcher.id ?? 'unknown' });
        }
      }
    }

    if (webhookTasks.length === 0) return;

    log.debug(`[WebhookHandler] Processing ${webhookTasks.length} webhooks for ${event}`);

    // Build environment variables for URL/body expansion (webhook-safe: no process.env leak)
    const env = buildWebhookEnv(event, payload);

    // Apply per-endpoint rate limiting before execution.
    // Resolve URLs first (expand env vars) so rate limiting works on actual endpoints.
    const results: WebhookActionResult[] = new Array(webhookTasks.length);
    const toExecute: Array<{ index: number; task: WebhookTask }> = [];

    for (let i = 0; i < webhookTasks.length; i++) {
      const task = webhookTasks[i]!;
      const resolvedUrl = expandEnvVars(task.action.url, env);

      if (!this.rateLimiter.allow(resolvedUrl)) {
        log.debug(`[WebhookHandler] Rate-limited: ${redactUrl(resolvedUrl)}`);
        results[i] = {
          type: 'webhook',
          url: resolvedUrl,
          statusCode: 0,
          success: false,
          error: 'Rate-limited: too many requests to this endpoint',
          durationMs: 0,
          attempts: 0,
        };
      } else {
        toExecute.push({ index: i, task });
      }
    }

    // Execute allowed webhook requests in parallel with retry for transient failures
    if (toExecute.length > 0) {
      const webhookOpts = { env, retry: { maxAttempts: 2 } };
      const outcomes = await Promise.allSettled(
        toExecute.map(({ task }) => executeWithRetry(task.action, webhookOpts))
      );

      for (let j = 0; j < outcomes.length; j++) {
        const outcome = outcomes[j]!;
        const { index, task } = toExecute[j]!;

        if (outcome.status === 'fulfilled') {
          results[index] = outcome.value;
        } else {
          results[index] = {
            type: 'webhook',
            url: task.action.url,
            statusCode: 0,
            success: false,
            error: outcome.reason?.message ?? 'Unknown error',
          };
        }
      }
    }

    // Log failures and write history entries
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const task = webhookTasks[i]!;

      if (!result.success) {
        log.debug(`[WebhookHandler] ${result.url} → ${result.error}`);
      }

      // Write history entry for each webhook execution.
      // Await for durability, but keep failures non-fatal.
      const entry = createWebhookHistoryEntry({
        matcherId: task.matcherId,
        ok: result.success,
        method: task.action.method,
        url: result.url,
        statusCode: result.statusCode,
        durationMs: result.durationMs ?? 0,
        attempts: result.attempts,
        error: result.error,
        responseBody: result.responseBody,
      });
      try {
        await appendAutomationHistoryEntry(this.options.workspaceRootPath, entry);
      } catch (e) {
        log.debug(`[WebhookHandler] Failed to write history: ${e}`);
      }

      // Enqueue for deferred retry if it's a transient failure (5xx / timeout)
      // and immediate retries were exhausted (attempts > 1 means retries ran).
      // Pre-expand the action so retries don't need the original event env.
      if (isTransientFailure(result)) {
        if (result.attempts && result.attempts > 1) {
          const expandedAction = expandWebhookAction(task.action, env);
          this.retryScheduler.enqueue(task.matcherId, expandedAction, result.url, result.error)
            .catch(e => log.debug(`[WebhookHandler] Failed to enqueue for deferred retry: ${e}`));
        }
      }
    }

    // Deliver results via callback
    if (results.length > 0 && this.options.onWebhookResults) {
      log.debug(`[WebhookHandler] Delivering ${results.length} webhook results`);
      this.options.onWebhookResults(results);
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    this.rateLimiter.dispose();
    this.retryScheduler.dispose();
    log.debug(`[WebhookHandler] Disposed`);
  }
}
