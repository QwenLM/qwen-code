/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import wrapAnsi from 'wrap-ansi';
import { t } from '../../i18n/index.js';

export function useConfirmationPreview(
  text: string | undefined,
  width: number,
  height: number,
) {
  const [page, setPage] = useState(0);
  const rows = Math.max(1, height);
  const lines = useMemo(
    () =>
      text === undefined
        ? []
        : wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split(
            '\n',
          ),
    [text, width],
  );
  const total = Math.max(1, Math.ceil(lines.length / rows));
  const current = Math.min(page, total - 1);
  return {
    text: lines.slice(current * rows, (current + 1) * rows).join('\n'),
    hint:
      total > 1
        ? t('Page {{page}}/{{total}} · Page Up / Page Down', {
            page: String(current + 1),
            total: String(total),
          })
        : undefined,
    handleKey: (name: string) => {
      if (name === 'pageup') setPage(Math.max(0, current - 1));
      if (name === 'pagedown') setPage(Math.min(total - 1, current + 1));
    },
  };
}
