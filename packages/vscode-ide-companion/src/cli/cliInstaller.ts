/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { CliDetector } from './cliDetector.js';

/**
 * CLI Detection and Installation Handler
 * Responsible for detecting, installing, and prompting for Qwen CLI
 */
export class CliInstaller {
  /**
   * Check CLI installation status and send results to WebView
   * @param sendToWebView Callback function to send messages to WebView
   */
  static async checkInstallation(
    sendToWebView: (message: unknown) => void,
  ): Promise<void> {
    try {
      const result = await CliDetector.detectQwenCli();

      sendToWebView({
        type: 'cliDetectionResult',
        data: {
          isInstalled: result.isInstalled,
          cliPath: result.cliPath,
          version: result.version,
          error: result.error,
          installInstructions: result.isInstalled
            ? undefined
            : CliDetector.getInstallationInstructions(),
        },
      });

      if (!result.isInstalled) {
        console.log('[CliInstaller] Qwen CLI not detected:', result.error);
      } else {
        console.log(
          '[CliInstaller] Qwen CLI detected:',
          result.cliPath,
          result.version,
        );
      }
    } catch (error) {
      console.error('[CliInstaller] CLI detection error:', error);
    }
  }

  /**
   * Prompt user to install CLI
   * Display warning message with installation options
   */
  static async promptInstallation(): Promise<void> {
    const selection = await vscode.window.showWarningMessage(
      'Qwen Code CLI is not installed. You can browse conversation history, but cannot send new messages.',
      'Install Now',
      'View Documentation',
      'Remind Me Later',
    );

    if (selection === 'Install Now') {
      await this.install();
    } else if (selection === 'View Documentation') {
      vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/QwenLM/qwen-code#installation'),
      );
    }
  }

  /**
   * Install Qwen CLI
   * Install global CLI package via npm
   */
  static async install(): Promise<void> {
    try {
      // Show progress notification
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Installing Qwen Code CLI',
          cancellable: false,
        },
        async (progress) => {
          progress.report({
            message: 'Running: npm install -g @qwen-code/qwen-code@latest',
          });

          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          try {
            // Use NVM environment to ensure we get the same Node.js version
            // as when they run 'node -v' in terminal
            // Fallback chain: default alias -> node alias -> current version
            const installCommand =
              process.platform === 'win32'
                ? 'npm install -g @qwen-code/qwen-code@latest'
                : 'source ~/.nvm/nvm.sh 2>/dev/null && (nvm use default 2>/dev/null || nvm use node 2>/dev/null || nvm use 2>/dev/null); npm install -g @qwen-code/qwen-code@latest';

            console.log(
              '[CliInstaller] Installing with command:',
              installCommand,
            );
            console.log(
              '[CliInstaller] Current process PATH:',
              process.env['PATH'],
            );

            // Also log Node.js version being used by VS Code
            console.log(
              '[CliInstaller] VS Code Node.js version:',
              process.version,
            );
            console.log(
              '[CliInstaller] VS Code Node.js execPath:',
              process.execPath,
            );

            const { stdout, stderr } = await execAsync(
              installCommand,
              {
                timeout: 120000,
                shell: '/bin/bash',
              }, // 2 minutes timeout
            );

            console.log('[CliInstaller] Installation output:', stdout);
            if (stderr) {
              console.warn('[CliInstaller] Installation stderr:', stderr);
            }

            // Clear cache and recheck
            CliDetector.clearCache();
            const detection = await CliDetector.detectQwenCli();

            if (detection.isInstalled) {
              vscode.window
                .showInformationMessage(
                  `✅ Qwen Code CLI installed successfully! Version: ${detection.version}`,
                  'Reload Window',
                )
                .then((selection) => {
                  if (selection === 'Reload Window') {
                    vscode.commands.executeCommand(
                      'workbench.action.reloadWindow',
                    );
                  }
                });
            } else {
              throw new Error(
                'Installation completed but CLI still not detected',
              );
            }
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            console.error('[CliInstaller] Installation failed:', errorMessage);
            console.error('[CliInstaller] Error stack:', error);

            // Provide specific guidance for permission errors
            let userFriendlyMessage = `Failed to install Qwen Code CLI: ${errorMessage}`;

            if (
              errorMessage.includes('EACCES') ||
              errorMessage.includes('Permission denied')
            ) {
              userFriendlyMessage += `\n\nThis is likely due to permission issues. Possible solutions:
                \n1. Reinstall without sudo: npm install -g @qwen-code/qwen-code@latest
                \n2. Fix npm permissions: sudo chown -R $(whoami) $(npm config get prefix)/{lib/node_modules,bin,share}
                \n3. Use nvm for Node.js version management to avoid permission issues
                \n4. Configure npm to use a different directory: npm config set prefix ~/.npm-global`;
            }

            vscode.window
              .showErrorMessage(
                userFriendlyMessage,
                'Try Manual Installation',
                'View Documentation',
              )
              .then((selection) => {
                if (selection === 'Try Manual Installation') {
                  const terminal = vscode.window.createTerminal(
                    'Qwen Code Installation',
                  );
                  terminal.show();

                  // Provide different installation commands based on error type
                  if (
                    errorMessage.includes('EACCES') ||
                    errorMessage.includes('Permission denied')
                  ) {
                    terminal.sendText('# Try installing without sudo:');
                    terminal.sendText(
                      'npm install -g @qwen-code/qwen-code@latest',
                    );
                    terminal.sendText('');
                    terminal.sendText('# Or fix npm permissions:');
                    terminal.sendText(
                      'sudo chown -R $(whoami) $(npm config get prefix)/{lib/node_modules,bin,share}',
                    );
                  } else {
                    terminal.sendText(
                      'npm install -g @qwen-code/qwen-code@latest',
                    );
                  }
                } else if (selection === 'View Documentation') {
                  vscode.env.openExternal(
                    vscode.Uri.parse(
                      'https://github.com/QwenLM/qwen-code#installation',
                    ),
                  );
                }
              });
          }
        },
      );
    } catch (error) {
      console.error('[CliInstaller] Install CLI error:', error);
    }
  }
}
