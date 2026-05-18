/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { DaemonIdeConnection } from '../services/daemonIdeConnection.js';

type Logger = (message: string) => void;

export const daemonSmokeCommand = 'qwen-code.daemonSmoke';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTextContent(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value['text'] === 'string' ? value['text'] : undefined;
}

function getSessionUpdateText(data: SessionNotification): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const update = data['update'];
  if (!isRecord(update)) {
    return undefined;
  }
  const sessionUpdate = update['sessionUpdate'];
  if (
    sessionUpdate !== 'agent_message_chunk' &&
    sessionUpdate !== 'agent_thought_chunk'
  ) {
    return undefined;
  }
  return getTextContent(update['content']);
}

async function pickPermissionOption(
  request: RequestPermissionRequest,
): Promise<{ optionId?: string }> {
  const options = Array.isArray(request.options) ? request.options : [];
  const picked = await vscode.window.showQuickPick(
    options.map((option) => ({
      label: option.name ?? option.optionId,
      description: option.optionId,
      optionId: option.optionId,
    })),
    {
      title: `Qwen daemon permission: ${request.toolCall?.kind ?? 'tool'}`,
      placeHolder: 'Choose a daemon permission response',
    },
  );
  return { optionId: picked?.optionId ?? 'cancel' };
}

export function registerDaemonSmokeCommand(
  context: vscode.ExtensionContext,
  log: Logger,
  outputChannel?: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(daemonSmokeCommand, async () => {
      const config = vscode.workspace.getConfiguration();
      const configuredUrl =
        config.get<string>('qwen-code.daemonUrl') || 'http://127.0.0.1:4170';
      const baseUrl = await vscode.window.showInputBox({
        title: 'Qwen daemon URL',
        value: configuredUrl,
        ignoreFocusOut: true,
      });
      if (!baseUrl) {
        return;
      }

      const prompt = await vscode.window.showInputBox({
        title: 'Qwen daemon smoke prompt',
        value: 'Say hello from the daemon IDE wire-up.',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      const token =
        config.get<string>('qwen-code.daemonToken') ||
        process.env['QWEN_SERVER_TOKEN'];
      const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const connection = new DaemonIdeConnection();

      outputChannel?.show(true);
      outputChannel?.appendLine(`[daemon] connecting to ${baseUrl}`);
      connection.onSessionUpdate = (data) => {
        const text = getSessionUpdateText(data);
        if (text) {
          outputChannel?.append(text);
        }
      };
      connection.onPermissionRequest = pickPermissionOption;
      connection.onEndTurn = (reason) => {
        outputChannel?.appendLine('');
        outputChannel?.appendLine(`[daemon] turn ended: ${reason ?? 'ok'}`);
      };
      connection.onDisconnected = (_code, signal) => {
        outputChannel?.appendLine(`[daemon] disconnected: ${signal ?? 'ok'}`);
      };

      try {
        await connection.connect({
          baseUrl,
          token,
          workspaceCwd,
        });
        outputChannel?.appendLine(
          `[daemon] session ${connection.currentSessionId ?? 'unknown'}`,
        );
        await connection.sendPrompt(prompt);
        vscode.window.showInformationMessage(
          'Qwen daemon smoke prompt completed.',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[DaemonSmoke] ${message}`);
        vscode.window.showErrorMessage(`Qwen daemon smoke failed: ${message}`);
      } finally {
        await connection.disconnect();
      }
    }),
  );
}
