/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * PanelManager Tests
 *
 * Test objective: Ensure WebView Panel/Tab can be correctly created and managed, preventing Tab open failures.
 *
 * Key test scenarios:
 * 1. Panel creation - Ensure WebView Panel can be successfully created
 * 2. Panel reuse - Ensure Panel is not duplicated
 * 3. Panel display - Ensure Panel can be correctly revealed
 * 4. Tab capture - Ensure Tab can be correctly captured and tracked
 * 5. Resource cleanup - Ensure dispose properly cleans up resources
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { PanelManager } from './PanelManager.js';

describe('PanelManager', () => {
  let panelManager: PanelManager;
  let mockExtensionUri: vscode.Uri;
  let onDisposeCallback: () => void;
  let mockPanel: vscode.WebviewPanel;

  beforeEach(() => {
    vi.clearAllMocks();

    mockExtensionUri = { fsPath: '/path/to/extension' } as vscode.Uri;
    onDisposeCallback = vi.fn();

    // Create mock panel
    mockPanel = {
      webview: {
        html: '',
        options: {},
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        postMessage: vi.fn(),
      },
      viewType: 'qwenCode.chat',
      title: 'Qwen Code',
      iconPath: null,
      visible: true,
      active: true,
      viewColumn: 1,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
      reveal: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.WebviewPanel;

    // Mock vscode.window.createWebviewPanel
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    // Mock tabGroups
    Object.defineProperty(vi.mocked(vscode.window.tabGroups), 'all', {
      value: [],
      writable: true,
    });
    Object.assign(vi.mocked(vscode.window.tabGroups).activeTabGroup, {
      viewColumn: 1,
      tabs: [],
      isActive: true,
      activeTab: undefined,
    });

    panelManager = new PanelManager(mockExtensionUri, onDisposeCallback);
  });

  afterEach(() => {
    panelManager.dispose();
  });

  describe('createPanel', () => {
    /**
     * Test: First Panel creation
     *
     * Verifies PanelManager can successfully create a new WebView Panel.
     * If creation fails, users will not see the chat interface.
     */
    it('should create a new panel when none exists', async () => {
      const result = await panelManager.createPanel();

      expect(result).toBe(true);
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'qwenCode.chat', // viewType
        'Qwen Code', // title
        expect.any(Object), // viewColumn options
        expect.objectContaining({
          enableScripts: true, // Must enable scripts for React to run
          retainContextWhenHidden: true, // Retain state when hidden
        }),
      );
    });

    /**
     * Test: Panel reuse
     *
     * Verifies Panel is not recreated when it already exists.
     * Prevents creating unnecessary duplicate Panels.
     */
    it('should return false if panel already exists', async () => {
      await panelManager.createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockClear();

      const result = await panelManager.createPanel();

      expect(result).toBe(false);
      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    });

    /**
     * Test: Panel icon setting
     *
     * Verifies correct icon is set when creating Panel.
     * Icon displays on Tab to help users identify it.
     */
    it('should set panel icon', async () => {
      await panelManager.createPanel();

      expect(mockPanel.iconPath).toBeDefined();
    });

    /**
     * Test: Enable scripts
     *
     * Verifies script execution is enabled when creating Panel.
     * This is required for React app to run.
     */
    it('should create panel with scripts enabled', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.enableScripts).toBe(true);
    });

    /**
     * Test: Retain context
     *
     * Verifies retainContextWhenHidden is set when creating Panel.
     * Prevents losing chat state when switching Tabs.
     */
    it('should retain context when hidden', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.retainContextWhenHidden).toBe(true);
    });

    /**
     * Test: Local resource roots
     *
     * Verifies correct local resource roots are set when creating Panel.
     * This determines which local files WebView can access.
     */
    it('should set local resource roots', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.localResourceRoots).toBeDefined();
      expect(options.localResourceRoots?.length).toBeGreaterThan(0);
    });
  });

  describe('getPanel', () => {
    /**
     * Test: Get empty Panel
     *
     * Verifies null is returned when no Panel is created.
     */
    it('should return null when no panel exists', () => {
      expect(panelManager.getPanel()).toBeNull();
    });

    /**
     * Test: Get created Panel
     *
     * Verifies the created Panel instance can be correctly retrieved.
     */
    it('should return panel after creation', async () => {
      await panelManager.createPanel();

      expect(panelManager.getPanel()).toBe(mockPanel);
    });
  });

  describe('setPanel', () => {
    /**
     * Test: Set Panel (for restoration)
     *
     * Verifies existing Panel can be set, used for restoration after VSCode restart.
     */
    it('should set panel for restoration', () => {
      panelManager.setPanel(mockPanel);

      expect(panelManager.getPanel()).toBe(mockPanel);
    });
  });

  describe('revealPanel', () => {
    /**
     * Test: Show Panel
     *
     * Verifies reveal is correctly called to show Panel.
     * Needed when user clicks to open chat.
     */
    it('should reveal panel when it exists', async () => {
      await panelManager.createPanel();

      panelManager.revealPanel();

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    /**
     * Test: Preserve focus option
     *
     * Verifies preserveFocus parameter is correctly passed to reveal.
     */
    it('should respect preserveFocus parameter', async () => {
      await panelManager.createPanel();

      panelManager.revealPanel(true);

      expect(mockPanel.reveal).toHaveBeenCalledWith(
        expect.any(Number),
        true, // preserveFocus
      );
    });
  });

  describe('dispose', () => {
    /**
     * Test: Release resources
     *
     * Verifies dispose properly cleans up Panel resources.
     * Prevents memory leaks.
     */
    it('should dispose panel and set to null', async () => {
      await panelManager.createPanel();

      panelManager.dispose();

      expect(mockPanel.dispose).toHaveBeenCalled();
      expect(panelManager.getPanel()).toBeNull();
    });

    /**
     * Test: Safe dispose
     *
     * Verifies dispose doesn't throw when no Panel exists.
     */
    it('should not throw when disposing without panel', () => {
      expect(() => panelManager.dispose()).not.toThrow();
    });
  });

  describe('registerDisposeHandler', () => {
    /**
     * Test: Register dispose callback
     *
     * Verifies dispose callback can be registered for Panel disposal.
     * Used to clean up related resources.
     */
    it('should register dispose handler', async () => {
      await panelManager.createPanel();
      const disposables: vscode.Disposable[] = [];

      panelManager.registerDisposeHandler(disposables);

      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });
  });

  describe('registerViewStateChangeHandler', () => {
    /**
     * Test: Register view state change handler
     *
     * Verifies Panel view state changes can be monitored.
     * Used to update Tab tracking.
     */
    it('should register view state change handler', async () => {
      await panelManager.createPanel();
      const disposables: vscode.Disposable[] = [];

      panelManager.registerViewStateChangeHandler(disposables);

      expect(mockPanel.onDidChangeViewState).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    /**
     * Test: Handle Panel creation failure
     *
     * Verifies graceful fallback when creating new editor group fails.
     */
    it('should handle newGroupRight command failure gracefully', async () => {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
        new Error('Command failed'),
      );

      // Should not throw, but fallback to alternative method
      const result = await panelManager.createPanel();

      expect(result).toBe(true);
    });
  });
});
