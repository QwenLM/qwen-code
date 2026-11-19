/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import yargs, { type CommandModule } from 'yargs';
import { managedDingtalkCommand } from './managed-dingtalk.js';
import { managedEmailCommand } from './managed-email.js';
import { managedGithubCommand } from './managed-github.js';
import { managedWecomCommand } from './managed-wecom.js';
import type { ManagedChannelArgs } from './managed-channel-command.js';

// #17173 R1-4: the consolidated builder owns the option contract of the
// managed commands, but the handler-level suites pass a hand-built argv and
// never exercise it. Drive the real builder through yargs so a dropped
// demandOption, default, or the hidden-from-help flag reds a case.

type ManagedCommand = CommandModule<unknown, ManagedChannelArgs>;

const cases: Array<[string, ManagedCommand]> = [
  ['managed-dingtalk', managedDingtalkCommand],
  ['managed-email', managedEmailCommand],
  ['managed-github', managedGithubCommand],
  ['managed-wecom', managedWecomCommand],
];

const requiredPairs: Array<[string, string]> = [
  ['--control-plane', 'http://127.0.0.1:4181'],
  ['--tenant', 'tenant-1'],
  ['--actor', 'owner'],
  ['--workspace', 'ws-1'],
];

function parse(cmd: ManagedCommand, args: string[]): Record<string, unknown> {
  return yargs(args)
    .command({ ...cmd, handler: () => {} })
    .demandCommand(1)
    .strict()
    .exitProcess(false)
    .parse() as Record<string, unknown>;
}

describe('managed channel command argument surface', () => {
  for (const [name, cmd] of cases) {
    it(`${name} stays hidden from help`, () => {
      expect(cmd.describe).toBe(false);
    });

    it(`${name} defaults --cwd-relative and --cwd`, () => {
      const argv = parse(cmd, [name, 'chan', ...requiredPairs.flat()]);
      expect(argv['cwd-relative']).toBe('.');
      expect(argv['cwd']).toBe(process.cwd());
    });

    it(`${name} leaves --channel-id optional`, () => {
      const argv = parse(cmd, [name, 'chan', ...requiredPairs.flat()]);
      expect(argv['channel-id']).toBeUndefined();
    });

    for (const [flag] of requiredPairs) {
      it(`${name} demands ${flag}`, () => {
        const args = requiredPairs
          .filter(([candidate]) => candidate !== flag)
          .flat();
        expect(() => parse(cmd, [name, 'chan', ...args])).toThrow();
      });
    }
  }
});
