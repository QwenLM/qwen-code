/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { filterSubscriptionCommands } from '../commands/subscription-commands.js';
import type { SlashCommand } from '../commands/types.js';

export function useSubscriptionSignedIn(): boolean {
  const session = useMemo(() => new QwenSubscriptionSession(), []);
  const subscribe = useCallback(
    (listener: () => void) => session.onChange(listener),
    [session],
  );
  const getSnapshot = useCallback(() => session.isSignedIn(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useSubscriptionCommandVisibility(
  commands: readonly SlashCommand[],
  config: Pick<
    Config,
    'getAuthType' | 'onModelChange' | 'setSubscriptionPlan'
  > | null,
): readonly SlashCommand[] {
  const session = useMemo(() => new QwenSubscriptionSession(), []);
  const subscribe = useCallback(
    (listener: () => void) => {
      const refresh = () => {
        if (!session.isSignedIn()) config?.setSubscriptionPlan(undefined);
        listener();
      };
      const offModel = config?.onModelChange?.(refresh);
      const offSession = session.onChange(refresh);
      return () => {
        offModel?.();
        offSession();
      };
    },
    [config, session],
  );
  const getSnapshot = useCallback(
    () =>
      config?.getAuthType?.() === AuthType.QWEN_SUBSCRIPTION &&
      session.isSignedIn(),
    [config, session],
  );
  const available = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo(
    () =>
      filterSubscriptionCommands(
        commands,
        available ? AuthType.QWEN_SUBSCRIPTION : undefined,
        available,
      ),
    [commands, available],
  );
}
