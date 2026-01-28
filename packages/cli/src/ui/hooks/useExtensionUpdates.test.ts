/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  useExtensionUpdates,
  useSettingInputRequests,
  useConfirmUpdateRequests,
  usePluginChoiceRequests,
} from './useExtensionUpdates.js';
import {
  QWEN_DIR,
  type ExtensionManager,
  type Extension,
  type ExtensionUpdateInfo,
  ExtensionUpdateState,
} from '@qwen-code/qwen-code-core';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MessageType } from '../types.js';

vi.mock('os', async (importOriginal) => {
  const mockedOs = await importOriginal<typeof os>();
  return {
    ...mockedOs,
    homedir: vi.fn(),
  };
});

function createMockExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    id: 'test-extension-id',
    name: 'test-extension',
    version: '1.0.0',
    path: '/some/path',
    isActive: true,
    config: {
      name: 'test-extension',
      version: '1.0.0',
    },
    contextFiles: [],
    installMetadata: {
      type: 'git',
      source: 'https://some/repo',
      autoUpdate: false,
    },
    ...overrides,
  };
}

function createMockExtensionManager(
  extensions: Extension[],
  checkCallback?: (
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
  ) => Promise<void>,
  updateResult?: ExtensionUpdateInfo | undefined,
): ExtensionManager {
  return {
    getLoadedExtensions: vi.fn(() => extensions),
    checkForAllExtensionUpdates: vi.fn(
      async (
        callback: (extensionName: string, state: ExtensionUpdateState) => void,
      ) => {
        if (checkCallback) {
          await checkCallback(callback);
        }
      },
    ),
    updateExtension: vi.fn(async () => updateResult),
  } as unknown as ExtensionManager;
}

describe('useConfirmUpdateRequests', () => {
  it('should add a confirmation request', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm = vi.fn();
    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Test prompt',
        onConfirm,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);
    expect(result.current.confirmUpdateExtensionRequests[0].prompt).toBe(
      'Test prompt',
    );
  });

  it('should remove a confirmation request when confirmed', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm = vi.fn();
    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Test prompt',
        onConfirm,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);

    // Confirm the request
    act(() => {
      result.current.confirmUpdateExtensionRequests[0].onConfirm(true);
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(0);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('should handle multiple confirmation requests', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm1 = vi.fn();
    const onConfirm2 = vi.fn();

    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Prompt 1',
        onConfirm: onConfirm1,
      });
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Prompt 2',
        onConfirm: onConfirm2,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(2);

    // Confirm first request
    act(() => {
      result.current.confirmUpdateExtensionRequests[0].onConfirm(false);
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);
    expect(result.current.confirmUpdateExtensionRequests[0].prompt).toBe(
      'Prompt 2',
    );
    expect(onConfirm1).toHaveBeenCalledWith(false);
  });
});

describe('useSettingInputRequests', () => {
  it('should add a setting input request', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);
    expect(result.current.settingInputRequests[0].settingName).toBe('API_KEY');
    expect(result.current.settingInputRequests[0].settingDescription).toBe(
      'Enter your API key',
    );
    expect(result.current.settingInputRequests[0].sensitive).toBe(true);
  });

  it('should remove a setting input request when submitted', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);

    // Submit the value
    act(() => {
      result.current.settingInputRequests[0].onSubmit('my-secret-key');
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onSubmit).toHaveBeenCalledWith('my-secret-key');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('should remove a setting input request when cancelled', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);

    // Cancel the request
    act(() => {
      result.current.settingInputRequests[0].onCancel();
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should handle multiple setting input requests in sequence', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit1 = vi.fn();
    const onCancel1 = vi.fn();
    const onSubmit2 = vi.fn();
    const onCancel2 = vi.fn();

    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'USERNAME',
        settingDescription: 'Enter username',
        sensitive: false,
        onSubmit: onSubmit1,
        onCancel: onCancel1,
      });
      result.current.addSettingInputRequest({
        settingName: 'PASSWORD',
        settingDescription: 'Enter password',
        sensitive: true,
        onSubmit: onSubmit2,
        onCancel: onCancel2,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(2);

    // Submit first request
    act(() => {
      result.current.settingInputRequests[0].onSubmit('john_doe');
    });

    expect(result.current.settingInputRequests).toHaveLength(1);
    expect(result.current.settingInputRequests[0].settingName).toBe('PASSWORD');
    expect(onSubmit1).toHaveBeenCalledWith('john_doe');

    // Submit second request
    act(() => {
      result.current.settingInputRequests[0].onSubmit('secret123');
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onSubmit2).toHaveBeenCalledWith('secret123');
  });
});

describe('useExtensionUpdates', () => {
  let tempHomeDir: string;
  let userExtensionsDir: string;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-test-home-'));
    vi.mocked(os.homedir).mockReturnValue(tempHomeDir);
    userExtensionsDir = path.join(tempHomeDir, QWEN_DIR, 'extensions');
    fs.mkdirSync(userExtensionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('should check for updates and log a message if an update is available', async () => {
    const extension = createMockExtension({
      name: 'test-extension',
      installMetadata: {
        type: 'git',
        source: 'https://some/repo',
        autoUpdate: false,
      },
    });
    const addItem = vi.fn();
    const cwd = '/test/cwd';

    const extensionManager = createMockExtensionManager(
      [extension],
      async (callback) => {
        callback('test-extension', ExtensionUpdateState.UPDATE_AVAILABLE);
      },
    );

    renderHook(() => useExtensionUpdates(extensionManager, addItem, cwd));

    await waitFor(() => {
      expect(addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'You have 1 extension with an update available, run "/extensions list" for more information.',
        },
        expect.any(Number),
      );
    });
  });

  it('should check for updates and automatically update if autoUpdate is true', async () => {
    const extension = createMockExtension({
      name: 'test-extension',
      installMetadata: {
        type: 'git',
        source: 'https://some.git/repo',
        autoUpdate: true,
      },
    });

    const addItem = vi.fn();

    const extensionManager = createMockExtensionManager(
      [extension],
      async (callback) => {
        callback('test-extension', ExtensionUpdateState.UPDATE_AVAILABLE);
      },
      {
        originalVersion: '1.0.0',
        updatedVersion: '1.1.0',
        name: 'test-extension',
      },
    );

    renderHook(() =>
      useExtensionUpdates(extensionManager, addItem, tempHomeDir),
    );

    await waitFor(
      () => {
        expect(addItem).toHaveBeenCalledWith(
          {
            type: MessageType.INFO,
            text: 'Extension "test-extension" successfully updated: 1.0.0 → 1.1.0.',
          },
          expect.any(Number),
        );
      },
      { timeout: 4000 },
    );
  });

  it('should batch update notifications for multiple extensions', async () => {
    const extension1 = createMockExtension({
      id: 'test-extension-1-id',
      name: 'test-extension-1',
      version: '1.0.0',
      installMetadata: {
        type: 'git',
        source: 'https://some.git/repo1',
        autoUpdate: true,
      },
    });
    const extension2 = createMockExtension({
      id: 'test-extension-2-id',
      name: 'test-extension-2',
      version: '2.0.0',
      installMetadata: {
        type: 'git',
        source: 'https://some.git/repo2',
        autoUpdate: true,
      },
    });

    const addItem = vi.fn();
    let updateCallCount = 0;

    const extensionManager = {
      getLoadedExtensions: vi.fn(() => [extension1, extension2]),
      checkForAllExtensionUpdates: vi.fn(
        async (
          callback: (
            extensionName: string,
            state: ExtensionUpdateState,
          ) => void,
        ) => {
          callback('test-extension-1', ExtensionUpdateState.UPDATE_AVAILABLE);
          callback('test-extension-2', ExtensionUpdateState.UPDATE_AVAILABLE);
        },
      ),
      updateExtension: vi.fn(async () => {
        updateCallCount++;
        if (updateCallCount === 1) {
          return {
            originalVersion: '1.0.0',
            updatedVersion: '1.1.0',
            name: 'test-extension-1',
          };
        }
        return {
          originalVersion: '2.0.0',
          updatedVersion: '2.1.0',
          name: 'test-extension-2',
        };
      }),
    } as unknown as ExtensionManager;

    renderHook(() =>
      useExtensionUpdates(extensionManager, addItem, tempHomeDir),
    );

    await waitFor(
      () => {
        expect(addItem).toHaveBeenCalledTimes(2);
        expect(addItem).toHaveBeenCalledWith(
          {
            type: MessageType.INFO,
            text: 'Extension "test-extension-1" successfully updated: 1.0.0 → 1.1.0.',
          },
          expect.any(Number),
        );
        expect(addItem).toHaveBeenCalledWith(
          {
            type: MessageType.INFO,
            text: 'Extension "test-extension-2" successfully updated: 2.0.0 → 2.1.0.',
          },
          expect.any(Number),
        );
      },
      { timeout: 4000 },
    );
  });

  it('should batch update notifications for multiple extensions with autoUpdate: false', async () => {
    const extension1 = createMockExtension({
      id: 'test-extension-1-id',
      name: 'test-extension-1',
      version: '1.0.0',
      installMetadata: {
        type: 'git',
        source: 'https://some/repo1',
        autoUpdate: false,
      },
    });
    const extension2 = createMockExtension({
      id: 'test-extension-2-id',
      name: 'test-extension-2',
      version: '2.0.0',
      installMetadata: {
        type: 'git',
        source: 'https://some/repo2',
        autoUpdate: false,
      },
    });

    const addItem = vi.fn();
    const cwd = '/test/cwd';

    const extensionManager = createMockExtensionManager(
      [extension1, extension2],
      async (callback) => {
        callback('test-extension-1', ExtensionUpdateState.UPDATE_AVAILABLE);
        await new Promise((r) => setTimeout(r, 50));
        callback('test-extension-2', ExtensionUpdateState.UPDATE_AVAILABLE);
      },
    );

    renderHook(() => useExtensionUpdates(extensionManager, addItem, cwd));

    await waitFor(() => {
      expect(addItem).toHaveBeenCalledTimes(1);
      expect(addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: 'You have 2 extensions with an update available, run "/extensions list" for more information.',
        },
        expect.any(Number),
      );
    });
  });
});

describe('usePluginChoiceRequests', () => {
  it('should add a plugin choice request', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [
          { name: 'plugin1', description: 'First plugin' },
          { name: 'plugin2', description: 'Second plugin' },
        ],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);
    expect(result.current.pluginChoiceRequests[0].marketplaceName).toBe(
      'test-marketplace',
    );
    expect(result.current.pluginChoiceRequests[0].plugins).toHaveLength(2);
  });

  it('should remove a plugin choice request when a plugin is selected', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [{ name: 'plugin1' }],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);

    // Select a plugin
    act(() => {
      result.current.pluginChoiceRequests[0].onSelect('plugin1');
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(0);
    expect(onSelect).toHaveBeenCalledWith('plugin1');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('should remove a plugin choice request when cancelled', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [{ name: 'plugin1' }],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);

    // Cancel the request
    act(() => {
      result.current.pluginChoiceRequests[0].onCancel();
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(0);
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('should handle multiple plugin choice requests', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect1 = vi.fn();
    const onCancel1 = vi.fn();
    const onSelect2 = vi.fn();
    const onCancel2 = vi.fn();

    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'marketplace-1',
        plugins: [{ name: 'plugin1' }],
        onSelect: onSelect1,
        onCancel: onCancel1,
      });
      result.current.addPluginChoiceRequest({
        marketplaceName: 'marketplace-2',
        plugins: [{ name: 'plugin2' }],
        onSelect: onSelect2,
        onCancel: onCancel2,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(2);

    // Select from first request
    act(() => {
      result.current.pluginChoiceRequests[0].onSelect('plugin1');
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);
    expect(result.current.pluginChoiceRequests[0].marketplaceName).toBe(
      'marketplace-2',
    );
    expect(onSelect1).toHaveBeenCalledWith('plugin1');
  });
});
