/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';

/**
 * Auth message handler
 * Handles all authentication-related messages
 */
export class AuthMessageHandler extends BaseMessageHandler {
  private loginHandler: (() => Promise<void>) | null = null;

  canHandle(messageType: string): boolean {
    return ['login'].includes(messageType);
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    switch (message.type) {
      case 'login':
        await this.handleLogin();
        break;

      default:
        console.warn(
          '[AuthMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  /**
   * Set login handler
   */
  setLoginHandler(handler: () => Promise<void>): void {
    this.loginHandler = handler;
  }

  /**
   * Handle login request
   */
  private async handleLogin(): Promise<void> {
    try {
      console.log('[AuthMessageHandler] Login requested');
      console.log(
        '[AuthMessageHandler] Login handler available:',
        !!this.loginHandler,
      );

      // Direct login without additional confirmation
      if (this.loginHandler) {
        console.log('[AuthMessageHandler] Calling login handler');
        await this.loginHandler();
        console.log(
          '[AuthMessageHandler] Login handler completed successfully',
        );
      } else {
        console.log('[AuthMessageHandler] Using fallback login method');
        // Fallback: show message and use command
        vscode.window.showInformationMessage(
          'Please wait while we connect to Qwen Code...',
        );
        await vscode.commands.executeCommand('qwen-code.login');
      }
    } catch (error) {
      console.error('[AuthMessageHandler] Login failed:', error);
      console.error(
        '[AuthMessageHandler] Error stack:',
        error instanceof Error ? error.stack : 'N/A',
      );
      this.sendToWebView({
        type: 'loginError',
        data: {
          message: `Login failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }
}
