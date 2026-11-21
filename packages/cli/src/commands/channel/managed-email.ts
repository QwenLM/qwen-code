/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedEmailAdapter,
  createManagedEmailDeps,
} from '@qwen-code/channel-email';
import { createManagedChannelCommand } from './managed-channel-command.js';

// H5b/H5c of #12827: the email reference adapter on the managed path. An
// experimental, explicitly selected entry: `qwen channel start` never picks
// it, and it drives no model — it routes inbound mail into bound Sessions
// through the control plane and sends the receipted replies back.

export const managedEmailCommand = createManagedChannelCommand({
  command: 'managed-email <name>',
  adapterType: 'email',
  label: 'email',
  nameDescribe: 'The configured email channel to run on the managed path',
  cwdDescribe:
    'Local workspace for channel config resolution; must be the' +
    ' directory the Legacy path (daemon worker) resolves for the' +
    ' same channel, so one state directory and one lock serve the' +
    ' mailbox',
  createAdapter: (channel, controlPlane) =>
    new ManagedEmailAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      controlPlane,
      deps: createManagedEmailDeps(),
    }),
});
