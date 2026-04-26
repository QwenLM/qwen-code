/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadState } from './types.js';

export function StatusPill({ state }: { state: LoadState['state'] }) {
  const label = getStatusLabel(state);

  return (
    <span
      className={`status-pill status-pill-${state}`}
      aria-label={`Runtime ${label}`}
      data-testid="topbar-runtime-status"
      title={`Runtime ${label}`}
    >
      <span className="status-pill-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function getStatusLabel(state: LoadState['state']): string {
  if (state === 'ready') {
    return 'Ready';
  }

  if (state === 'loading') {
    return 'Loading';
  }

  return 'Error';
}
