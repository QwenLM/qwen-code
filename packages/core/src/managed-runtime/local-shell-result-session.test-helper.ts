/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';
import type { ToolResultExpectedIdentity } from './managed-tool-result-store.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';

process.on(
  'message',
  (request: {
    runtimeBaseDir: string;
    sessionKey: ManagedSessionKey;
    manifestRef: ManagedSessionDurableRef;
    identity: ToolResultExpectedIdentity;
    length: number;
  }) => {
    void (async () => {
      const store = await LocalToolResultSegmentStore.openReadOnly({
        runtimeBaseDir: request.runtimeBaseDir,
        sessionKey: request.sessionKey,
      });
      try {
        const read = await store.readRange({
          manifestRef: request.manifestRef,
          expectedIdentity: request.identity,
          streamId: 'stdout',
          offset: request.length - 5,
          length: 5,
        });
        process.send?.(
          read.status === 'ok'
            ? { status: 'ok', base64: read.result.toString('base64') }
            : read,
        );
      } finally {
        await store.close();
      }
    })().catch((error: unknown) => {
      process.send?.({ status: 'error', message: String(error) });
    });
  },
);
