/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableModel } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';

type ModelEntry = {
  model?: Pick<AvailableModel, 'authType' | 'id' | 'isRuntimeModel'>;
};

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
    if (!model || model.isRuntimeModel) return 3;
    if (model.authType === AuthType.QWEN_SUBSCRIPTION) {
      if (model.id === 'qwen3.8-max') return 0;
      if (model.id === 'qwen3.8-flash') return 1;
      return 2;
    }
    return model.authType === AuthType.QWEN_OAUTH ? 2 : 3;
  };

  return entries.toSorted((left, right) => priority(left) - priority(right));
}
