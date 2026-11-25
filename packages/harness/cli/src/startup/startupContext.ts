/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  sessionId as generatedInitialSessionId,
  type Config,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import type { StartupPolicy } from './startupPolicy.js';
import type { EntryFramework } from '../framework/entryFramework.js';

export interface ShellBootstrap {
  cwd: string;
  isDebugMode: boolean;
  nodeMemoryArgs: string[];
}

export interface SettingsBootstrap {
  settings: LoadedSettings;
  argv: CliArgs;
}

export interface SessionBootstrap {
  initialSessionId: string;
}

export function createSessionBootstrap(
  argv: Pick<CliArgs, 'sessionId'>,
): SessionBootstrap {
  return {
    initialSessionId: argv.sessionId ?? generatedInitialSessionId,
  };
}

interface StartupContextBase {
  shell: ShellBootstrap;
  settings: SettingsBootstrap;
  session: SessionBootstrap;
  policy: StartupPolicy;
}

export type ConfiguredStartupContext = StartupContextBase & {
  phase: 'configured';
  config: Config;
  framework: EntryFramework;
};
