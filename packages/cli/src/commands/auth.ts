/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deprecated since v0.15.8: the `qwen auth` CLI subcommand has been removed.
 *
 * Interactive users should use the richer /auth TUI dialog instead.
 * CI/headless users should configure authentication via env vars or CLI flags.
 */

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

const printRemovalNotice = () => {
  writeStdoutLine(
    '\n' +
      '\x1b[33m⚠  qwen auth has been removed since v0.15.8\x1b[0m\n' +
      '\n' +
      '  \x1b[36mInteractive\x1b[0m   →  run qwen and use /auth to configure (8+ providers, guided setup)\n' +
      '  \x1b[36mCI / Headless\x1b[0m →  set OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL env vars\n' +
      '                     or pass --openai-api-key, --openai-base-url, --model\n' +
      '  \x1b[36mScripted\x1b[0m      →  edit \x1b[36m~/.qwen/settings.json\x1b[0m, or run qwen interactively once\n' +
      '\n' +
      '  Check auth status → \x1b[36m/doctor\x1b[0m\n',
  );
  process.exit(0);
};

// Redirect old subcommands to the removal notice so users who run
// `qwen auth status` / `qwen auth coding-plan` etc. aren't met with
// a raw yargs "Unknown argument" error.
const legacySubcommands = [
  'status',
  'coding-plan',
  'openrouter',
  'api-key',
  'qwen-oauth',
];

export const authCommand: CommandModule = {
  command: 'auth',
  describe: 'Configure authentication (removed since v0.15.8)',
  builder: (yargs) => {
    let y = yargs.version(false);
    for (const name of legacySubcommands) {
      y = y.command({
        command: name,
        describe: '',
        handler: printRemovalNotice,
      });
    }
    return y;
  },
  handler: printRemovalNotice,
};
