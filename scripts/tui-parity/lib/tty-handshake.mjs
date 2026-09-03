#!/usr/bin/env node
// PTY wrapper handshake helper. Run this script INSIDE a real PTY (for
// example via expect, tmux, or `script`); it verifies that its own stdout is
// a TTY, emits the run's tty-handshake marker, and then execs the wrapped
// command with inherited stdio. The parity harness sets TUI_PARITY_PTY_NONCE
// and verifies the marker in the captured stream; without both the TTY and
// the nonce it refuses instead of claiming PTY capture.
import { spawn } from 'node:child_process';
import process from 'node:process';

const argv = process.argv.slice(2);
const nonce = process.env.TUI_PARITY_PTY_NONCE ?? '';

if (argv.length === 0) {
  console.error('tty-handshake: missing the wrapped command');
  process.exit(2);
}
if (!process.stdout.isTTY) {
  console.error(
    'tty-handshake: stdout is not a TTY; refusing to claim PTY capture',
  );
  process.exit(2);
}
if (nonce === '') {
  console.error(
    'tty-handshake: TUI_PARITY_PTY_NONCE is not set; the parity harness ' +
      'must start this capture in "wrapped" mode',
  );
  process.exit(2);
}

process.stdout.write(`\x1b]697;tty-handshake;${nonce}\x07`);
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
child.on('close', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
