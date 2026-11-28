/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { DaemonAutofixPrWatchList } from '@qwen-code/web-shell/daemon-react-sdk';
import type { IndexedAutofixPrWatch } from '../../utils/autofixPrWatches';

export interface AutofixPrStartSessionRequest {
  prompt: string;
  workspaceCwd?: string;
  sessionTitle?: string;
}

export interface AutofixPrContextValue {
  /** Indexed watches across operable workspaces, keyed by canonical PR URL. */
  watchIndex: ReadonlyMap<string, IndexedAutofixPrWatch>;
  /** Per-workspace watch lists, keyed by `autofixPrWatchesKey`. */
  lists: ReadonlyMap<string, DaemonAutofixPrWatchList>;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Whether a new `/autofix-pr` session can be started for `workspaceCwd`. */
  canStartInWorkspace: (workspaceCwd?: string) => boolean;
  /** Start `/autofix-pr` (or `resume` / `stop`) in a dedicated session. */
  startInNewSession: (request: AutofixPrStartSessionRequest) => Promise<void>;
  /** Open an active watch's owning Web Shell session, or the PR watches page. */
  openWatch: (entry: IndexedAutofixPrWatch) => Promise<void>;
}

export const AutofixPrContext = createContext<AutofixPrContextValue | null>(
  null,
);

export function useAutofixPrOptional(): AutofixPrContextValue | null {
  return useContext(AutofixPrContext);
}
