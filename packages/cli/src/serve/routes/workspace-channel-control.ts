/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { ChannelWorkerSnapshot } from '../channel-worker-supervisor.js';
import type { SendBridgeError } from '../server/error-response.js';

interface RegisterWorkspaceChannelControlRoutesDeps {
  getChannelWorkerSnapshot: () => ChannelWorkerSnapshot;
  getChannelWorkerSnapshots?: () => ChannelWorkerSnapshot[];
  reloadChannelWorker: () => Promise<ChannelWorkerSnapshot>;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

export function registerWorkspaceChannelControlRoutes(
  app: Application,
  deps: RegisterWorkspaceChannelControlRoutesDeps,
): void {
  const {
    getChannelWorkerSnapshot,
    getChannelWorkerSnapshots,
    reloadChannelWorker,
    mutate,
    sendBridgeError,
    parseAndValidateClientId,
  } = deps;

  app.post(
    '/workspace/channel/reload',
    mutate({ strict: true }),
    async (req, res) => {
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      const workers = getChannelWorkerSnapshots?.();
      const hasEnabledWorker =
        workers && workers.length > 0
          ? workers.some((worker) => worker.enabled)
          : getChannelWorkerSnapshot().enabled;
      if (!hasEnabledWorker) {
        res.status(409).json({
          error:
            'This daemon has no channel worker to reload. Start it with `qwen serve --channel <name>`.',
          code: 'channel_worker_not_enabled',
        });
        return;
      }
      try {
        const worker = await reloadChannelWorker();
        res.status(200).json({ reloaded: true, worker });
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/channel/reload',
        });
      }
    },
  );
}
