/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { tokenizeMessage } from '@qwen-code/core';
import type { MessageParams, UiMessageKey } from './types.js';
import { useI18nService } from './I18nServiceContext.js';
export function T({
  id,
  values = {},
  slots = {},
}: {
  id: UiMessageKey;
  values?: MessageParams;
  slots?: Readonly<Record<string, React.ReactNode>>;
}): React.ReactNode {
  const i18n = useI18nService();
  const template = i18n.getTemplate(id);

  return tokenizeMessage(template).map((token, index) => {
    if (token.kind === 'text') return token.value;
    const slot = slots[token.name];
    if (slot !== undefined) {
      return (
        <React.Fragment key={`${token.name}-${index}`}>{slot}</React.Fragment>
      );
    }
    const value = values[token.name];
    return value === undefined ? `{${token.name}}` : String(value);
  });
}
