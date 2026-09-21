/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TrajectoryPageLoader,
  TrajectoryPageResult,
} from './useTrajectoryWindow';

/**
 * The one client method this view needs. Narrower than `DaemonClient` so the
 * trajectory modules stay independent of the rest of its surface.
 */
export interface TrajectoryTranscriptClient {
  getSessionTranscriptPage(
    sessionId: string,
    opts: {
      cursor?: string;
      direction?: 'backward';
      limit?: number;
    },
  ): Promise<TrajectoryPageResult>;
}

const LOADERS = new WeakMap<
  TrajectoryTranscriptClient,
  Map<string, TrajectoryPageLoader>
>();

/**
 * A page loader for one session, stable per (client, session).
 *
 * Identity matters: the loader is the window hook's effect dependency, so a
 * fresh function on every render would refetch the newest page on every render.
 *
 * Reads run newest-page-first and walk backwards by cursor, which is also the
 * order the reader wants — the newest turn is the one they just watched run.
 * It deliberately goes through the raw client rather than
 * `DaemonSessionClient.getTranscriptPage`, which hydrates attachments and would
 * fetch image bytes this table never shows, and it never asks for the
 * `summary` projection, which rewrites the event stream the timing frames sit
 * in.
 */
export function createTrajectoryPageLoader(
  client: TrajectoryTranscriptClient,
  sessionId: string,
): TrajectoryPageLoader {
  let bySession = LOADERS.get(client);
  if (!bySession) {
    bySession = new Map();
    LOADERS.set(client, bySession);
  }
  const existing = bySession.get(sessionId);
  if (existing) return existing;
  const loader: TrajectoryPageLoader = ({ cursor, limit }) =>
    client.getSessionTranscriptPage(sessionId, {
      ...(cursor !== undefined
        ? { cursor }
        : { direction: 'backward' as const }),
      limit,
    });
  bySession.set(sessionId, loader);
  return loader;
}
