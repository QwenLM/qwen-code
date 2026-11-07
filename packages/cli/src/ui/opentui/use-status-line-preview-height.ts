/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { STATUS_LINE_COMPOSER_ROWS } from '../status-line-model.js';

export function useStatusLinePreviewHeight(active: boolean) {
  const [chromeRows, setChromeRows] = useState(STATUS_LINE_COMPOSER_ROWS);
  return {
    reservedRows: active ? chromeRows : 0,
    measure: (controlsHeight: number, dialogHeight: number) => {
      if (active) {
        setChromeRows(
          Math.max(STATUS_LINE_COMPOSER_ROWS, controlsHeight - dialogHeight),
        );
      }
    },
  };
}
