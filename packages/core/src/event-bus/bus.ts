/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { runLogger } from '../utils/runLogger.js';
import type {
  AnyBusEvent,
  BusEvent,
  HandlerName,
  QueryBusEventMap,
  QueryBusEventType,
} from './events.js';

type Listener = (event: AnyBusEvent) => void | Promise<void>;

interface Subscription {
  readonly name: string;
  readonly source: HandlerName;
  readonly types: ReadonlySet<QueryBusEventType>;
  readonly queryId?: string;
  readonly listener: Listener;
}

export interface SubscribeOptions {
  /** Delivery serialization identity; defaults to `source`. */
  name?: string;
  /** Only receive events of this query. */
  queryId?: string;
}

export type PublishInput<T extends QueryBusEventType> = Omit<
  BusEvent<T>,
  'eventId'
> & { eventId?: string };

/**
 * Delivery only: routes by queryId, never touches query state.
 *
 * Events for one subscriber and one query are delivered serially in publish
 * order; different queries never block each other. A listener that throws or
 * rejects is reported as `handler.failed`.
 */
export class QueryEventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly chains = new Map<string, Promise<void>>();

  subscribe(
    source: HandlerName,
    types: readonly QueryBusEventType[],
    listener: Listener,
    options: SubscribeOptions = {},
  ): () => void {
    const subscription: Subscription = {
      name: options.name ?? source,
      source,
      types: new Set(types),
      queryId: options.queryId,
      listener,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish<T extends QueryBusEventType>(input: PublishInput<T>): void {
    const event = {
      ...input,
      eventId: input.eventId ?? randomUUID(),
    } as AnyBusEvent;
    for (const subscription of this.subscriptions) {
      if (!subscription.types.has(event.type)) continue;
      if (
        subscription.queryId !== undefined &&
        subscription.queryId !== event.queryId
      ) {
        continue;
      }
      this.deliver(subscription, event);
    }
  }

  /** Report a failure of work a listener started but did not await. */
  reportFailure(
    source: HandlerName,
    event: AnyBusEvent,
    error: unknown,
  ): void {
    if (event.type === 'handler.failed') {
      runLogger.warn(
        `[QueryEventBus] ${source} failed while handling handler.failed:`,
        error,
      );
      return;
    }
    this.publish({
      type: 'handler.failed',
      sessionId: event.sessionId,
      queryId: event.queryId,
      parentQueryId: event.parentQueryId,
      roundId: event.roundId,
      data: {
        source,
        eventType: event.type,
        roundId: event.roundId,
        error,
      },
    });
  }

  private deliver(subscription: Subscription, event: AnyBusEvent): void {
    const key = `${subscription.name}\u0000${event.queryId}`;
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

export function createBusEvent<T extends QueryBusEventType>(
  type: T,
  base: Pick<BusEvent, 'sessionId' | 'queryId' | 'parentQueryId'>,
  data: QueryBusEventMap[T],
  roundId?: string,
): PublishInput<T> {
  return {
    type,
    sessionId: base.sessionId,
    queryId: base.queryId,
    ...(base.parentQueryId !== undefined
      ? { parentQueryId: base.parentQueryId }
      : {}),
    ...(roundId !== undefined ? { roundId } : {}),
    data,
  };
}
