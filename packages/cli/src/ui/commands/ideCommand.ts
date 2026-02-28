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
  QWEN_CODE_COMPANION_EXTENSION_NAME,
  getIdeInstaller,
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

  // Check if we're in a cloud IDE environment
  const isInCloudIde =
    process.env['CODESPACES'] === 'true' ||
    process.env['CLOUD_SHELL'] === 'true' ||
    process.env['DEVCONTAINER'] === 'true';

  // Allow IDE integration in cloud environments even without detected IDE
  if (!currentIDE && !isInCloudIde) {
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
            'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.',
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

      // Add cloud IDE environment info if applicable
      if (isInCloudIde) {
        const envInfo = [];
        if (process.env['CODESPACES'] === 'true')
          envInfo.push('GitHub Codespaces');
        if (process.env['CLOUD_SHELL'] === 'true') envInfo.push('Cloud Shell');
        if (process.env['DEVCONTAINER'] === 'true')
          envInfo.push('Dev Container');

        const additionalInfo = `\n\nEnvironment: ${envInfo.join(', ')}\nNote: In cloud IDE environments, the IDE extension must be installed on the host machine.`;

        return {
          type: 'message',
          messageType,
          content: content + additionalInfo,
        } as const;
      }

      return {
        type: 'message',
        messageType,
        content,
      } as const;
    },
  };

  const installCommand: SlashCommand = {
    name: 'install',
    get description() {
      const ideName =
        ideClient.getDetectedIdeDisplayName() ??
        (isInCloudIde ? 'Cloud IDE' : 'IDE');
      return t('install required IDE companion for {{ideName}}', {
        ideName,
      });
    },
    kind: CommandKind.BUILT_IN,
    action: async (context) => {
      const installer = currentIDE ? getIdeInstaller(currentIDE) : null;
      const isSandBox = !!process.env['SANDBOX'];

      // In cloud IDE environments, the extension must be installed on the host
      if (isInCloudIde || isSandBox) {
        context.ui.addItem(
          {
            type: 'info',
            text: `IDE integration needs to be installed on the host. If you have already installed it, you can directly connect the IDE by running /ide enable.\n\nTo install the extension:\n1. Open your IDE on the host machine\n2. Install the '${QWEN_CODE_COMPANION_EXTENSION_NAME}' extension from the marketplace\n3. Run /ide enable in this terminal`,
          },
          Date.now(),
        );
        return;
      }
      if (!installer) {
        const ideName = ideClient.getDetectedIdeDisplayName() ?? 'your IDE';
        context.ui.addItem(
          {
            type: 'error',
            text: `Automatic installation is not supported for ${ideName}. Please install the '${QWEN_CODE_COMPANION_EXTENSION_NAME}' extension manually from the marketplace.`,
          },
          Date.now(),
        );
        return;
      }

      context.ui.addItem(
        {
          type: 'info',
          text: `Installing IDE companion...`,
        },
        Date.now(),
      );

      const result = await installer.install();
      context.ui.addItem(
        {
          type: result.success ? 'info' : 'error',
          text: result.message,
        },
        Date.now(),
      );
      if (result.success) {
        context.services.settings.setValue(
          SettingScope.User,
          'ide.enabled',
          true,
        );
        // Poll for up to 5 seconds for the extension to activate.
        for (let i = 0; i < 10; i++) {
          await setIdeModeAndSyncConnection(context.services.config!, true);
          if (
            ideClient.getConnectionStatus().status ===
            IDEConnectionStatus.Connected
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const { messageType, content } = getIdeStatusMessage(ideClient);
        if (messageType === 'error') {
          context.ui.addItem(
            {
              type: messageType,
              text: `Failed to automatically enable IDE integration. To fix this, run the CLI in a new terminal window.`,
            },
            Date.now(),
          );
        } else {
          context.ui.addItem(
            {
              type: messageType,
              text: content,
            },
            Date.now(),
          );
        }
      }
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

      // Provide additional guidance for cloud IDE environments
      if (messageType === 'error' && isInCloudIde) {
        context.ui.addItem(
          {
            type: 'error',
            text: `${content}\n\nTroubleshooting tips for cloud IDE:\n1. Make sure the '${QWEN_CODE_COMPANION_EXTENSION_NAME}' extension is installed on your host IDE\n2. The extension should be running in your IDE on the host machine\n3. Try restarting the terminal in your cloud IDE\n4. Check that your workspace is properly synced between the container and host`,
          },
          Date.now(),
        );
      } else {
        context.ui.addItem(
          {
            type: messageType,
            text: content,
          },
          Date.now(),
        );
      }
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
    ideSlashCommand.subCommands = [
      enableCommand,
      statusCommand,
      installCommand,
    ];
  }

  return ideSlashCommand;
};
