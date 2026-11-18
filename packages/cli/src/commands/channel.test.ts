/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import yargs from 'yargs';
import { channelCommand } from './channel.js';

// #17173 R2-10: the managed subcommands are registered on the channel command
// tree, but no test drove that registration — dropping a .command() line left
// every suite green. Parse the real tree with missing required flags: a
// registered subcommand fails on its own demandOption contract, while an
// unregistered one falls through to the parent's demandCommand verdict and
// never mentions the subcommand's flags.

async function registrationFailure(subcommand: string): Promise<string> {
  let failure = '';
  try {
    await yargs(['channel', subcommand, 'chan'])
      .command(channelCommand)
      .exitProcess(false)
      .fail((msg: string) => {
        failure = msg;
        // A capturing fail that does not throw would let yargs continue into
        // the handler; stop the parse at the validation verdict.
        throw new Error(msg);
      })
      .parseAsync();
  } catch {
    // The captured verdict is the assertion target.
  }
  return failure;
}

describe('channel command registration (#17173 R2-10)', () => {
  it('registers managed-dingtalk with its required-flag contract', async () => {
    expect(await registrationFailure('managed-dingtalk')).toContain(
      'control-plane',
    );
  });

  it('registers managed-email with its required-flag contract', async () => {
    expect(await registrationFailure('managed-email')).toContain(
      'control-plane',
    );
  });

  it('registers managed-github with its required-flag contract', async () => {
    expect(await registrationFailure('managed-github')).toContain(
      'control-plane',
    );
  });

  it('registers managed-wecom with its required-flag contract', async () => {
    expect(await registrationFailure('managed-wecom')).toContain(
      'control-plane',
    );
  });
});
