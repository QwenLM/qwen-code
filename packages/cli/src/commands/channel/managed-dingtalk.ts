/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  ManagedDingtalkAdapter,
  createManagedDingtalkDeps,
} from '@qwen-code/channel-dingtalk';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { HttpManagedChannelControlPlane } from './managed-channel-client.js';
import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';

// H5d of #12827: the DingTalk reference adapter on the managed path. An
// experimental, explicitly selected entry: `qwen channel start` never picks
// it, and it drives no model — it routes inbound robot messages into bound
// Sessions through the control plane and sends the receipted replies back.

interface ManagedDingtalkArgs {
  name: string;
  'control-plane': string;
  tenant: string;
  actor: string;
  workspace: string;
  'channel-id'?: string;
  'cwd-relative': string;
  cwd: string;
}

export const managedDingtalkCommand: CommandModule<
  unknown,
  ManagedDingtalkArgs
> = {
  command: 'managed-dingtalk <name>',
  describe: false,
  builder: (yargs) =>
    yargs
      .positional('name', {
        type: 'string',
        demandOption: true,
        describe: 'The configured DingTalk channel to run on the managed path',
      })
      .option('control-plane', {
        type: 'string',
        demandOption: true,
        description: 'Internal listener base URL of the managed control plane',
      })
      .option('tenant', {
        type: 'string',
        demandOption: true,
        description: 'Tenant the channel belongs to',
      })
      .option('actor', {
        type: 'string',
        demandOption: true,
        description: 'Actor that owns the Sessions the channel creates',
      })
      .option('workspace', {
        type: 'string',
        demandOption: true,
        description: 'Registered Workspace the channel Sessions bind to',
      })
      .option('channel-id', {
        type: 'string',
        description: 'Channel instance id (defaults to the channel name)',
      })
      .option('cwd-relative', {
        type: 'string',
        default: '.',
        description: 'Relative directory inside the Workspace',
      })
      .option('cwd', {
        type: 'string',
        default: process.cwd(),
        description:
          'Local workspace for channel config resolution; must be the' +
          ' directory the Legacy path (daemon worker) resolves for the' +
          ' same channel, so one state directory and one lock serve the' +
          ' robot app',
      }),
  handler: async (argv) => {
    const [channel] = await parseConfiguredChannels(
      loadChannelsConfig(argv.cwd),
      [argv.name],
      { defaultCwd: argv.cwd },
    );
    if (channel?.config['type'] !== 'dingtalk') {
      throw new Error(
        `Channel "${argv.name}" is not a DingTalk channel; the managed path serves DingTalk only.`,
      );
    }
    const controlPlane = new HttpManagedChannelControlPlane({
      baseUrl: argv['control-plane'],
      tenantId: argv.tenant,
      channelId: argv['channel-id'] ?? argv.name,
      actorId: argv.actor,
      workspaceId: argv.workspace,
      cwdRelative: argv['cwd-relative'],
    });
    const adapter = new ManagedDingtalkAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      controlPlane,
      deps: createManagedDingtalkDeps(),
    });
    await adapter.connect();
    writeStderrLine(
      `Managed DingTalk channel "${channel.name}" is running (generation ${adapter.generation}).`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    await adapter.disconnect();
  },
};
