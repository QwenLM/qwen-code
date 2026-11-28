/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionHandle } from '../../session/session.js';
import {
  createCliSessionBridge,
  type CliSessionBridge,
} from './cliSessionBridge.js';
import type { HistoryItemWithoutId } from '../types.js';
import { getSessionDisplayState } from './sessionDisplayState.js';

type HistoryWriter = (item: HistoryItemWithoutId) => void;
export interface SessionUiBinding {
  /** Local execution owns paste preparation and permission-mode events. */
  readonly kind?: 'local' | 'external';
  readonly session: SessionHandle;
  readonly uiSession: CliSessionBridge;
  bindHistoryWriter(writer: HistoryWriter): () => void;
  dispose(): Promise<void>;
}
/** Bind the product's session to the existing UI. Local creation stays unchanged. */
export function prepareSessionUi(
  session?: SessionHandle,
): SessionUiBinding | undefined {
  return session ? createSessionUiBinding(session) : undefined;
}
export function createSessionUiBinding(
  session: SessionHandle,
  kind: 'local' | 'external' = 'external',
): SessionUiBinding {
  let historyWriter: HistoryWriter | undefined;
  const initialState = getSessionDisplayState(session.getState(), kind);
  const uiSession = createCliSessionBridge({
    port: session,
    initialState,
    formatRequestError: (operation, message) =>
      session.describeOperationError(operation, message),
    addHistoryItem: (item) => {
      if (!historyWriter)
        throw new Error('Session history consumer is not attached');
      historyWriter(item);
    },
  });
  return {
    kind,
    session,
    uiSession,
    bindHistoryWriter(writer) {
      historyWriter = writer;
      return () => {
        if (historyWriter === writer) historyWriter = undefined;
      };
    },
    async dispose() {
      uiSession.dispose();
      if (kind !== 'local') await session.release();
    },
  };
}
