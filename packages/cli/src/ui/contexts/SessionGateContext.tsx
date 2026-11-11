/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

import type { SessionGate } from '../sessionGate.js';

/** Product-provided session gate; undefined keeps the session ungated. */
export const SessionGateContext = createContext<SessionGate | undefined>(
  undefined,
);

export function useSessionGate(): SessionGate | undefined {
  return useContext(SessionGateContext);
}
