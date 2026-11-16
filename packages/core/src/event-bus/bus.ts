/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  AnyBusEvent,
  BusEvent,
  HandlerName,
  LoopBusEventMap,
  LoopBusEventType,
} from './events.js';

const debugLogger = createDebugLogger('EVENT_BUS');

type Listener = (event: AnyBusEvent) => void | Promise<void>;

interface Subscription {
  readonly name: string;
  readonly source: HandlerName;
  readonly types: ReadonlySet<LoopBusEventType>;
  readonly runId?: string;
  readonly listener: Listener;
}

export interface SubscribeOptions {
  /** Delivery serialization identity; defaults to `source`. */
  name?: string;
  /** Only receive events of this run. */
  runId?: string;
}

export type PublishInput<T extends LoopBusEventType> = Omit<
  BusEvent<T>,
  'eventId'
> & { eventId?: string };

/**
 * Delivery only: routes by runId, never touches run state.
 *
 * Events for one subscriber and one run are delivered serially in publish
 * order; different runs never block each other. A listener that throws or
 * rejects is reported as `handler.failed`.
 *
 * Ported from the v1.0.0-preview `QueryEventBus` (587e3429cabf), with the
 * routing key renamed from queryId to runId to match main's agent loop.
 */
export class LoopEventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly chains = new Map<string, Promise<void>>();

  subscribe(
    source: HandlerName,
    types: readonly LoopBusEventType[],
    listener: Listener,
    options: SubscribeOptions = {},
  ): () => void {
    const subscription: Subscription = {
      name: options.name ?? source,
      source,
      types: new Set(types),
      runId: options.runId,
      listener,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish<T extends LoopBusEventType>(input: PublishInput<T>): void {
    const event = {
      ...input,
      eventId: input.eventId ?? randomUUID(),
    } as AnyBusEvent;
    for (const subscription of this.subscriptions) {
      if (!subscription.types.has(event.type)) continue;
      if (
        subscription.runId !== undefined &&
        subscription.runId !== event.runId
      ) {
        continue;
      }
      this.deliver(subscription, event);
    }
  }

  /** Report a failure of work a listener started but did not await. */
  reportFailure(source: HandlerName, event: AnyBusEvent, error: unknown): void {
    if (event.type === 'handler.failed') {
      debugLogger.warn(
        `[LoopEventBus] ${source} failed while handling handler.failed:`,
        error,
      );
      return;
    }
    this.publish({
      type: 'handler.failed',
      runId: event.runId,
      promptId: event.promptId,
      round: event.round,
      data: {
        source,
        eventType: event.type,
        round: event.round,
        error,
      },
    });
  }

  private deliver(subscription: Subscription, event: AnyBusEvent): void {
    const key = `${subscription.name}\u0000${event.runId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await subscription.listener(event);
      } catch (error) {
        this.reportFailure(subscription.source, event, error);
      }
    });
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }
}

export function createBusEvent<T extends LoopBusEventType>(
  type: T,
  base: Pick<BusEvent, 'runId' | 'promptId'>,
  data: LoopBusEventMap[T],
  round?: number,
): PublishInput<T> {
  return {
    type,
    runId: base.runId,
    ...(base.promptId !== undefined ? { promptId: base.promptId } : {}),
    ...(round !== undefined ? { round } : {}),
    data,
  };
}
