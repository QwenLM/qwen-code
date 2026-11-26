/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '../../test-utils/render.js';

import { useSettingsCommand } from './useSettingsCommand.js';

describe('useSettingsCommand', () => {
  it('opens and closes the settings dialog', async () => {
    const { result } = await renderHook(() => useSettingsCommand());

    act(() => result.current.openSettingsDialog());

    expect(result.current.isSettingsDialogOpen).toBe(true);

    act(() => result.current.closeSettingsDialog());

    expect(result.current.isSettingsDialogOpen).toBe(false);
  });
});
