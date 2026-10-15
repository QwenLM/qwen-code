/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fence off the free-text payload of `qwen sessions answer <session>` from
 * every flag scan that runs before and during the yargs parse.
 *
 * `sessions answer` is the one command whose positional tail is arbitrary
 * user prose, so a token like `--help`, `--version` or the bare word
 * `help` inside the answer is indistinguishable from the flag it spells.
 * Three interceptors act on exactly that spelling before any command
 * handler can see it: the bootstrap version scan (`hasVersionToken` in
 * cli.ts) prints the version and exits 0, and the root parser's
 * `.help()`/`.version()` registrations (config.ts) print the usage block
 * or strip the token out of the text — all with exit 0, so a script
 * driving a background session reads success while the answer was never
 * delivered.
 *
 * Inserting a single `--` right after the session id closes every one of
 * those paths at once: tokens after `--` are positional data to yargs and
 * to both bootstrap scans, which stop at the separator by construction.
 * The command's own tail recovery (the raw-args tail in the `answer`
 * command) splices the first `--` back out, so the delivered text is the
 * argv verbatim — the separator is scaffolding, not payload.
 *
 * The match is a strict argv prefix rather than a positional scan: `sessions`
 * as the first token can only be the command (nothing before it can hold a
 * value slot), so there is no value-slot model to get wrong here. A
 * flag-shifted shape (`qwen --debug sessions answer …`) is left to the argv
 * scan consolidation that issue #11065 owns.
 *
 * Carve-outs that keep the command's documented surface intact:
 * - `<session>` must be a real positional. `qwen sessions answer --help`
 *   (no id) keeps routing to the command's help, and a missing id is the
 *   parser's demandOption error to raise, not ours.
 * - A payload that is exactly `--help` (or `-h`) keeps showing the
 *   command's help — the bare-`--help` carve-out the positional's describe
 *   and control-commands tests promise.
 * - A user-supplied separator is never doubled: the tail recovery splices
 *   only the first `--`, so a second one would leak into the answer text.
 */
export function insertSessionAnswerSeparator(
  argv: readonly string[],
): string[] {
  if (argv[0] !== 'sessions' || argv[1] !== 'answer') {
    return argv as string[];
  }
  const session = argv[2];
  if (session === undefined || session.startsWith('-')) {
    return argv as string[];
  }
  // No payload after the id: nothing to fence off.
  if (argv.length < 4) {
    return argv as string[];
  }
  if (argv[3] === '--') {
    return argv as string[];
  }
  // The bare-`--help` carve-out: `answer <session> --help` shows help.
  if (argv.length === 4 && (argv[3] === '--help' || argv[3] === '-h')) {
    return argv as string[];
  }
  return [...argv.slice(0, 3), '--', ...argv.slice(3)];
}
