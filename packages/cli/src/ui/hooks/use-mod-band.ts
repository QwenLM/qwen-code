/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  getInteractiveModSession,
  type ModBand,
} from '../../services/interactive-mod-session.js';

const unsubscribed = () => () => {};
const none = () => undefined;

/** The tree the Mods' band draws above the prompt, if any. */
export function useModBand(config: Config): ModBand | undefined {
  const session = getInteractiveModSession(config);
  return useSyncExternalStore(
    session?.subscribeBand ?? unsubscribed,
    session?.getBand ?? none,
  );
}
