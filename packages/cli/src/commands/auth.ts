/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { t } from '../i18n/index.js';

const shouldUseColor = () =>
  Boolean(process.stdout.isTTY && !process.env['NO_COLOR']);

const color = (value: string, code: string) =>
  shouldUseColor() ? `\x1b[${code}m${value}\x1b[0m` : value;

const cyan = (value: string) => color(value, '36');
const yellow = (value: string) => color(value, '33');

export const buildRemovalNotice = (): string =>
  [
    '',
    yellow(t('⚠  qwen auth has been removed.')),
    '',
    `  ${cyan(t('Interactive'))}   →  ${t('run qwen and use /auth to configure providers')}`,
    `  ${cyan(t('CI / Headless'))} →  ${t('set provider environment variables, for example OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')}`,
    `                     ${t('or pass --openai-api-key, --openai-base-url, --model')}`,
    `  ${cyan(t('Coding Plan'))}   →  ${t('set BAILIAN_CODING_PLAN_API_KEY and use the Coding Plan base URL for your region')}`,
    `                     ${t('China: https://coding.dashscope.aliyuncs.com/v1')}`,
    `                     ${t('International: https://coding-intl.dashscope.aliyuncs.com/v1')}`,
    `  ${cyan(t('OpenRouter'))}    →  ${t('set OPENROUTER_API_KEY and OPENAI_BASE_URL=https://openrouter.ai/api/v1')}`,
    `  ${cyan(t('Qwen OAuth'))}    →  ${t('run qwen interactively and use /auth; OAuth cannot be configured with env vars alone')}`,
    `  ${cyan(t('Scripted'))}      →  ${t('edit ~/.qwen/settings.json, or run qwen interactively once')}`,
    '',
    `  ${t('Check auth status')} → ${cyan('/doctor')}`,
    '',
  ].join('\n');

export const printRemovalNotice = () => {
  process.stdout.write(buildRemovalNotice(), () => process.exit(0));
};

const legacySubcommands = [
  'status',
  'coding-plan',
  'openrouter',
  'api-key',
  'qwen-oauth',
];

export const authCommand: CommandModule = {
  command: 'auth',
  describe: t('Configure authentication (removed)'),
  builder: (yargs: Argv) => {
    let y = yargs.version(false).strict(false);
    for (const name of legacySubcommands) {
      y = y.command({
        command: `${name} [legacyArgs..]`,
        describe: false,
        builder: (subYargs: Argv) => subYargs.strict(false),
        handler: printRemovalNotice,
      });
    }
    return y;
  },
  handler: printRemovalNotice,
};
