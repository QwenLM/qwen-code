/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderHookWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { useComposerStatus } from './useComposerStatus.js';
import { StreamingState } from '../types.js';
import { type SessionStatsState } from '../contexts/SessionContext.js';

describe('useComposerStatus', () => {
  it('localizes the minimal permission mode label', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { result, waitUntilReady, unmount } = await renderHookWithProviders(
      () => useComposerStatus(),
      {
        settings,
        uiState: {
          showPermissionModeIndicator: 'acceptEdits',
          cleanUiDetailsVisible: false,
          activeHooks: [],
          streamingState: StreamingState.Idle,
          isModelTurnActive: false,
          isCommandProgressActive: false,
          sessionStats: {
            lastPromptTokenCount: 0,
          } as SessionStatsState,
        },
      },
    );

    await waitUntilReady();
    expect(result.current.modeContentObj?.text).toBe('接受编辑');
    unmount();
  });
});
