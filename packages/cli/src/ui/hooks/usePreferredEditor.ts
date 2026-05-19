/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { type EditorType, isValidEditorType } from '@qwen-code/qwen-code-core';
import { useSettings } from '../contexts/SettingsContext.js';

export function usePreferredEditor(): EditorType | undefined {
  const settings = useSettings();
  return useMemo(() => {
    const raw = settings.merged.general?.preferredEditor ?? '';
    return isValidEditorType(raw) ? raw : undefined;
  }, [settings.merged.general?.preferredEditor]);
}
