/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../request/customRequest.js';
import type { CustomResponse } from '../response/customResponse.js';
import type { Valve } from './valve/valve.js';

/** An ordered request pipeline with caller-owned output. */
export interface Pipeline {
  execute(input: CustomRequest): Promise<CustomResponse>;
  invoke(input: CustomRequest, output: CustomResponse): Promise<void>;

  /** Insert a valve after `prev`, or at the head when it is omitted. */
  insert(name: string, valve: Valve, prev?: string): void;

  /** Append a valve at the tail, where it executes last. */
  append(name: string, valve: Valve): void;
}
