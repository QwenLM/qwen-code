/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedGithubAdapter,
  createManagedGithubDeps,
} from '@qwen-code/channel-github';
import { loadSettings } from '../../config/settings.js';
import { resolveProxyUrl } from './proxy.js';
import { createManagedChannelCommand } from './managed-channel-command.js';

// H5f of #12827: the GitHub adapter on the managed path. An experimental,
// explicitly selected entry: `qwen channel start` never picks it, and it
// drives no model — it routes @mention comments into bound Sessions through
// the control plane and posts the receipted replies back to the thread.

export const managedGithubCommand = createManagedChannelCommand({
  command: 'managed-github <name>',
  adapterType: 'github',
  label: 'GitHub',
  nameDescribe: 'The configured GitHub channel to run on the managed path',
  cwdDescribe:
    'Local workspace for channel config resolution; it also scopes' +
    ' the managed state directory, so one state directory and one' +
    ' lock serialize the managed instances of this channel endpoint',
  createAdapter: (channel, controlPlane, cwd) => {
    // Resolve the egress proxy the same way the Legacy daemon worker does, so
    // a proxy-only deployment delivers replies instead of silently losing them
    // while inbound keeps working.
    const settings = loadSettings(cwd);
    const proxy = resolveProxyUrl(
      undefined,
      settings.merged.proxy as string | undefined,
    );
    return new ManagedGithubAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      // The pre-parse entry: parseChannelConfig injects policy defaults, so the
      // adapter judges an explicit groupPolicy / managed-policy choice on the
      // raw entry, not the fully-defaulted parse result.
      rawConfig: channel.rawConfig,
      controlPlane,
      deps: createManagedGithubDeps(proxy),
    });
  },
});
