/**
 * EventLogHandler - Logs all automation events to events.jsonl
 *
 * Subscribes to all events and logs them for audit trail and replay.
 * Uses the existing AutomationEventLogger for buffered I/O.
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, EventLogHandlerOptions } from './types.ts';
import type { AutomationEvent } from '../types.ts';
import { AutomationEventLogger } from '../event-logger.ts';

const log = createLogger('event-log-handler');

// ============================================================================
// EventLogHandler Implementation
// ============================================================================

export class EventLogHandler implements AutomationHandler {
  private readonly options: EventLogHandlerOptions;
  private readonly logger: AutomationEventLogger;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: EventLogHandlerOptions) {
    this.options = options;
    this.logger = new AutomationEventLogger(options.workspaceRootPath);

    // Forward event loss callback if provided
    if (options.onEventLost) {
      this.logger.onEventLost = options.onEventLost;
    }
  }

  /**
   * Subscribe to all events on the bus.
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug(`[EventLogHandler] Subscribed to event bus, logging to ${this.logger.getLogPath()}`);
  }

  /**
   * Handle an event by logging it.
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    const startTime = payload.timestamp;
    const durationMs = Date.now() - startTime;

    this.logger.log({
      type: event,
      sessionId: payload.sessionId,
      workspaceId: this.options.workspaceId,
      data: { ...payload },
      results: [], // Results are logged separately by handlers that produce them
      durationMs,
    });

    log.debug(`[EventLogHandler] Logged: ${event}`);
  }

  /**
   * Get the path to the event log file.
   */
  getLogPath(): string {
    return this.logger.getLogPath();
  }

  /**
   * Clean up resources.
   */
  async dispose(): Promise<void> {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;

    // Flush and close the logger
    await this.logger.dispose();
    log.debug(`[EventLogHandler] Disposed`);
  }
}
