/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense } from 'react';
import type { ThreadsRouteProps } from './ThreadsRoute';

const ThreadsRoute = lazy(async () => {
  const module = await import('./ThreadsRoute');
  return { default: module.ThreadsRoute };
});

export function LazyThreadsRoute(props: ThreadsRouteProps) {
  return (
    <Suspense fallback={null}>
      <ThreadsRoute {...props} />
    </Suspense>
  );
}
