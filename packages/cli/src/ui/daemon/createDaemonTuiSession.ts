/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTuiSessionClient } from './DaemonTuiAdapter.js';

export interface CreateDaemonTuiSessionOptions {
  daemonUrl: string;
  token?: string;
  workspaceCwd: string;
  model?: string;
  sessionId?: string;
  sessionScope?: 'single' | 'thread';
}

export async function createDaemonTuiSession(
  options: CreateDaemonTuiSessionOptions,
): Promise<DaemonTuiSessionClient> {
  const { DaemonClient, DaemonSessionClient } = await import('@qwen-code/sdk');
  const client = new DaemonClient({
    baseUrl: options.daemonUrl,
    token: options.token ?? process.env['QWEN_SERVER_TOKEN'],
  });

  if (options.sessionId) {
    return await DaemonSessionClient.load(client, options.sessionId, {
      workspaceCwd: options.workspaceCwd,
    });
  }

  return await DaemonSessionClient.createOrAttach(client, {
    workspaceCwd: options.workspaceCwd,
    ...(options.model ? { modelServiceId: options.model } : {}),
    ...(options.sessionScope ? { sessionScope: options.sessionScope } : {}),
  });
}
