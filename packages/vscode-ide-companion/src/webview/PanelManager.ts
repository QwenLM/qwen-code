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
  // Best-effort tracking of the group (by view column) that currently hosts
  // the Qwen webview. We update this when creating/revealing the panel and
  // whenever we can capture the Tab from the tab model.
  private panelGroupViewColumn: vscode.ViewColumn | null = null;

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

    // First, check if there's an existing Qwen Code group
    const existingGroup = this.findExistingQwenCodeGroup();

    if (existingGroup) {
      // If Qwen Code webview already exists in a locked group, create the new panel in that same group
      console.log(
        '[PanelManager] Found existing Qwen Code group, creating panel in same group',
      );
      this.panel = vscode.window.createWebviewPanel(
        'qwenCode.chat',
        'Qwen Code',
        { viewColumn: existingGroup.viewColumn, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'dist'),
            vscode.Uri.joinPath(this.extensionUri, 'assets'),
          ],
        },
      );
      // Track the group column hosting this panel
      this.panelGroupViewColumn = existingGroup.viewColumn;
    } else {
      // If no existing Qwen Code group, create a new group to the right of the active editor group
      try {
        // Create a new group to the right of the current active group
        await vscode.commands.executeCommand('workbench.action.newGroupRight');
      } catch (error) {
        console.warn(
          '[PanelManager] Failed to create right editor group (continuing):',
          error,
        );
        // Fallback: create in current group
        const activeColumn =
          vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
        this.panel = vscode.window.createWebviewPanel(
          'qwenCode.chat',
          'Qwen Code',
          { viewColumn: activeColumn, preserveFocus: false },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
              vscode.Uri.joinPath(this.extensionUri, 'dist'),
              vscode.Uri.joinPath(this.extensionUri, 'assets'),
            ],
          },
        );
        // Lock the group after creation
        await this.autoLockEditorGroup();
        return true;
      }

      // Get the new group's view column (should be the active one after creating right)
      const newGroupColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

      this.panel = vscode.window.createWebviewPanel(
        'qwenCode.chat',
        'Qwen Code',
        { viewColumn: newGroupColumn, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'dist'),
            vscode.Uri.joinPath(this.extensionUri, 'assets'),
          ],
        },
      );

      // Lock the group after creation
      await this.autoLockEditorGroup();

      // Track the newly created group's column
      this.panelGroupViewColumn = newGroupColumn;
    }

    // Set panel icon to Qwen logo
    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'assets',
      'icon.png',
    );

    // Try to capture Tab info shortly after creation so we can track the
    // precise group even if the user later drags the tab between groups.
    this.captureTab();

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
      // Prefer revealing in the currently tracked group to avoid reflowing groups.
      const trackedColumn = (
        this.panelTab as unknown as {
          group?: { viewColumn?: vscode.ViewColumn };
        }
      )?.group?.viewColumn as vscode.ViewColumn | undefined;
      const targetColumn: vscode.ViewColumn =
        trackedColumn ??
        this.panelGroupViewColumn ??
        vscode.window.tabGroups.activeTabGroup.viewColumn;
      this.panel.reveal(targetColumn, preserveFocus);
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
      // Update last-known group column if we can read it from the captured tab
      try {
        const groupViewColumn = (
          this.panelTab as unknown as {
            group?: { viewColumn?: vscode.ViewColumn };
          }
        )?.group?.viewColumn;
        if (groupViewColumn !== null) {
          this.panelGroupViewColumn = groupViewColumn as vscode.ViewColumn;
        }
      } catch {
        // Best effort only; ignore if the API shape differs
      }
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
        // Capture the group we intend to clean up before we clear fields
        const targetColumn: vscode.ViewColumn | null =
          // Prefer the group from the captured tab if available
          ((
            this.panelTab as unknown as {
              group?: { viewColumn?: vscode.ViewColumn };
            }
          )?.group?.viewColumn as vscode.ViewColumn | undefined) ??
          // Fall back to our last-known group column
          this.panelGroupViewColumn ??
          null;

        this.panel = null;
        this.panelTab = null;
        this.onPanelDispose();

        // After VS Code updates its tab model, check if that group is now
        // empty (and typically locked for Qwen). If so, close the group to
        // avoid leaving an empty locked column when the user closes Qwen.
        if (targetColumn !== null) {
          const column: vscode.ViewColumn = targetColumn;
          setTimeout(async () => {
            try {
              const groups = vscode.window.tabGroups.all;
              const group = groups.find((g) => g.viewColumn === column);
              // If the group that hosted Qwen is now empty, close it to avoid
              // leaving an empty locked column around. VS Code's stable API
              // does not expose the lock state on TabGroup, so we only check
              // for emptiness here.
              if (group && group.tabs.length === 0) {
                // Focus the group we want to close
                await this.focusGroupByColumn(column);
                // Try closeGroup first; fall back to removeActiveEditorGroup
                try {
                  await vscode.commands.executeCommand(
                    'workbench.action.closeGroup',
                  );
                } catch {
                  try {
                    await vscode.commands.executeCommand(
                      'workbench.action.removeActiveEditorGroup',
                    );
                  } catch (err) {
                    console.warn(
                      '[PanelManager] Failed to close empty group after Qwen panel disposed:',
                      err,
                    );
                  }
                }
              }
            } catch (err) {
              console.warn(
                '[PanelManager] Error while trying to close empty Qwen group:',
                err,
              );
            }
          }, 50);
        }
      },
      null,
      disposables,
    );
  }

  /**
   * Focus the editor group at the given view column by stepping left/right.
   * This avoids depending on Nth-group focus commands that may not exist.
   */
  private async focusGroupByColumn(target: vscode.ViewColumn): Promise<void> {
    const maxHops = 20; // safety guard for unusual layouts
    let hops = 0;
    while (
      vscode.window.tabGroups.activeTabGroup.viewColumn !== target &&
      hops < maxHops
    ) {
      const current = vscode.window.tabGroups.activeTabGroup.viewColumn;
      if (current < target) {
        await vscode.commands.executeCommand(
          'workbench.action.focusRightGroup',
        );
      } else if (current > target) {
        await vscode.commands.executeCommand('workbench.action.focusLeftGroup');
      } else {
        break;
      }
      hops++;
    }
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
