/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_EVENT_LOG_LIMIT, type RemoteEvent } from './protocol.js';

export interface EventLogReplay {
  events: RemoteEvent[];
  truncated: boolean;
}

export class EventLog {
  private readonly limit: number;
  private nextSeq = 1;
  private events: RemoteEvent[] = [];

  constructor(limit: number = DEFAULT_EVENT_LOG_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  append<TPayload>(
    sessionId: string,
    type: string,
    payload: TPayload,
  ): RemoteEvent<TPayload> {
    const event: RemoteEvent<TPayload> = {
      id: randomUUID(),
      seq: this.nextSeq++,
      sessionId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    };

    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events = this.events.slice(this.events.length - this.limit);
    }
    return event;
  }

  replay(since?: number): EventLogReplay {
    if (since === undefined) {
      return { events: [...this.events], truncated: false };
    }

    const firstSeq = this.events[0]?.seq;
    const truncated = firstSeq !== undefined && since < firstSeq - 1;
    return {
      events: this.events.filter((event) => event.seq > since),
      truncated,
    };
  }

  getLastSeq(): number {
    return this.nextSeq - 1;
  }
}
