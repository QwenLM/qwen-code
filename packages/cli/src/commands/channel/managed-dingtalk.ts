/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedDingtalkAdapter,
  createManagedDingtalkDeps,
  dingtalkSettings,
} from '@qwen-code/channel-dingtalk';
import { loadSettings } from '../../config/settings.js';
import { resolveProxyUrl } from './proxy.js';
import { createManagedChannelCommand } from './managed-channel-command.js';

// H5d of #12827: the DingTalk reference adapter on the managed path. An
// experimental, explicitly selected entry: `qwen channel start` never picks
// it, and it drives no model — it routes inbound robot messages into bound
// Sessions through the control plane and sends the receipted replies back.

export const managedDingtalkCommand = createManagedChannelCommand({
  command: 'managed-dingtalk <name>',
  adapterType: 'dingtalk',
  label: 'DingTalk',
  nameDescribe: 'The configured DingTalk channel to run on the managed path',
  cwdDescribe:
    'Local workspace for channel config resolution; it also scopes' +
    ' the managed state directory, so one state directory and one' +
    ' lock serialize the managed instances of this robot app',
  createAdapter: (channel, controlPlane, cwd) => {
    // Resolve the egress proxy the same way the Legacy daemon worker does, so
    // a proxy-only deployment delivers replies instead of silently losing them
    // while inbound keeps working.
    const settings = loadSettings(cwd);
    const proxy = resolveProxyUrl(
      undefined,
      settings.merged.proxy as string | undefined,
    );
    // The card API exchanges its access token from the robot app credential;
    // pass the parsed credential so the deps supply the card send (H5e). The
    // adapter still gates card rendering on its capability and cardTemplateId.
    const credentials = dingtalkSettings(channel.config);
    return new ManagedDingtalkAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      controlPlane,
      deps: createManagedDingtalkDeps(proxy, {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      }),
    });
  },
});
