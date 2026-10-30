/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import {
  logoutCommand,
  upgradeCommand,
} from '../commands/subscription-commands.js';
import type { SlashCommand } from '../commands/types.js';

export function useSubscriptionCommandVisibility(
  commands: readonly SlashCommand[],
  config: Pick<Config, 'getAuthType' | 'onModelChange'> | null,
): readonly SlashCommand[] {
  const subscribe = useCallback(
    (listener: () => void) => config?.onModelChange?.(listener) ?? (() => {}),
    [config],
  );
  const getSnapshot = useCallback(
    () => config?.getAuthType?.() === AuthType.QWEN_SUBSCRIPTION,
    [config],
  );
  const isSubscription = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo(
    () =>
      isSubscription
        ? commands
        : Object.freeze(
            commands.map((command) =>
              command.action === logoutCommand.action ||
              command.action === upgradeCommand.action
                ? { ...command, hidden: true }
                : command,
            ),
          ),
    [commands, isSubscription],
  );
}
