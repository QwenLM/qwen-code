import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';

const KILL_GRACE_MS = 1000;

// The native PTY backend comes from @lydell/node-pty, a declared repository
// dependency. TUI_PARITY_NO_PTY=1 forces unavailability to exercise the
// refusal path in tests.
export function loadPtyBackend() {
  if (process.env.TUI_PARITY_NO_PTY === '1') return null;
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@lydell/node-pty');
    const spawnFn = mod?.spawn ?? mod?.default?.spawn;
    if (typeof spawnFn !== 'function') return null;
    return { kind: 'node-pty', spawn: spawnFn };
  } catch {
    return null;
  }
}

export function handshakeMarkerFound(stdoutText, nonce) {
  const prefix = `\x1b]697;tty-handshake;${nonce}`;
  let index = stdoutText.indexOf(prefix);
  while (index !== -1) {
    const next = stdoutText[index + prefix.length];
    const next2 = stdoutText[index + prefix.length + 1];
    if (next === '\x07' || (next === '\x1b' && next2 === '\\')) return true;
    index = stdoutText.indexOf(prefix, index + 1);
  }
  return false;
}

export const PTY_REFUSAL =
  'native TTY capture refused: no PTY backend is available, and the harness ' +
  'captures real-CLI commands through a native PTY instead of non-TTY pipes; ' +
  'use the repository node-pty capability, or declare the command with ' +
  '"pty": "fixture" (deterministic fixtures) or "pty": "wrapped" (a PTY ' +
  'wrapper that completes the tty-handshake)';

// tty modes:
//   'native'  - the harness allocates a real PTY (enforced real-CLI contract)
//   'fixture' - deterministic fixture that needs no TTY; pipe capture, waived
//   'wrapped' - argv runs inside a caller-supplied PTY wrapper; the harness
//               captures over pipes and verifies the tty-handshake marker
export function capture(command, options = {}) {
  const {
    rows = 24,
    columns = 80,
    timeoutMs = 10000,
    input = [],
    env = {},
    tty = 'native',
  } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const timers = new Set();
    const later = (fn, ms) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        fn();
      }, ms);
      timers.add(handle);
      return handle;
    };
    const clearAllTimers = () => {
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    };

    const ttyEvidence = {
      mode: tty,
      backend: null,
      allocated: false,
      rows,
      columns,
      handshake: null,
    };
    const result = {
      command,
      spawned: false,
      spawnError: null,
      stdoutText: '',
      stderrText: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      timeoutMs,
      tty: ttyEvidence,
    };
    let done = false;
    const settle = (fields) => {
      done = true;
      clearAllTimers();
      resolve({ ...result, durationMs: Date.now() - startedAt, ...fields });
    };

    const childEnv = {
      ...process.env,
      ...env,
      TERM: env.TERM ?? 'xterm-256color',
      LINES: String(rows),
      COLUMNS: String(columns),
      TUI_PARITY: '1',
    };

    let backend = null;
    let ptyProc = null;
    let child = null;
    let nonce = null;
    if (tty === 'native') {
      backend = loadPtyBackend();
      if (!backend) {
        settle({ spawnError: PTY_REFUSAL });
        return;
      }
      ttyEvidence.backend = backend.kind;
      try {
        ptyProc = backend.spawn(command[0], command.slice(1), {
          name: childEnv.TERM,
          cols: columns,
          rows,
          env: childEnv,
        });
      } catch (err) {
        settle({ spawnError: err.message });
        return;
      }
      ttyEvidence.allocated = true;
    } else {
      if (tty === 'wrapped') {
        nonce = randomUUID();
        childEnv.TUI_PARITY_PTY_NONCE = nonce;
      }
      try {
        child = spawn(command[0], command.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          env: childEnv,
        });
      } catch (err) {
        settle({ spawnError: err.message });
        return;
      }
    }

    const chunks = [];
    const stderrChunks = [];
    if (ptyProc) {
      // A PTY merges stderr into the terminal stream, as a real terminal sees.
      ptyProc.onData((chunk) => chunks.push(Buffer.from(chunk)));
    } else {
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    }

    let timedOut = false;
    const pid = ptyProc ? ptyProc.pid : child.pid;
    const signalPid = (target, signal) => {
      try {
        process.kill(target, signal);
        return true;
      } catch {
        return false;
      }
    };
    const killTree = (signal) => {
      if (!Number.isInteger(pid)) return;
      if (signalPid(-pid, signal)) return;
      if (signalPid(pid, signal)) return;
      if (ptyProc) {
        try {
          ptyProc.kill(signal);
        } catch {
          /* best effort */
        }
      }
    };
    later(() => {
      timedOut = true;
      killTree('SIGTERM');
      later(() => killTree('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    const writeInput = (index) => {
      if (done) return;
      if (index >= input.length) {
        if (child) {
          try {
            child.stdin.end();
          } catch {
            /* already closed */
          }
        }
        return;
      }
      const step = input[index];
      const delay = Number.isInteger(step.delayMs) ? step.delayMs : 0;
      later(() => {
        if (done) return;
        try {
          if (ptyProc) ptyProc.write(step.data ?? '');
          else child.stdin.write(step.data ?? '');
        } catch {
          /* child already gone */
        }
        writeInput(index + 1);
      }, delay);
    };
    writeInput(0);

    const finish = (fields) => {
      if (done) return;
      const stdoutBuf = Buffer.concat(chunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      if (nonce) {
        ttyEvidence.handshake = handshakeMarkerFound(
          stdoutBuf.toString('utf8'),
          nonce,
        )
          ? 'verified'
          : 'missing';
      }
      if (ptyProc) {
        try {
          ptyProc.destroy();
        } catch {
          /* best effort */
        }
      }
      settle({
        spawned: true,
        pid,
        stdoutText: stdoutBuf.toString('utf8'),
        stderrText: stderrBuf.toString('utf8'),
        stdoutBytes: stdoutBuf.length,
        stderrBytes: stderrBuf.length,
        timedOut,
        ...fields,
      });
    };

    if (ptyProc) {
      ptyProc.onExit(({ exitCode, signal }) => {
        const normalized =
          signal === 0 || signal === '' || signal == null ? null : signal;
        // One tick lets the PTY reader drain final output before closing.
        setImmediate(() => finish({ exitCode, signal: normalized }));
      });
    } else {
      child.on('error', (err) =>
        finish({ spawned: false, spawnError: err.message }),
      );
      child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
    }
  });
}
