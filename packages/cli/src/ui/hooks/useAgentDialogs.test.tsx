/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import type { AgentDefinition } from '@qwen-code/core';
import { useAgentDialogs } from './useAgentDialogs.js';

const FAKE_AGENT: AgentDefinition = {
  name: 'reviewer',
} as unknown as AgentDefinition;

describe('useAgentDialogs', () => {
  it('starts with both dialogs closed and no selected agent', async () => {
    const { result } = await renderHook(() => useAgentDialogs());
    expect(result.current.isAgentConfigDialogOpen).toBe(false);
    expect(result.current.isAgentBrowserOpen).toBe(false);
    expect(result.current.agentBrowserActiveTab).toBe('project');
    expect(result.current.selectedAgentName).toBeUndefined();
    expect(result.current.selectedAgentDefinition).toBeUndefined();
  });

  it('openAgentConfigDialog sets selected fields and opens the dialog', async () => {
    const { result } = await renderHook(() => useAgentDialogs());

    act(() => {
      result.current.openAgentConfigDialog('reviewer', FAKE_AGENT);
    });

    expect(result.current.isAgentConfigDialogOpen).toBe(true);
    expect(result.current.selectedAgentName).toBe('reviewer');
    expect(result.current.selectedAgentDefinition).toBe(FAKE_AGENT);
  });

  it('closeAgentConfigDialog clears the selection', async () => {
    const { result } = await renderHook(() => useAgentDialogs());

    act(() => {
      result.current.openAgentConfigDialog('reviewer', FAKE_AGENT);
    });
    act(() => {
      result.current.closeAgentConfigDialog();
    });

    expect(result.current.isAgentConfigDialogOpen).toBe(false);
    expect(result.current.selectedAgentName).toBeUndefined();
    expect(result.current.selectedAgentDefinition).toBeUndefined();
  });

  it('openAgentBrowser / closeAgentBrowser toggle the browser flag independently', async () => {
    const { result } = await renderHook(() => useAgentDialogs());

    act(() => {
      result.current.openAgentBrowser();
    });
    expect(result.current.isAgentBrowserOpen).toBe(true);
    expect(result.current.isAgentConfigDialogOpen).toBe(false);

    act(() => {
      result.current.closeAgentBrowser();
    });
    expect(result.current.isAgentBrowserOpen).toBe(false);
  });

  it('preserves the active browser tab while opening and closing agent config', async () => {
    const { result } = await renderHook(() => useAgentDialogs());

    act(() => {
      result.current.setAgentBrowserActiveTab('built-in');
    });
    act(() => {
      result.current.openAgentConfigDialog('reviewer', FAKE_AGENT);
    });
    act(() => {
      result.current.closeAgentConfigDialog();
    });

    expect(result.current.agentBrowserActiveTab).toBe('built-in');
  });

  it('resets the active browser tab when closing the browser', async () => {
    const { result } = await renderHook(() => useAgentDialogs());

    act(() => {
      result.current.setAgentBrowserActiveTab('built-in');
      result.current.openAgentBrowser();
    });
    act(() => {
      result.current.closeAgentBrowser();
    });

    expect(result.current.isAgentBrowserOpen).toBe(false);
    expect(result.current.agentBrowserActiveTab).toBe('project');
  });
});
