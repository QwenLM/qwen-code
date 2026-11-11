/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 开放 headless 会话在 open 之后、initialize 之前的通用装配：fast hooks。
 * 认证、进程身份等产品能力由产品会话实现自行组合。
 */

import {
  BRAND_FIXED_ENV_PREFIX,
  type Config,
  runLogger,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import { isEnvTruthy } from '../ink/stubs/envUtils.js';

const HEADLESS_FAST_HOOKS_ENV = `${BRAND_FIXED_ENV_PREFIX}HEADLESS_FAST_HOOKS`;

export interface HeadlessStartupOptions {
  readonly config: Config;
  readonly settings: LoadedSettings;
  readonly cliArgs: CliArgs;
}

export async function prepareHeadlessSession(
  options: HeadlessStartupOptions,
): Promise<void> {
  applyFastHooks(options.config, options.settings, options.cliArgs);
}

function applyFastHooks(
  config: Config,
  settings: LoadedSettings,
  cliArgs: CliArgs,
): void {
  if (
    cliArgs.headlessFastHooks !== true &&
    !isEnvTruthy(HEADLESS_FAST_HOOKS_ENV) &&
    settings.merged.hooksConfig.headlessFastMode !== true
  ) {
    return;
  }
  config.setAllHooksDisabled(true);
  runLogger.warn(
    '[hooks] Headless fast hook mode enabled; user hooks are disabled for this headless session.',
  );
}
