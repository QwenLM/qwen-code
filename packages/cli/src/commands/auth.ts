/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule, Argv } from 'yargs';
import {
  handleQwenAuth,
  runInteractiveAuth,
  showAuthStatus,
} from './auth/handler.js';
import { t } from '../i18n/index.js';

// Define subcommands separately
// NOTE: qwen-oauth subcommand is temporarily disabled (free tier discontinued).
// The code is kept for potential future re-enablement.
// const qwenOauthCommand = {
//   command: 'qwen-oauth',
//   describe: t('Authenticate using Qwen OAuth'),
//   handler: async () => {
//     await handleQwenAuth('qwen-oauth', {});
//   },
// };

const codePlanCommand = {
  command: 'coding-plan',
  describe: t('Authenticate using Alibaba Cloud Coding Plan'),
  builder: (yargs: Argv) =>
    yargs
      .option('region', {
        alias: 'r',
        describe: t('Region for Coding Plan (china/global)'),
        type: 'string',
      })
      .option('key', {
        alias: 'k',
        describe: t('API key for Coding Plan'),
        type: 'string',
      }),
  handler: async (argv: { region?: string; key?: string }) => {
    const region = argv['region'] as string | undefined;
    const key = argv['key'] as string | undefined;

    // If region and key are provided, use them directly
    if (region && key) {
      await handleQwenAuth('coding-plan', { region, key });
    } else {
      // Otherwise, prompt interactively
      await handleQwenAuth('coding-plan', {});
    }
  },
};

const statusCommand = {
  command: 'status',
  describe: t('Show current authentication status'),
  handler: async () => {
    await showAuthStatus();
  },
};

export const authCommand: CommandModule = {
  command: 'auth',
  describe: t(
    'Configure Qwen authentication information with Alibaba Cloud Coding Plan or API Key',
  ),
  builder: (yargs: Argv) =>
    yargs
      .command(codePlanCommand)
      .command(statusCommand)
      .demandCommand(0) // Don't require a subcommand
      .version(false),
  handler: async () => {
    // This handler is for when no subcommand is provided - show interactive menu
    await runInteractiveAuth();
  },
};
