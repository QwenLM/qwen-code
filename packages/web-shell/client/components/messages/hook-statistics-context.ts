import { createContext } from 'react';
import type {
  HookTurnPage,
  DaemonSessionTurnHooksPageOptions,
} from '@qwen-code/sdk/daemon';
import type { DaemonTurnNavigationStore } from '../../daemon/session/turn-navigation-store.js';

export interface HookStatisticsTurn {
  sessionId: string;
  promptId?: string;
  recordId?: string;
}

export interface HookStatisticsSource {
  sessionId: string;
  navigation: DaemonTurnNavigationStore;
  readPage(
    promptId: string,
    options: DaemonSessionTurnHooksPageOptions,
  ): Promise<HookTurnPage>;
}

export const HookStatisticsContext = createContext<
  HookStatisticsSource | undefined
>(undefined);
