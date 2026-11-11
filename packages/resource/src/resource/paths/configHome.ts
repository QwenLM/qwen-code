/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Hosts inject `homeDir` through options; this fallback must not reach into
// @qwen-code/core, which would invert the dependency direction.
// oxlint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface ConfigHomeOptions {
  homeDir?: string;
  configDirName?: string;
}

export function resolveConfigHome(options: ConfigHomeOptions = {}): string {
  const home = options.homeDir ?? homedir();
  return resolve(home, options.configDirName ?? '.qwen');
}
