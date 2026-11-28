/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppPlugin } from './types.js';
import { peersCommand } from '../ui/commands/peersCommand.js';

export class PeersPlugin implements AppPlugin {
  readonly apiVersion = 1 as const;
  readonly id = 'cli-peers';

  async initialize(): Promise<void> {}

  async dispose(): Promise<void> {}

  getSlashCommands() {
    return [peersCommand];
  }
}
