/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadState } from './types.js';

export function StatusPill({ state }: { state: LoadState['state'] }) {
  return <span className={`status-pill status-pill-${state}`}>{state}</span>;
}
