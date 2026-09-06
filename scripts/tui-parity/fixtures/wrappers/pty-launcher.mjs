#!/usr/bin/env node
// Test-fixture PTY wrapper: allocates a PTY with the repository node-pty
// capability and runs the given command inside it, streaming the PTY output
// to stdout. Stands in for external wrappers such as expect, tmux, or script
// so the harness's "wrapped" handshake verification is testable on any
// platform without extra tooling.
import process from 'node:process';
import { loadPtyBackend } from '../../lib/capture.mjs';

const argv = process.argv.slice(2);
const backend = loadPtyBackend();
if (!backend) {
  console.error('pty-launcher: no PTY backend available');
  process.exit(2);
}
if (argv.length === 0) {
  console.error('pty-launcher: missing the command to wrap');
  process.exit(2);
}

const rows = Number.parseInt(process.env.LINES ?? '24', 10) || 24;
const cols = Number.parseInt(process.env.COLUMNS ?? '80', 10) || 80;
const ptyProc = backend.spawn(argv[0], argv.slice(1), {
  name: process.env.TERM ?? 'xterm-256color',
  cols,
  rows,
  env: { ...process.env },
});
ptyProc.onData((chunk) => process.stdout.write(chunk));
process.stdin.on('data', (chunk) => {
  try {
    ptyProc.write(chunk.toString());
  } catch {
    /* PTY already closed */
  }
});
ptyProc.onExit(({ exitCode }) => {
  setImmediate(() => process.exit(exitCode ?? 0));
});
