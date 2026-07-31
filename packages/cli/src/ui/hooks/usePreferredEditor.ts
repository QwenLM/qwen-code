/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import {
  type EditorType,
  isValidEditorType,
  allowEditorTypeInSandbox,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { useSettings } from '../contexts/SettingsContext.js';

const debugLogger = createDebugLogger('PREFERRED_EDITOR');

export function usePreferredEditor(): EditorType | undefined {
  const settings = useSettings();
  return useMemo(() => {
    const raw = settings.merged.general?.preferredEditor ?? '';
    if (raw && !isValidEditorType(raw)) {
      debugLogger.warn(
        `[usePreferredEditor] invalid preferredEditor value "${raw}", ignoring`,
      );
      return undefined;
    }
    if (isValidEditorType(raw) && !allowEditorTypeInSandbox(raw)) {
      debugLogger.warn(
        `[usePreferredEditor] editor "${raw}" is not allowed in sandbox mode, ignoring`,
      );
      return undefined;
    }
    return isValidEditorType(raw) ? raw : undefined;
  }, [settings.merged.general?.preferredEditor]);
}
