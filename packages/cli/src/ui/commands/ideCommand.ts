/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  IdeClient,
  type File,
  logIdeConnection,
  IdeConnectionEvent,
  IdeConnectionType,
} from '@qwen-code/qwen-code-core';
import {
  IDEConnectionStatus,
  ideContextStore,
} from '@qwen-code/qwen-code-core';
import path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

function getIdeStatusMessage(ideClient: IdeClient): {
  messageType: 'info' | 'error';
  content: string;
} {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case IDEConnectionStatus.Connected:
      return {
        messageType: 'info',
        content: `🟢 Connected to ${ideClient.getDetectedIdeDisplayName()}`,
      };
    case IDEConnectionStatus.Connecting:
      return {
        messageType: 'info',
        content: `🟡 Connecting...`,
      };
    default: {
      let content = `🔴 Disconnected`;
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: 'error',
        content,
      };
    }
  }
}

function formatFileList(openFiles: File[]): string {
  const basenameCounts = new Map<string, number>();
  for (const file of openFiles) {
    const basename = path.basename(file.path);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }

  const fileList = openFiles
    .map((file: File) => {
      const basename = path.basename(file.path);
      const isDuplicate = (basenameCounts.get(basename) || 0) > 1;
      const parentDir = path.basename(path.dirname(file.path));
      const displayName = isDuplicate
        ? `${basename} (/${parentDir})`
        : basename;

      return `  - ${displayName}${file.isActive ? ' (active)' : ''}`;
    })
    .join('\n');

  const infoMessage = `
(Note: The file list is limited to a number of recently accessed files within your workspace and only includes local files on disk)`;

  return `\n\nOpen files:\n${fileList}\n${infoMessage}`;
}

async function getIdeStatusMessageWithFiles(ideClient: IdeClient): Promise<{
  messageType: 'info' | 'error';
  content: string;
}> {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case IDEConnectionStatus.Connected: {
      let content = `🟢 Connected to ${ideClient.getDetectedIdeDisplayName()}`;
      const context = ideContextStore.get();
      const openFiles = context?.workspaceState?.openFiles;
      if (openFiles && openFiles.length > 0) {
        content += formatFileList(openFiles);
      }
      return {
        messageType: 'info',
        content,
      };
    }
    case IDEConnectionStatus.Connecting:
      return {
        messageType: 'info',
        content: `🟡 Connecting...`,
      };
    default: {
      let content = `🔴 Disconnected`;
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: 'error',
        content,
      };
    }
  }
}

async function setIdeModeAndSyncConnection(
  config: Config,
  value: boolean,
): Promise<void> {
  config.setIdeMode(value);
  const ideClient = await IdeClient.getInstance();
  if (value) {
    await ideClient.connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.SESSION));
  } else {
    await ideClient.disconnect();
  }
}

export const ideCommand = async (): Promise<SlashCommand> => {
  const ideClient = await IdeClient.getInstance();
  const currentIDE = ideClient.getCurrentIde();
  if (!currentIDE) {
    return {
      name: 'ide',
      get description() {
        return t('manage IDE integration');
      },
      kind: CommandKind.BUILT_IN,
      action: (): SlashCommandActionReturn =>
        ({
          type: 'message',
          messageType: 'error',
          content: t(
            'IDE integration is not supported in your current environment. To use this feature, run proto in one of these supported IDEs: VS Code or VS Code forks.',
          ),
        }) as const,
    };
  }

  const ideSlashCommand: SlashCommand = {
    name: 'ide',
    get description() {
      return t('manage IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    subCommands: [],
  };

  const statusCommand: SlashCommand = {
    name: 'status',
    get description() {
      return t('check status of IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (): Promise<SlashCommandActionReturn> => {
      const { messageType, content } =
        await getIdeStatusMessageWithFiles(ideClient);
      return {
        type: 'message',
        messageType,
        content,
      } as const;
    },
  };

  const enableCommand: SlashCommand = {
    name: 'enable',
    get description() {
      return t('enable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(
        SettingScope.User,
        'ide.enabled',
        true,
      );
      await setIdeModeAndSyncConnection(context.services.config!, true);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content,
        },
        Date.now(),
      );
    },
  };

  const disableCommand: SlashCommand = {
    name: 'disable',
    get description() {
      return t('disable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(
        SettingScope.User,
        'ide.enabled',
        false,
      );
      await setIdeModeAndSyncConnection(context.services.config!, false);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content,
        },
        Date.now(),
      );
    },
  };

  const { status } = ideClient.getConnectionStatus();
  const isConnected = status === IDEConnectionStatus.Connected;

  if (isConnected) {
    ideSlashCommand.subCommands = [statusCommand, disableCommand];
  } else {
    ideSlashCommand.subCommands = [enableCommand, statusCommand];
  }

  return ideSlashCommand;
};
