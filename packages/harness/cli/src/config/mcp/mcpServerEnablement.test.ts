/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadSettings } from '../../test-utils/resolveSettings.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LoadedSettings } from '../settings.js';

import {
  McpServerEnablementManager,
  canLoadServer,
  normalizeServerId,
  isInSettingsList,
  type EnablementCallbacks,
} from './mcpServerEnablement.js';

// Mutable session view used by the enablement tests; no disk loading is needed.
const mockMergedMcpServers: Record<string, { disabled?: boolean }> = {};
const sessionSettings = {
  merged: { mcpServers: mockMergedMcpServers },
} as unknown as LoadedSettings;

vi.mock('../../test-utils/resolveSettings.js', () => ({ loadSettings: vi.fn() }));

function createMockEnablement(
  sessionDisabled: boolean,
  fileEnabled: boolean,
): EnablementCallbacks {
  return {
    isSessionDisabled: () => sessionDisabled,
    isFileEnabled: () => Promise.resolve(fileEnabled),
  };
}

describe('McpServerEnablementManager', () => {
  let manager: McpServerEnablementManager;

  beforeEach(() => {
    for (const k of Object.keys(mockMergedMcpServers)) {
      delete mockMergedMcpServers[k];
    }
    McpServerEnablementManager.resetInstance();
    manager = McpServerEnablementManager.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    McpServerEnablementManager.resetInstance();
  });

  it('reads the current session projection without loading settings again', async () => {
    vi.mocked(loadSettings).mockClear();
    let merged = { mcpServers: { server: { disabled: true } } };
    const settings = {
      get merged() {
        return merged;
      },
    } as unknown as LoadedSettings;
    const callbacks = manager.getEnablementCallbacks(settings);
    expect(await callbacks.isFileEnabled('server')).toBe(false);
    merged = { mcpServers: { server: { disabled: false } } };
    expect(await callbacks.isFileEnabled('server')).toBe(true);
    expect(
      manager.getAllDisplayStates(['server'], settings)['server'].enabled,
    ).toBe(true);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it('reflects the settings.json `disabled` field via callbacks', async () => {
    const callbacks = manager.getEnablementCallbacks(sessionSettings);
    expect(await callbacks.isFileEnabled('server')).toBe(true);
    mockMergedMcpServers['server'] = { disabled: true };
    expect(await callbacks.isFileEnabled('server')).toBe(false);
    delete mockMergedMcpServers['server'];
    expect(await callbacks.isFileEnabled('server')).toBe(true);
  });

  it('keeps runtime callbacks and display state bound to their original project', async () => {
    const originalSettings = {
      merged: { mcpServers: { server: { disabled: true } } },
    } as unknown as LoadedSettings;
    const otherSettings = {
      merged: { mcpServers: { server: { disabled: false } } },
    } as unknown as LoadedSettings;
    const original = manager.getEnablementCallbacks(originalSettings);
    const otherProject = manager.getEnablementCallbacks(otherSettings);

    expect(await original.isFileEnabled('server')).toBe(false);
    expect(await otherProject.isFileEnabled('server')).toBe(true);
    expect(
      manager.getAllDisplayStates(['server'], originalSettings)['server']
        .enabled,
    ).toBe(false);
  });

  it('returns the right composed display state', () => {
    mockMergedMcpServers['file-disabled'] = { disabled: true };
    manager.disableForSession('session-disabled');

    expect(manager.getDisplayState('enabled', sessionSettings)).toEqual({
      enabled: true,
      isSessionDisabled: false,
      isPersistentDisabled: false,
    });
    expect(
      manager.getDisplayState('file-disabled', sessionSettings)
        .isPersistentDisabled,
    ).toBe(true);
    expect(
      manager.getDisplayState('session-disabled', sessionSettings)
        .isSessionDisabled,
    ).toBe(true);
  });

  it('matches stored entries case-insensitively', () => {
    mockMergedMcpServers['PlayWright'] = { disabled: true };
    expect(
      manager.getDisplayState('playwright', sessionSettings)
        .isPersistentDisabled,
    ).toBe(true);
  });

  it('shares session state across getInstance calls', () => {
    const instance1 = McpServerEnablementManager.getInstance();
    const instance2 = McpServerEnablementManager.getInstance();

    instance1.disableForSession('test-server');

    expect(instance2.isSessionDisabled('test-server')).toBe(true);
    expect(instance1).toBe(instance2);
  });
});

describe('canLoadServer', () => {
  it('blocks when server is not in allowlist', async () => {
    const result = await canLoadServer('s', {
      allowedList: ['other'],
    });
    expect(result.blockType).toBe('allowlist');
  });

  it('blocks when server is in excludelist', async () => {
    const result = await canLoadServer('s', {
      excludedList: ['s'],
    });
    expect(result.blockType).toBe('excludelist');
  });

  it('blocks when server is session-disabled', async () => {
    const result = await canLoadServer('s', {
      enablement: createMockEnablement(true, true),
    });
    expect(result.blockType).toBe('session');
  });

  it('blocks when server is file-disabled', async () => {
    const result = await canLoadServer('s', {
      enablement: createMockEnablement(false, false),
    });
    expect(result.blockType).toBe('enablement');
  });

  it('allows when no restrictions', async () => {
    const result = await canLoadServer('s', {});
    expect(result.allowed).toBe(true);
  });

  it('allows when server passes all checks', async () => {
    const result = await canLoadServer('s', {
      allowedList: ['s'],
      enablement: createMockEnablement(false, true),
    });
    expect(result.allowed).toBe(true);
  });
});

describe('helper functions', () => {
  it('normalizeServerId lowercases and trims', () => {
    expect(normalizeServerId('  PlayWright  ')).toBe('playwright');
  });

  it('isInSettingsList supports ext: backward compat', () => {
    expect(isInSettingsList('playwright', ['playwright']).found).toBe(true);
    expect(isInSettingsList('ext:github:mcp', ['mcp']).found).toBe(true);
    expect(
      isInSettingsList('ext:github:mcp', ['mcp']).deprecationWarning,
    ).toBeTruthy();
  });
});
