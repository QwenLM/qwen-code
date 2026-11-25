/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../request/customRequest.js';
import type { CustomResponse } from '../response/customResponse.js';
import type { Pipeline } from './pipeline.js';
import type { Valve } from './valve/valve.js';

/**
 * Ordered valve-chain implementation.
 *
 * The assembly API is intentionally kept on the concrete implementation while
 * consumers can depend on the narrower {@link Pipeline} execution contract.
 */
export class CustomOutboundPipeline implements Pipeline {
  private readonly valves: Map<string, Valve> = new Map();
  private head: Valve | null = null;

  constructor(private readonly initialOutput?: () => CustomResponse) {}

  async execute(input: CustomRequest): Promise<CustomResponse> {
    if (!this.initialOutput) {
      throw new Error('pipeline has no initial output');
    }
    const output = this.initialOutput();
    await this.invoke(input, output);
    return output;
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    if (this.head === null) {
      throw new Error('pipeline is empty');
    }
    await this.head.invoke(input, output);
  }

  /** Insert a valve after `prev`, or at the head when it is omitted. */
  insert(name: string, valve: Valve, prev?: string): void {
    this.register(name, valve);

    const previous = prev === undefined ? undefined : this.valves.get(prev);
    if (!previous) {
      valve.setNext(this.head);
      this.head = valve;
      return;
    }

    valve.setNext(previous.getNext());
    previous.setNext(valve);
  }

  /** Append a valve at the tail, where it executes last. */
  append(name: string, valve: Valve): void {
    this.register(name, valve);
    if (!this.head) {
      this.head = valve;
      return;
    }

    let tail = this.head;
    while (tail.getNext()) {
      tail = tail.getNext()!;
    }
    tail.setNext(valve);
  }

  private register(name: string, valve: Valve): void {
    if (this.valves.has(name)) {
      throw new Error(`valve ${name} already exists`);
    }
    this.valves.set(name, valve);
  }
}
