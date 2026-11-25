/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';

/** One stage in an ordered request pipeline. */
export interface Valve {
  invoke(input: CustomRequest, output: CustomResponse): Promise<void>;
  getNext(): Valve | null;
  setNext(valve: Valve | null): void;
}

/** Common next-stage ownership for valve implementations. */
export abstract class BaseValve implements Valve {
  private next: Valve | null = null;

  getNext(): Valve | null {
    return this.next;
  }

  setNext(valve: Valve | null): void {
    this.next = valve;
  }

  abstract invoke(input: CustomRequest, output: CustomResponse): Promise<void>;
}
