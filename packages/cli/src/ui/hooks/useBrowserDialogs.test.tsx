/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import type {
  ConfigLoadError,
  HookRegistryEntry,
} from '@qwen-code/core';
import type { SkillDisplayInfo } from '../components/SkillBrowser.js';
import { useBrowserDialogs } from './useBrowserDialogs.js';

const FAKE_SKILL: SkillDisplayInfo = {
  name: 'fmt',
} as unknown as SkillDisplayInfo;

const FAKE_HOOK: HookRegistryEntry = {
  id: 'h1',
} as unknown as HookRegistryEntry;

const FAKE_CFG_ERR: ConfigLoadError = {
  message: 'bad json',
} as unknown as ConfigLoadError;

describe('useBrowserDialogs', () => {
  it('starts with all panels closed', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());
    expect(result.current.isSkillBrowserOpen).toBe(false);
    expect(result.current.isSkillDetailViewOpen).toBe(false);
    expect(result.current.isPluginBrowserOpen).toBe(false);
    expect(result.current.isConfigErrorDetailOpen).toBe(false);
    expect(result.current.isHookBrowserOpen).toBe(false);
    expect(result.current.isHookConfigDialogOpen).toBe(false);
    expect(result.current.isMcpBrowserOpen).toBe(false);
  });

  it('skill browser open/close is independent of skill detail', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());
    act(() => {
      result.current.openSkillBrowser();
    });
    expect(result.current.isSkillBrowserOpen).toBe(true);
    expect(result.current.isSkillDetailViewOpen).toBe(false);

    act(() => {
      result.current.openSkillDetailView(FAKE_SKILL);
    });
    expect(result.current.isSkillDetailViewOpen).toBe(true);
    expect(result.current.selectedSkillInfo).toBe(FAKE_SKILL);

    act(() => {
      result.current.closeSkillDetailView();
    });
    expect(result.current.isSkillDetailViewOpen).toBe(false);
    expect(result.current.selectedSkillInfo).toBeUndefined();
    // Browser still open
    expect(result.current.isSkillBrowserOpen).toBe(true);
  });

  it('plugin browser tracks args', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());

    act(() => {
      result.current.openPluginBrowser('--list');
    });
    expect(result.current.isPluginBrowserOpen).toBe(true);
    expect(result.current.pluginBrowserArgs).toBe('--list');

    act(() => {
      result.current.closePluginBrowser();
    });
    expect(result.current.isPluginBrowserOpen).toBe(false);
    expect(result.current.pluginBrowserArgs).toBeUndefined();
  });

  it('config-error detail tracks error + label and clears them on close', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());

    act(() => {
      result.current.openConfigErrorDetail(FAKE_CFG_ERR, 'settings.json');
    });
    expect(result.current.isConfigErrorDetailOpen).toBe(true);
    expect(result.current.selectedConfigError).toBe(FAKE_CFG_ERR);
    expect(result.current.configErrorLabel).toBe('settings.json');

    act(() => {
      result.current.closeConfigErrorDetail();
    });
    expect(result.current.isConfigErrorDetailOpen).toBe(false);
    expect(result.current.selectedConfigError).toBeUndefined();
    expect(result.current.configErrorLabel).toBeUndefined();
  });

  it('closing the hook browser also tears down a nested hook config dialog', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());

    act(() => {
      result.current.openHookBrowser();
      result.current.openHookConfigDialog(FAKE_HOOK);
    });
    expect(result.current.isHookBrowserOpen).toBe(true);
    expect(result.current.isHookConfigDialogOpen).toBe(true);
    expect(result.current.selectedHookEntry).toBe(FAKE_HOOK);

    act(() => {
      result.current.closeHookBrowser();
    });
    expect(result.current.isHookBrowserOpen).toBe(false);
    expect(result.current.isHookConfigDialogOpen).toBe(false);
    expect(result.current.selectedHookEntry).toBeUndefined();
  });

  it('mcp browser open/close is a plain boolean', async () => {
    const { result } = await renderHook(() => useBrowserDialogs());

    act(() => {
      result.current.openMcpBrowser();
    });
    expect(result.current.isMcpBrowserOpen).toBe(true);

    act(() => {
      result.current.closeMcpBrowser();
    });
    expect(result.current.isMcpBrowserOpen).toBe(false);
  });
});
