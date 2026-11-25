/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command, Option } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import { registerAppPluginRootOptions } from './commands.js';

describe('app plugin root option replacement', () => {
  it('replaces a host option with the same primary flag', async () => {
    const program = new Command()
      .addOption(new Option('--list-models'))
      .exitOverride();
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const registration = registerAppPluginRootOptions(program, [
      {
        getRootOptions: () => [
          {
            option: new Option('--list-models'),
            action,
          },
        ],
      },
    ]);

    await program.parseAsync(['--list-models'], { from: 'user' });
    const options = program.opts();

    expect(program.options.filter((o) => o.long === '--list-models')).toHaveLength(
      1,
    );
    expect(registration.replacedRootOptions.has('listModels')).toBe(true);
    const candidates = registration.validate(options);
    expect(candidates).toHaveLength(1);
    expect(
      registration.selectAction(candidates, options),
    ).toBeTypeOf('function');
  });
});
