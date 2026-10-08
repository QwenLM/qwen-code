/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense } from 'react';
import type { AgentsRouteProps } from './agents-route';

// The roster, runtime and enrollment UI loads on first visit, so none of it
// sits in the main chunk.
const AgentsRoute = lazy(async () => {
  const module = await import('./agents-route');
  return { default: module.AgentsRoute };
});

export function LazyAgentsRoute(props: AgentsRouteProps) {
  return (
    <Suspense fallback={null}>
      <AgentsRoute {...props} />
    </Suspense>
  );
}
