/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

/**
 * Panel and Tab Manager
 * Responsible for managing the creation, display, and tab tracking of WebView Panels
 */
export class PanelManager {
  private panel: vscode.WebviewPanel | null = null;
  private panelTab: vscode.Tab | null = null;

  constructor(
    private extensionUri: vscode.Uri,
    private onPanelDispose: () => void,
  ) {}

  /**
   * Get the current Panel
   */
  getPanel(): vscode.WebviewPanel | null {
    return this.panel;
  }

  /**
   * Set Panel (for restoration)
   */
  setPanel(panel: vscode.WebviewPanel): void {
    console.log('[PanelManager] Setting panel for restoration');
    this.panel = panel;
  }

  /**
   * Create new WebView Panel
   * @returns Whether it is a newly created Panel
   */
  async createPanel(): Promise<boolean> {
    if (this.panel) {
      return false; // Panel already exists
    }

    // Find if there's already a Qwen Code webview tab open and get its view column
    const existingQwenInfo = this.findExistingQwenCodeGroup();

    // If we found an existing Qwen Code tab, open in the same view column
    // Otherwise, open beside the active editor
    const targetViewColumn =
      existingQwenInfo?.viewColumn ?? vscode.ViewColumn.Beside;
    console.log('[PanelManager] existingQwenInfo', existingQwenInfo);
    console.log('[PanelManager] targetViewColumn', targetViewColumn);

    // If there's an existing Qwen Code group, ensure it's unlocked so we can add new tabs
    // We try to unlock regardless of current state - if already unlocked, this is a no-op
    if (existingQwenInfo?.group) {
      console.log(
        "[PanelManager] Found existing Qwen Code group, ensuring it's unlocked...",
      );

      try {
        // We need to make the target group active first
        // Find a Qwen Code tab in that group
        const firstQwenTab = existingQwenInfo.group.tabs.find((tab) => {
          const input: unknown = (tab as { input?: unknown }).input;
          const isWebviewInput = (inp: unknown): inp is { viewType: string } =>
            !!inp && typeof inp === 'object' && 'viewType' in inp;
          return (
            isWebviewInput(input) &&
            input.viewType === 'mainThreadWebview-qwenCode.chat'
          );
        });

        if (firstQwenTab) {
          // Make the group active by focusing on one of its tabs
          const activeTabGroup = vscode.window.tabGroups.activeTabGroup;
          if (activeTabGroup !== existingQwenInfo.group) {
            // Switch to the target group
            await vscode.commands.executeCommand(
              'workbench.action.focusFirstEditorGroup',
            );
          }
        }

        // Try to unlock the group (will be no-op if already unlocked)
        await vscode.commands.executeCommand(
          'workbench.action.unlockEditorGroup',
        );
        console.log('[PanelManager] Unlock command executed');
      } catch (error) {
        console.warn(
          '[PanelManager] Failed to unlock group, continuing anyway:',
          error,
        );
        // Continue anyway - the group might not be locked
      }
    }

    this.panel = vscode.window.createWebviewPanel(
      'qwenCode.chat',
      'Qwen Code',
      {
        viewColumn: targetViewColumn,
        preserveFocus: false, // Focus the new tab
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'assets'),
        ],
      },
    );

    // Set panel icon to Qwen logo
    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'assets',
      'icon.png',
    );

    return true; // New panel created
  }

  /**
   * Find the group and view column where the existing Qwen Code webview is located
   * @returns The found group and view column, or undefined if not found
   */
  private findExistingQwenCodeGroup():
    | { group: vscode.TabGroup; viewColumn: vscode.ViewColumn }
    | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input: unknown = (tab as { input?: unknown }).input;
        const isWebviewInput = (inp: unknown): inp is { viewType: string } =>
          !!inp && typeof inp === 'object' && 'viewType' in inp;

        if (
          isWebviewInput(input) &&
          input.viewType === 'mainThreadWebview-qwenCode.chat'
        ) {
          // Found an existing Qwen Code tab
          console.log('[PanelManager] Found existing Qwen Code group:', {
            viewColumn: group.viewColumn,
            tabCount: group.tabs.length,
            isActive: group.isActive,
          });
          return {
            group,
            viewColumn: group.viewColumn,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Auto-lock editor group (only called when creating a new Panel)
   * After creating/revealing the WebviewPanel, lock the active editor group so
   * the group stays dedicated (users can still unlock manually). We still
   * temporarily unlock before creation to allow adding tabs to an existing
   * group; this method restores the locked state afterwards.
   */
  async autoLockEditorGroup(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      // The newly created panel is focused (preserveFocus: false), so this
      // locks the correct, active editor group.
      await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
      console.log('[PanelManager] Group locked after panel creation');
    } catch (error) {
      console.warn('[PanelManager] Failed to lock editor group:', error);
    }
  }

  /**
   * Show Panel (reveal if exists, otherwise do nothing)
   * @param preserveFocus Whether to preserve focus
   */
  revealPanel(preserveFocus: boolean = true): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
    }
  }

  /**
   * Capture the Tab corresponding to the WebView Panel
   * Used for tracking and managing Tab state
   */
  captureTab(): void {
    if (!this.panel) {
      return;
    }

    // Defer slightly so the tab model is updated after create/reveal
    setTimeout(() => {
      const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      const match = allTabs.find((t) => {
        // Type guard for webview tab input
        const input: unknown = (t as { input?: unknown }).input;
        const isWebviewInput = (inp: unknown): inp is { viewType: string } =>
          !!inp && typeof inp === 'object' && 'viewType' in inp;
        const isWebview = isWebviewInput(input);
        const sameViewType = isWebview && input.viewType === 'qwenCode.chat';
        const sameLabel = t.label === this.panel!.title;
        return !!(sameViewType || sameLabel);
      });
      this.panelTab = match ?? null;
    }, 50);
  }

  /**
   * Register the dispose event handler for the Panel
   * @param disposables Array used to store Disposable objects
   */
  registerDisposeHandler(disposables: vscode.Disposable[]): void {
    if (!this.panel) {
      return;
    }

    this.panel.onDidDispose(
      () => {
        this.panel = null;
        this.panelTab = null;
        this.onPanelDispose();
      },
      null,
      disposables,
    );
  }

  /**
   * Register the view state change event handler
   * @param disposables Array used to store Disposable objects
   */
  registerViewStateChangeHandler(disposables: vscode.Disposable[]): void {
    if (!this.panel) {
      return;
    }

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel && this.panel.visible) {
          this.captureTab();
        }
      },
      null,
      disposables,
    );
  }

  /**
   * Dispose Panel
   */
  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this.panelTab = null;
  }
}
