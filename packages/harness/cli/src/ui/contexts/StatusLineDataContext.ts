/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext } from 'react';
import type { StatusLineCommandInput } from '@qwen-code/core';

export interface StatusLineData {
  /** Stable across equal snapshots so polling does not spawn extra commands. */
  readonly fingerprint: string;
  buildInput(input: StatusLineCommandInput): StatusLineCommandInput;
}

/** Product-owned input transformation for user-configured status scripts. */
export const StatusLineDataContext = createContext<StatusLineData | undefined>(
  undefined,
);
