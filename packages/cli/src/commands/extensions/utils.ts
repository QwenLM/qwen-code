/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExtensionManager, type Extension } from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import {
  requestConsentOrFail,
  requestConsentNonInteractive,
  requestChoicePluginNonInteractive,
} from './consent.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import * as os from 'node:os';
import chalk from 'chalk';
import { t } from '../../i18n/index.js';

export async function getExtensionManager(): Promise<ExtensionManager> {
  const workspaceDir = process.cwd();
  const extensionManager = new ExtensionManager({
    workspaceDir,
    requestConsent: requestConsentOrFail.bind(
      null,
      requestConsentNonInteractive,
    ),
    requestChoicePlugin: requestChoicePluginNonInteractive,
    isWorkspaceTrusted: !!isWorkspaceTrusted(loadSettings(workspaceDir).merged),
  });
  await extensionManager.refreshCache();
  return extensionManager;
}

export function extensionToOutputString(
  extension: Extension,
  extensionManager: ExtensionManager,
  workspaceDir: string,
  inline = false,
): string {
  const cwd = workspaceDir;
  const userEnabled = extensionManager.isEnabled(
    extension.config.name,
    os.homedir(),
  );
  const workspaceEnabled = extensionManager.isEnabled(
    extension.config.name,
    cwd,
  );

  const status = workspaceEnabled ? chalk.green('✓') : chalk.red('✗');
  let output = `${inline ? '' : status} ${extension.config.name} (${extension.config.version})`;
  output += `\n ${t('Path:')} ${extension.path}`;
  if (extension.installMetadata) {
    output += `\n ${t('Source:')} ${extension.installMetadata.source} (${t('Type:')} ${extension.installMetadata.type})`;
    if (extension.installMetadata.ref) {
      output += `\n ${t('Ref:')} ${extension.installMetadata.ref}`;
    }
    if (extension.installMetadata.releaseTag) {
      output += `\n ${t('Release tag:')} ${extension.installMetadata.releaseTag}`;
    }
  }
  output += `\n ${t('Enabled (User):')} ${userEnabled}`;
  output += `\n ${t('Enabled (Workspace):')} ${workspaceEnabled}`;
  if (extension.contextFiles.length > 0) {
    output += `\n ${t('Context files:')}`;
    extension.contextFiles.forEach((contextFile) => {
      output += `\n  ${contextFile}`;
    });
  }
  if (extension.commands && extension.commands.length > 0) {
    output += `\n ${t('Commands:')}`;
    extension.commands.forEach((command) => {
      output += `\n  /${command}`;
    });
  }
  if (extension.skills && extension.skills.length > 0) {
    output += `\n ${t('Skills:')}`;
    extension.skills.forEach((skill) => {
      output += `\n  ${skill.name}`;
    });
  }
  if (extension.agents && extension.agents.length > 0) {
    output += `\n ${t('Agents:')}`;
    extension.agents.forEach((agent) => {
      output += `\n  ${agent.name}`;
    });
  }
  if (extension.config.mcpServers) {
    output += `\n ${t('MCP servers:')}`;
    Object.keys(extension.config.mcpServers).forEach((key) => {
      output += `\n  ${key}`;
    });
  }
  return output;
}
