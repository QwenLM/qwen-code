/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedWecomAdapter,
  createManagedWecomDeps,
} from '@qwen-code/channel-wecom';
import { createManagedChannelCommand } from './managed-channel-command.js';

// The WeCom intelligent-bot adapter on the managed path. An experimental,
// explicitly selected entry: `qwen channel start` never picks it, and it
// drives no model — it routes inbound bot messages into bound Sessions
// through the control plane and sends the receipted replies back. Both
// directions ride the SDK WebSocket, so there is no egress proxy to resolve
// (the Legacy WeCom channel has none either).

export const managedWecomCommand = createManagedChannelCommand({
  command: 'managed-wecom <name>',
  adapterType: 'wecom',
  label: 'WeCom',
  nameDescribe: 'The configured WeCom channel to run on the managed path',
  cwdDescribe:
    'Local workspace for channel config resolution; the channel' +
    " config's own cwd (defaulting to this flag) scopes the managed" +
    ' state directory, so one state directory and one lock serialize' +
    ' the managed instances of this configured entry',
  createAdapter: (channel, controlPlane) =>
    new ManagedWecomAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      controlPlane,
      deps: createManagedWecomDeps(),
    }),
});
