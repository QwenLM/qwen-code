import type { BackgroundResponseContext } from './ChannelAgentBridge.js';
import type { ChannelOutputMode, SessionTarget } from './types.js';
import { sanitizeLogText } from './sanitize.js';

const BACKGROUND_OUTPUT_TIMEOUT_MS = 10 * 60 * 1000;
const BACKGROUND_OUTPUT_RETRY_MS = 30 * 1000;
const BACKGROUND_OUTPUT_MAX_RETRIES = 3;

export interface BackgroundOutputTarget {
  target: SessionTarget;
  sourceLabel?: string;
}

export interface BackgroundOutputPacket {
  status: string;
  kind: BackgroundResponseContext['kind'];
  label?: string;
  text: string;
  partial: boolean;
  turnComplete: boolean;
}

/**
 * The receipt describes the payload actually sent. A retry of chunks composed
 * before completion must return false so a later terminal result is not lost.
 */
export type BackgroundOutputDelivery = (
  output: BackgroundOutputPacket,
) => Promise<{ turnComplete: boolean }>;

export interface BackgroundOutputCoordinatorOptions {
  outputMode?: ChannelOutputMode;
  getTarget(sessionId: string): SessionTarget | undefined;
  resolveDelivery(
    sessionId: string,
  ): Promise<BackgroundOutputTarget | undefined>;
  createDelivery(
    sessionId: string,
    target: BackgroundOutputTarget,
  ): BackgroundOutputDelivery;
  isRetryableError(error: unknown): boolean;
  log(message: string): void;
}

interface BackgroundResponseAggregation {
  key: string;
  sessionId: string;
  target: SessionTarget;
  sourceLabel?: string;
  status: string;
  kind: BackgroundResponseContext['kind'];
  label?: string;
  text: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  turnComplete?: boolean;
  completionPartial?: boolean;
  retiring?: boolean;
  flushing?: boolean;
  delivered?: boolean;
  /** Whether a result was already delivered after the turn completed. */
  completionDelivered?: boolean;
  /** Whether a give-up ever discarded buffered text for this turn. */
  dropped?: boolean;
  /** Whether target resolution discarded a segment before aggregation. */
  resolutionDropped?: boolean;
  delivery?: BackgroundResponseDelivery;
}

/** Background response segments waiting for target resolution. */
interface PendingBackgroundResponseTerminal {
  sessionId: string;
  target: SessionTarget;
  resolvers: number;
  held: Array<{
    text: string;
    context: BackgroundResponseContext;
  }>;
  turnComplete?: boolean;
  status?: string;
  label?: string;
  completionPartial?: boolean;
  resolutionDropped?: boolean;
  retryAttempts?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryInFlight?: boolean;
  retiring?: boolean;
  turnEnded?: boolean;
}

interface BackgroundResponseDelivery
  extends Omit<BackgroundOutputPacket, 'turnComplete'> {
  attempts: number;
  send: BackgroundOutputDelivery;
}

export class BackgroundOutputCoordinator {
  private readonly backgroundResponseAggregations = new Map<
    string,
    BackgroundResponseAggregation
  >();
  private readonly detachedBackgroundResponseAggregations =
    new Set<BackgroundResponseAggregation>();
  private readonly pendingBackgroundResponseTerminals = new Map<
    string,
    PendingBackgroundResponseTerminal
  >();
  private readonly detachedPendingBackgroundResponseTerminals =
    new Set<PendingBackgroundResponseTerminal>();

  constructor(private readonly options: BackgroundOutputCoordinatorOptions) {}

  /** False leaves delivery to the adapter's immediate response path. */
  async dispatch(
    sessionId: string,
    text: string,
    context?: BackgroundResponseContext,
  ): Promise<boolean> {
    if (
      (this.options.outputMode !== 'per_turn' &&
        this.options.outputMode !== 'per_task') ||
      !context ||
      typeof context.turnComplete !== 'boolean'
    ) {
      return false;
    }
    await this.collect(sessionId, text, context);
    return true;
  }

  private async collect(
    sessionId: string,
    text: string,
    context: BackgroundResponseContext,
  ): Promise<void> {
    const target = this.options.getTarget(sessionId);
    if (!target) return;
    const key = JSON.stringify([
      sessionId,
      context.kind,
      context.taskId,
      context.turnId,
    ]);
    let current = this.backgroundResponseAggregations.get(key);
    let parked = this.pendingBackgroundResponseTerminals.get(key);
    if (current?.turnComplete === true) {
      this.detachedBackgroundResponseAggregations.add(current);
      this.backgroundResponseAggregations.delete(key);
      current = undefined;
    }
    if (
      !current &&
      (parked?.turnEnded === true ||
        (parked?.turnComplete === true &&
          (parked.retryTimer || parked.retryInFlight || parked.resolvers > 0)))
    ) {
      if (!parked.turnEnded) {
        this.detachedPendingBackgroundResponseTerminals.add(parked);
      }
      parked = { sessionId, target, resolvers: 0, held: [] };
      this.pendingBackgroundResponseTerminals.set(key, parked);
    }
    if (!current && text.trim().length === 0) {
      // The first segment's target resolution can suspend (named-session owner
      // lock), so a turn's terminal marker may arrive before the aggregation
      // exists. Park it instead of routing it to the empty-text early return,
      // or the completed turn only surfaces via the bounded wait, mislabeled.
      if (
        !parked ||
        (parked.resolvers === 0 &&
          !parked.retryTimer &&
          !parked.retryInFlight &&
          !parked.resolutionDropped &&
          !parked.turnComplete)
      ) {
        if (parked) this.pendingBackgroundResponseTerminals.delete(key);
        return;
      }
      if (context.turnComplete) {
        parked.turnComplete = true;
        parked.status = context.status;
        parked.label = context.label ?? parked.label;
        parked.completionPartial = context.partial === true;
        if (
          parked.resolvers === 0 &&
          !parked.retryTimer &&
          !parked.retryInFlight &&
          (parked.retryAttempts ?? 0) >= BACKGROUND_OUTPUT_MAX_RETRIES
        ) {
          parked.turnEnded = true;
          this.pendingBackgroundResponseTerminals.delete(key);
        }
      }
      return;
    }
    if (!current) {
      parked ??= { sessionId, target, resolvers: 0, held: [] };
      this.pendingBackgroundResponseTerminals.set(key, parked);
      this.holdPendingBackgroundResponse(parked, text, context);
      parked.resolvers++;
      try {
        let delivery: BackgroundOutputTarget | undefined;
        try {
          delivery = await this.options.resolveDelivery(sessionId);
        } catch (error) {
          if (
            parked.resolvers === 1 &&
            !this.backgroundResponseAggregations.has(key)
          ) {
            this.scheduleBackgroundResponseResolutionRetry(
              key,
              sessionId,
              parked,
            );
          } else {
            const existing = this.backgroundResponseAggregations.get(key);
            if (existing) {
              if (parked.held.length > 0) {
                this.applyHeldBackgroundResponses(existing, parked);
              }
              this.applyPendingBackgroundResponseTerminal(existing, parked);
              if (parked.resolvers === 1) {
                if (existing.turnComplete) {
                  await this.completeBackgroundResponseAggregation(
                    key,
                    existing,
                  );
                } else {
                  this.scheduleBackgroundResponseAggregationFlush(
                    key,
                    existing,
                  );
                }
              }
            }
          }
          throw error;
        }
        if (
          !delivery ||
          this.options.getTarget(sessionId) !== delivery.target
        ) {
          if (
            parked.resolvers === 1 &&
            !this.backgroundResponseAggregations.has(key)
          ) {
            this.scheduleBackgroundResponseResolutionRetry(
              key,
              sessionId,
              parked,
            );
          } else {
            const existing = this.backgroundResponseAggregations.get(key);
            if (existing) {
              if (parked.held.length > 0) {
                this.applyHeldBackgroundResponses(existing, parked);
              }
              this.applyPendingBackgroundResponseTerminal(existing, parked);
              if (parked.resolvers === 1) {
                if (existing.turnComplete) {
                  await this.completeBackgroundResponseAggregation(
                    key,
                    existing,
                  );
                } else {
                  this.scheduleBackgroundResponseAggregationFlush(
                    key,
                    existing,
                  );
                }
              }
            }
          }
          return;
        }
        if (
          parked.retiring ||
          this.pendingBackgroundResponseTerminals.get(key) !== parked
        ) {
          await this.flushDetachedBackgroundResponse(
            key,
            sessionId,
            parked,
            delivery,
          );
          return;
        }
        if (parked.retryTimer) {
          clearTimeout(parked.retryTimer);
          parked.retryTimer = undefined;
        }
        current =
          this.backgroundResponseAggregations.get(key) ??
          this.createBackgroundResponseAggregation(
            key,
            sessionId,
            parked.held[0]?.context ?? context,
            delivery.target,
            delivery.sourceLabel,
          );
        this.applyHeldBackgroundResponses(current, parked);
        this.applyPendingBackgroundResponseTerminal(current, parked);
        if (parked.resolutionDropped) {
          current.resolutionDropped = true;
          parked.resolutionDropped = undefined;
        }
      } finally {
        parked.resolvers--;
        if (
          this.pendingBackgroundResponseTerminals.get(key) === parked &&
          parked.resolvers === 0 &&
          !parked.retryTimer &&
          parked.held.length === 0 &&
          (!parked.resolutionDropped || parked.turnEnded)
        ) {
          this.pendingBackgroundResponseTerminals.delete(key);
        }
      }
      if (!current) return;
      if (current.turnComplete && parked.resolvers > 0) return;
      if (!current.turnComplete) {
        this.scheduleBackgroundResponseAggregationFlush(key, current);
      } else {
        await this.completeBackgroundResponseAggregation(key, current);
      }
      return;
    }

    current.status = context.status;
    current.label = context.label ?? current.label;
    if (text.trim()) current.text = text;

    if (context.turnComplete && parked && parked.resolvers > 0) {
      parked.turnComplete = true;
      parked.status = context.status;
      parked.label = context.label ?? parked.label;
      parked.completionPartial = context.partial === true;
    } else if (context.turnComplete) {
      current.turnComplete = true;
      current.completionPartial = context.partial === true;
    } else if (parked?.turnComplete && parked.resolvers === 0) {
      current.turnComplete = true;
      current.status = parked.status ?? current.status;
      current.label = parked.label ?? current.label;
      current.completionPartial = parked.completionPartial === true;
    }
    current.resolutionDropped ||= parked?.resolutionDropped;

    if (!current.turnComplete) {
      this.scheduleBackgroundResponseAggregationFlush(key, current);
      return;
    }

    await this.completeBackgroundResponseAggregation(key, current);
  }

  private async flushBackgroundResponseAggregation(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): Promise<void> {
    if (
      (this.backgroundResponseAggregations.get(key) !== aggregation &&
        !this.detachedBackgroundResponseAggregations.has(aggregation)) ||
      aggregation.flushing
    ) {
      return;
    }
    if (aggregation.retryTimer) clearTimeout(aggregation.retryTimer);
    aggregation.retryTimer = undefined;

    let delivery = aggregation.delivery;
    if (!delivery) {
      if (!aggregation.text) {
        // A turn whose text was already drained by the bounded wait still owes
        // the user its completion: the last delivery was marked partial.
        if (!this.owesTerminalBackgroundResponse(aggregation)) {
          if (aggregation.retiring || aggregation.turnComplete) {
            this.removeBackgroundResponseAggregation(key, aggregation);
          } else {
            this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
          }
          return;
        }
      }
      if (aggregation.timeoutTimer) clearTimeout(aggregation.timeoutTimer);
      aggregation.timeoutTimer = undefined;
      const text = aggregation.text;
      aggregation.text = '';
      delivery = {
        status: aggregation.status,
        kind: aggregation.kind,
        label: aggregation.label,
        text,
        partial: this.isPartialBackgroundResponseDelivery(
          aggregation,
          text.length > 0,
        ),
        attempts: 0,
        send: this.options.createDelivery(aggregation.sessionId, {
          target: aggregation.target,
          sourceLabel: aggregation.sourceLabel,
        }),
      };
      aggregation.delivery = delivery;
    }

    aggregation.flushing = true;
    let error: unknown;
    let composedTurnComplete = false;
    try {
      const result = await delivery.send({
        status: delivery.status,
        kind: delivery.kind,
        label: delivery.label,
        text: delivery.text,
        partial: delivery.partial,
        turnComplete: aggregation.turnComplete === true,
      });
      composedTurnComplete = result.turnComplete;
    } catch (caught) {
      error = caught;
    } finally {
      aggregation.flushing = false;
    }

    if (error === undefined) {
      aggregation.delivery = undefined;
      aggregation.delivered = true;
      if (
        composedTurnComplete &&
        aggregation.turnComplete &&
        delivery.partial !== true &&
        !aggregation.retiring
      ) {
        aggregation.completionDelivered = true;
      }
      if (aggregation.retiring || aggregation.turnComplete) {
        await this.flushBackgroundResponseAggregation(key, aggregation);
      } else {
        // The turn is still open: keep the entry so its later segments re-join
        // this one (and stay partial), and re-arm the bounded wait
        // so a silent turn is still reaped.
        this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
      }
      return;
    }

    delivery.attempts++;
    this.options.log(
      `background response delivery failed (attempt ${delivery.attempts}): ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}\n`,
    );
    if (
      delivery.attempts >= BACKGROUND_OUTPUT_MAX_RETRIES ||
      // A permanently rejected send cannot
      // succeed later; retrying it only spends the chat's send quota.
      !this.options.isRetryableError(error)
    ) {
      aggregation.delivery = undefined;
      aggregation.dropped = true;
      if (!aggregation.text) {
        if (aggregation.retiring || aggregation.turnComplete) {
          this.removeBackgroundResponseAggregation(key, aggregation);
        } else {
          this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
        }
      } else if (aggregation.retiring || aggregation.turnComplete) {
        await this.flushBackgroundResponseAggregation(key, aggregation);
      } else {
        this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
      }
      return;
    }

    aggregation.retryTimer = setTimeout(() => {
      aggregation.retryTimer = undefined;
      void this.flushBackgroundResponseAggregation(key, aggregation);
    }, BACKGROUND_OUTPUT_RETRY_MS);
    aggregation.retryTimer.unref?.();
  }

  /**
   * A delivery is partial whenever it is not the turn's whole output: the
   * turn is still open, earlier text already went out (or was given up on),
   * or the turn itself ended early.
   */
  private isPartialBackgroundResponseDelivery(
    aggregation: BackgroundResponseAggregation,
    hasText: boolean,
  ): boolean {
    return (
      hasText &&
      (aggregation.delivered === true ||
        aggregation.dropped === true ||
        aggregation.resolutionDropped === true ||
        aggregation.retiring === true ||
        aggregation.completionPartial === true ||
        aggregation.turnComplete !== true)
    );
  }

  /**
   * If a turn outlives the bounded wait, its final empty marker still needs
   * a terminal delivery so recipients learn that the partial output finished.
   */
  private owesTerminalBackgroundResponse(
    aggregation: BackgroundResponseAggregation,
  ): boolean {
    return (
      aggregation.turnComplete === true &&
      aggregation.delivered === true &&
      aggregation.completionDelivered !== true &&
      aggregation.retiring !== true &&
      aggregation.completionPartial !== true &&
      aggregation.dropped !== true &&
      aggregation.resolutionDropped !== true
    );
  }

  private removeBackgroundResponseAggregation(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): void {
    if (this.backgroundResponseAggregations.get(key) === aggregation) {
      this.backgroundResponseAggregations.delete(key);
    }
    this.detachedBackgroundResponseAggregations.delete(aggregation);
  }

  drain(sessionId?: string): void {
    for (const [key, pending] of this.pendingBackgroundResponseTerminals) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      pending.retryTimer = undefined;
      pending.retiring = true;
      pending.turnComplete = true;
      pending.completionPartial = true;
      this.pendingBackgroundResponseTerminals.delete(key);
      this.detachedPendingBackgroundResponseTerminals.add(pending);
    }
    for (const pending of this.detachedPendingBackgroundResponseTerminals) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      pending.retryTimer = undefined;
      pending.retiring = true;
      pending.turnComplete = true;
      pending.completionPartial = true;
      if (
        pending.held.length > 0 &&
        this.options.getTarget(pending.sessionId) === pending.target
      ) {
        void this.flushDetachedBackgroundResponse(
          '',
          pending.sessionId,
          pending,
          { target: pending.target },
        ).catch((error) => {
          this.options.log(
            `background response delivery failed during drain: ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}\n`,
          );
        });
      } else if (pending.held.length > 0) {
        this.options.log(
          `background response target unavailable during drain; ${pending.held.length} buffered segment(s) discarded\n`,
        );
        pending.held.length = 0;
        this.detachedPendingBackgroundResponseTerminals.delete(pending);
      } else if (pending.held.length === 0) {
        this.detachedPendingBackgroundResponseTerminals.delete(pending);
      }
    }
    const aggregations = new Set([
      ...this.backgroundResponseAggregations.values(),
      ...this.detachedBackgroundResponseAggregations,
    ]);
    for (const aggregation of aggregations) {
      if (sessionId !== undefined && aggregation.sessionId !== sessionId) {
        continue;
      }
      if (aggregation.timeoutTimer) clearTimeout(aggregation.timeoutTimer);
      if (aggregation.retryTimer) clearTimeout(aggregation.retryTimer);
      aggregation.timeoutTimer = undefined;
      aggregation.retryTimer = undefined;
      aggregation.retiring = true;
      aggregation.turnComplete = true;
      aggregation.completionPartial = true;
      if (!aggregation.flushing) {
        void this.flushBackgroundResponseAggregation(
          aggregation.key,
          aggregation,
        );
      }
    }
  }

  private createBackgroundResponseAggregation(
    key: string,
    sessionId: string,
    context: BackgroundResponseContext,
    target: SessionTarget,
    sourceLabel?: string,
  ): BackgroundResponseAggregation {
    const aggregation: BackgroundResponseAggregation = {
      key,
      sessionId,
      target,
      sourceLabel,
      status: context.status,
      kind: context.kind,
      label: context.label,
      text: '',
    };
    this.backgroundResponseAggregations.set(key, aggregation);
    return aggregation;
  }

  private scheduleBackgroundResponseResolutionRetry(
    key: string,
    sessionId: string,
    pending: PendingBackgroundResponseTerminal,
  ): void {
    if (pending.retiring) return;
    if (pending.retryTimer) return;
    pending.retryAttempts = (pending.retryAttempts ?? 0) + 1;
    if (pending.retryAttempts >= BACKGROUND_OUTPUT_MAX_RETRIES) {
      pending.resolutionDropped = true;
      pending.turnEnded = pending.turnComplete === true;
      pending.held.length = 0;
      pending.turnComplete = undefined;
      pending.status = undefined;
      pending.label = undefined;
      pending.completionPartial = undefined;
      if (pending.turnEnded) {
        this.detachedPendingBackgroundResponseTerminals.delete(pending);
      }
      return;
    }
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined;
      pending.retryInFlight = true;
      void this.retryBackgroundResponseResolution(key, sessionId, pending)
        .catch((error: unknown) => {
          this.options.log(
            `background response target resolution failed: ${sanitizeLogText(error instanceof Error ? error.message : String(error), 300)}\n`,
          );
        })
        .finally(() => {
          pending.retryInFlight = false;
          if (
            pending.retiring ||
            (!pending.retryTimer && !pending.resolutionDropped)
          ) {
            this.detachedPendingBackgroundResponseTerminals.delete(pending);
          }
          if (
            this.pendingBackgroundResponseTerminals.get(key) === pending &&
            pending.resolvers === 0 &&
            !pending.retryTimer &&
            pending.held.length === 0 &&
            (!pending.resolutionDropped || pending.turnEnded)
          ) {
            this.pendingBackgroundResponseTerminals.delete(key);
          }
        });
    }, BACKGROUND_OUTPUT_RETRY_MS);
    pending.retryTimer.unref?.();
    const active = this.pendingBackgroundResponseTerminals.get(key);
    if (!active || active === pending) {
      this.pendingBackgroundResponseTerminals.set(key, pending);
    }
  }

  private async retryBackgroundResponseResolution(
    key: string,
    sessionId: string,
    pending: PendingBackgroundResponseTerminal,
  ): Promise<void> {
    let delivery: BackgroundOutputTarget | undefined;
    try {
      delivery = await this.options.resolveDelivery(sessionId);
    } catch (error) {
      if (
        (this.pendingBackgroundResponseTerminals.get(key) === pending &&
          !this.backgroundResponseAggregations.has(key)) ||
        this.detachedPendingBackgroundResponseTerminals.has(pending)
      ) {
        this.scheduleBackgroundResponseResolutionRetry(key, sessionId, pending);
      }
      throw error;
    }
    if (!delivery || this.options.getTarget(sessionId) !== delivery.target) {
      if (pending.retiring) {
        if (pending.held.length > 0) {
          this.options.log(
            `background response target unavailable during drain; ${pending.held.length} buffered segment(s) discarded\n`,
          );
        }
        pending.held.length = 0;
        this.detachedPendingBackgroundResponseTerminals.delete(pending);
        return;
      }
      if (
        (this.pendingBackgroundResponseTerminals.get(key) === pending &&
          !this.backgroundResponseAggregations.has(key)) ||
        this.detachedPendingBackgroundResponseTerminals.has(pending)
      ) {
        this.scheduleBackgroundResponseResolutionRetry(key, sessionId, pending);
      }
      return;
    }
    if (
      pending.retiring ||
      this.pendingBackgroundResponseTerminals.get(key) !== pending ||
      pending.turnComplete
    ) {
      await this.flushDetachedBackgroundResponse(
        key,
        sessionId,
        pending,
        delivery,
      );
      return;
    }

    const first = pending.held[0];
    if (!first) return;
    const aggregation = this.createBackgroundResponseAggregation(
      key,
      sessionId,
      first.context,
      delivery.target,
      delivery.sourceLabel,
    );
    this.applyHeldBackgroundResponses(aggregation, pending);
    if (pending.resolutionDropped) {
      aggregation.resolutionDropped = true;
      pending.resolutionDropped = undefined;
    }
    if (this.pendingBackgroundResponseTerminals.get(key) === pending) {
      this.pendingBackgroundResponseTerminals.delete(key);
    }
    this.scheduleBackgroundResponseAggregationFlush(key, aggregation);
  }

  private holdPendingBackgroundResponse(
    pending: PendingBackgroundResponseTerminal,
    text: string,
    context: BackgroundResponseContext,
  ): void {
    if (text.trim().length > 0) pending.held.push({ text, context });
    if (context.turnComplete) {
      pending.turnComplete = true;
      pending.status = context.status;
      pending.label = context.label ?? pending.label;
      pending.completionPartial = context.partial === true;
    }
  }

  private applyHeldBackgroundResponses(
    aggregation: BackgroundResponseAggregation,
    pending: PendingBackgroundResponseTerminal,
  ): void {
    for (const { text, context } of pending.held.splice(0)) {
      aggregation.status = context.status;
      aggregation.label = context.label ?? aggregation.label;
      if (text.trim()) aggregation.text = text;
      if (context.turnComplete) {
        aggregation.turnComplete = true;
        aggregation.completionPartial = context.partial === true;
      }
    }
  }

  private applyPendingBackgroundResponseTerminal(
    aggregation: BackgroundResponseAggregation,
    pending: PendingBackgroundResponseTerminal,
  ): void {
    if (!pending.turnComplete) return;
    aggregation.turnComplete = true;
    aggregation.status = pending.status ?? aggregation.status;
    aggregation.label = pending.label ?? aggregation.label;
    aggregation.completionPartial = pending.completionPartial === true;
    pending.turnComplete = undefined;
    pending.status = undefined;
    pending.label = undefined;
    pending.completionPartial = undefined;
  }

  private async completeBackgroundResponseAggregation(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): Promise<void> {
    if (aggregation.delivery) {
      aggregation.delivery.status = aggregation.status;
      aggregation.delivery.label =
        aggregation.label ?? aggregation.delivery.label;
      aggregation.delivery.partial =
        this.isPartialBackgroundResponseDelivery(
          aggregation,
          aggregation.delivery.text.length > 0,
        ) || aggregation.text.length > 0;
    }
    if (aggregation.timeoutTimer) clearTimeout(aggregation.timeoutTimer);
    aggregation.timeoutTimer = undefined;
    await this.flushBackgroundResponseAggregation(key, aggregation);
  }

  private async flushDetachedBackgroundResponse(
    key: string,
    sessionId: string,
    pending: PendingBackgroundResponseTerminal,
    delivery: BackgroundOutputTarget,
  ): Promise<void> {
    const first = pending.held[0];
    if (!first) {
      this.detachedPendingBackgroundResponseTerminals.delete(pending);
      return;
    }
    const aggregation: BackgroundResponseAggregation = {
      key,
      sessionId,
      target: delivery.target,
      sourceLabel: delivery.sourceLabel,
      status: first.context.status,
      kind: first.context.kind,
      label: first.context.label,
      text: '',
      turnComplete: pending.turnComplete,
      completionPartial: pending.completionPartial,
      resolutionDropped: pending.resolutionDropped,
    };
    this.applyHeldBackgroundResponses(aggregation, pending);
    aggregation.status = pending.status ?? aggregation.status;
    aggregation.label = pending.label ?? aggregation.label;
    if (this.pendingBackgroundResponseTerminals.get(key) === pending) {
      this.pendingBackgroundResponseTerminals.delete(key);
    }
    this.detachedPendingBackgroundResponseTerminals.delete(pending);
    this.detachedBackgroundResponseAggregations.add(aggregation);
    await this.flushBackgroundResponseAggregation(key, aggregation);
  }

  private scheduleBackgroundResponseAggregationFlush(
    key: string,
    aggregation: BackgroundResponseAggregation,
  ): void {
    if (aggregation.timeoutTimer || aggregation.delivery) return;
    aggregation.timeoutTimer = setTimeout(() => {
      aggregation.timeoutTimer = undefined;
      void this.flushBackgroundResponseAggregation(key, aggregation);
    }, BACKGROUND_OUTPUT_TIMEOUT_MS);
    aggregation.timeoutTimer.unref?.();
  }
}
