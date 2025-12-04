/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';

/**
 * Settings message handler
 * Handles all settings-related messages
 */
export class SettingsMessageHandler extends BaseMessageHandler {
  canHandle(messageType: string): boolean {
    return ['openSettings', 'recheckCli'].includes(messageType);
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    switch (message.type) {
      case 'openSettings':
        await this.handleOpenSettings();
        break;

      case 'recheckCli':
        await this.handleRecheckCli();
        break;

      default:
        console.warn(
          '[SettingsMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  /**
   * Open settings page
   */
  private async handleOpenSettings(): Promise<void> {
    try {
      // Open settings in a side panel
      await vscode.commands.executeCommand('workbench.action.openSettings', {
        query: 'qwenCode',
      });
    } catch (error) {
      console.error('[SettingsMessageHandler] Failed to open settings:', error);
      vscode.window.showErrorMessage(`Failed to open settings: ${error}`);
    }
  }

  /**
   * Recheck CLI
   */
  private async handleRecheckCli(): Promise<void> {
    try {
      await vscode.commands.executeCommand('qwenCode.recheckCli');
      this.sendToWebView({
        type: 'cliRechecked',
        data: { success: true },
      });
    } catch (error) {
      console.error('[SettingsMessageHandler] Failed to recheck CLI:', error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to recheck CLI: ${error}` },
      });
    }
  }
}
