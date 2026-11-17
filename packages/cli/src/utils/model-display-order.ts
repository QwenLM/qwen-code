/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableModel } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';

type ModelEntry = {
  model?: Pick<AvailableModel, 'authType' | 'isRuntimeModel'>;
};

export function filterModelEntriesForDisplay<T extends ModelEntry>(
  entries: readonly T[],
  signedIn = new QwenSubscriptionSession().isSignedIn(),
): T[] {
  return entries.filter(
    ({ model }) => signedIn || model?.authType !== AuthType.QWEN_SUBSCRIPTION,
  );
}

export function sortModelEntriesForDisplay<T extends ModelEntry>(
  entries: readonly T[],
): T[] {
  if (
    !entries.some(
      ({ model }) =>
        model?.authType === AuthType.QWEN_SUBSCRIPTION && !model.isRuntimeModel,
    )
  ) {
    return [...entries];
  }

  const priority = ({ model }: ModelEntry): number => {
    if (!model || model.isRuntimeModel) return 2;
    if (model.authType === AuthType.QWEN_SUBSCRIPTION) return 0;
    return model.authType === AuthType.QWEN_OAUTH ? 1 : 2;
  };

  return entries.toSorted((left, right) => priority(left) - priority(right));
}
