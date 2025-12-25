/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { AuthenticateUpdateNotification } from '../types/acpTypes.js';

// Store reference to the current notification
let currentNotification: Thenable<string | undefined> | null = null;

/**
 * Handle authentication update notifications by showing a VS Code notification
 * with the authentication URI and action buttons.
 *
 * @param data - Authentication update notification data containing the auth URI
 */
export function handleAuthenticateUpdate(
  data: AuthenticateUpdateNotification,
): void {
  const authUri = data._meta.authUri;

  // Store reference to the current notification
  currentNotification = vscode.window.showInformationMessage(
    `Qwen Code needs authentication. Click an action below:`,
    'Open in Browser',
    'Copy Link',
    'Dismiss',
  );

  currentNotification.then((selection) => {
    if (selection === 'Open in Browser') {
      // Open the authentication URI in the default browser
      vscode.env.openExternal(vscode.Uri.parse(authUri));
      vscode.window.showInformationMessage(
        'Opening authentication page in your browser...',
      );
    } else if (selection === 'Copy Link') {
      // Copy the authentication URI to clipboard
      vscode.env.clipboard.writeText(authUri);
      vscode.window.showInformationMessage(
        'Authentication link copied to clipboard!',
      );
    }

    // Clear the notification reference after user interaction
    currentNotification = null;
  });
}
