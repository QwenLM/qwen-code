/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { AcpChannelExitInfo, ChannelFactory } from './channel.js';
import { MissingCliEntryError } from './status.js';

let cachedMemoryArgs: string[] | undefined;
export function getAcpMemoryArgs(): string[] {
  if (cachedMemoryArgs) return cachedMemoryArgs;
  const constrainedMemory = (process as { constrainedMemory?: () => number })
    .constrainedMemory;
  const constrained =
    typeof constrainedMemory === 'function' ? constrainedMemory() : 0;
  const totalBytes =
    constrained && constrained > 0 ? constrained : os.totalmem();
  const totalMB = Math.floor(totalBytes / (1024 * 1024));
  const targetMB = Math.min(Math.floor(totalMB * 0.5), 16_384);
  const currentLimitMB = Math.floor(
    getHeapStatistics().heap_size_limit / (1024 * 1024),
  );
  cachedMemoryArgs = [
    ...(targetMB > currentLimitMB ? [`--max-old-space-size=${targetMB}`] : []),
    '--expose-gc',
  ];
  return cachedMemoryArgs;
}

// ──────────────────────────────────────────────────────────────────────
// Stderr forwarder — extracted from the inline handler so it's testable
// in isolation without spawning a real child process.
// ──────────────────────────────────────────────────────────────────────

export interface StderrForwarderOptions {
  prefix: string;
  onDiagnosticLine?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Creates a stateful forwarder that buffers incoming chunks, splits on
 * newlines, writes each complete line to `process.stderr` with a prefix,
 * and optionally invokes `onDiagnosticLine` for external consumers (e.g.
 * the daemon log file writer).
 *
 * Cap behavior: if the unterminated buffer exceeds 64 KiB the excess is
 * force-flushed with a `[truncated]` marker — same memory-bounding
 * behavior as before the extraction.
 */
export function createStderrForwarder(opts: StderrForwarderOptions): {
  onData: (chunk: string) => void;
  onEnd: () => void;
} {
  const { prefix, onDiagnosticLine } = opts;
  const STDERR_LINE_CAP_CHARS = 64 * 1024;
  let buf = '';

  const flush = (line: string) => {
    if (line.length > 0) {
      process.stderr.write(prefix + line + '\n');
      if (onDiagnosticLine) onDiagnosticLine(prefix + line, 'warn');
    }
  };

  return {
    onData(chunk: string) {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      // Force-flush the unterminated tail if it's grown past the cap
      // — keeps memory bounded against a `\n`-less stderr storm.
      while (buf.length > STDERR_LINE_CAP_CHARS) {
        const truncated = buf.slice(0, STDERR_LINE_CAP_CHARS) + ' [truncated]';
        process.stderr.write(prefix + truncated + '\n');
        if (onDiagnosticLine) onDiagnosticLine(prefix + truncated, 'warn');
        buf = buf.slice(STDERR_LINE_CAP_CHARS);
      }
    },
    onEnd() {
      if (buf.length > 0) flush(buf);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// SpawnChannelFactory — configurable factory-of-factories
// ──────────────────────────────────────────────────────────────────────

export interface SpawnChannelFactoryOptions {
  onDiagnosticLine?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Creates a `ChannelFactory` that spawns `qwen --acp` child processes.
 * Accepts an optional `onDiagnosticLine` callback that receives every
 * child-stderr line (already prefixed) so callers can tee to a log file
 * or structured logger without intercepting process.stderr globally.
 *
 * `defaultSpawnChannelFactory` below is `createSpawnChannelFactory()` —
 * no options, same behavior as before this refactor.
 */
export function createSpawnChannelFactory(
  options: SpawnChannelFactoryOptions = {},
): ChannelFactory {
  return async (workspaceCwd, childEnvOverrides) => {
    const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
    if (!cliEntry) {
      throw new MissingCliEntryError();
    }
    const childEnv = scrubChildEnv(
      process.env,
      SCRUBBED_CHILD_ENV_KEYS,
      childEnvOverrides,
    );
    childEnv['QWEN_CODE_NO_RELAUNCH'] = 'true';

    const memoryArgs = getAcpMemoryArgs();
    const execArgs = process.execArgv.filter(
      (a) => !/^--inspect(-brk)?($|=)/.test(a),
    );
    const child = spawn(
      process.execPath,
      [...execArgs, ...memoryArgs, cliEntry, '--acp'],
      {
        cwd: workspaceCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      },
    );

    // Forward child stderr to the daemon's stderr line-by-line, with a
    // `[serve pid=… cwd=…]` prefix on each line so operators can
    // correlate stack traces back to the spawning request.
    if (child.stderr) {
      const prefix = `[serve pid=${child.pid} cwd=${workspaceCwd}] `;
      const forwarder = createStderrForwarder({
        prefix,
        onDiagnosticLine: options.onDiagnosticLine,
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', forwarder.onData);
      child.stderr.on('end', forwarder.onEnd);
      child.stderr.on('error', () => {
        // Don't crash the daemon if the pipe breaks; the child is
        // already gone or about to be.
      });
    }

    const exited = new Promise<AcpChannelExitInfo | undefined>((resolve) => {
      let resolved = false;
      const finish = (info?: AcpChannelExitInfo) => {
        if (resolved) return;
        resolved = true;
        resolve(info);
      };
      child.once('exit', (code, signal) =>
        finish({ exitCode: code, signalCode: signal }),
      );
      child.once('error', () => finish(undefined));
    });

    if (!child.stdin || !child.stdout) {
      child.kill('SIGKILL');
      throw new Error(
        'Spawned ACP child has no stdin/stdout — cannot establish NDJSON channel.',
      );
    }

    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    return {
      stream,
      kill: () => killChild(child),
      killSync: () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead / pid recycled — ignore */
          }
        }
      },
      exited,
    };
  };
}

/**
 * Default channel factory: spawn the current Node executable running this
 * CLI's entry script in `--acp` mode. `process.argv[1]` resolves to the qwen
 * entry script when launched via the `qwen` bin shim.
 *
 * Note on `cwd`: CodeQL flags the `workspaceCwd` flow into `spawn({cwd})`
 * as an "uncontrolled data used in path expression" finding. That's the
 * Stage 1 trust model speaking — the caller (a token-authenticated HTTP
 * client) is treated as an extension of the operator. The agent already
 * runs as the same UID with shell-tool access, so restricting the spawn
 * cwd to a sandbox here would be theatre. Stage 4+ remote-sandbox swaps
 * this factory for a sandbox-aware variant; see the remote-sandbox plan.
 *
 * Lifted from `cli/src/serve/httpAcpBridge.ts` to `@qwen-code/acp-bridge`
 * so `channels/base/AcpBridge.ts` and the VSCode IDE
 * companion can share one spawn implementation instead of each
 * reimplementing the child lifecycle (the current divergence noted in
 * `channel.ts`'s top-of-file comment).
 *
 * Preserved as `createSpawnChannelFactory()` (no options) for backward
 * compat. Use `createSpawnChannelFactory({ onDiagnosticLine })` to also
 * tee child stderr lines through an external callback.
 */
export const defaultSpawnChannelFactory: ChannelFactory =
  createSpawnChannelFactory();

const KILL_HARD_DEADLINE_MS = 10_000;

/**
 * Environment variables stripped from the spawned `qwen --acp` child's
 * environment. Everything else is passed through — see the
 * threat-model rationale at the call site in `defaultSpawnChannelFactory`.
 *
 * Currently just `QWEN_SERVER_TOKEN`: the daemon's own bearer token,
 * which the agent doesn't need (it speaks to the daemon over stdio,
 * not HTTP). Leaving it in the child's env would let prompt injection
 * turn the agent into an authenticated client of its own daemon — an
 * escalation the agent doesn't otherwise have.
 *
 * **WARNING**: this denylist is correct *only because the agent
 * already has unrestricted shell-tool access* — anything in the env
 * is reachable via `~/.bashrc`/`~/.aws/credentials`/etc. anyway.
 * Any future mode that **removes** shell-tool access (e.g. a
 * sandbox-locked agent variant) MUST switch this back to an
 * allowlist OR significantly expand the denylist to cover common
 * provider/CI/cloud secret prefixes (`OPENAI_*`, `ANTHROPIC_*`,
 * `AWS_*`, `GITHUB_TOKEN`, `CI_*`, `*_API_KEY`, `*_SECRET`, …).
 * See the remote-sandbox plan for Stage 4+.
 *
 * Defined at module scope so the Set is allocated once at load.
 */
const SCRUBBED_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  'QWEN_SERVER_TOKEN',
]);

/**
 * Build the env passed to the `qwen --acp` child. Pure function, exported
 * for unit-test access (the surrounding `defaultSpawnChannelFactory` is
 * unit-test-hostile because it actually spawns Node). Behavior:
 *
 *   1. Start from a shallow clone of `source` (no aliasing into the
 *      daemon's `process.env`).
 *   2. Delete every key listed in `scrubbed` (the daemon-internal secret
 *      denylist — currently just `QWEN_SERVER_TOKEN`, see security
 *      rationale on the constant).
 *   3. Apply `overrides` per-handle. `undefined` value deletes the key
 *      (lets an embedded caller scrub a stale inherited var without
 *      mutating the daemon's global `process.env`). Anything else
 *      assigns. **`overrides` CANNOT re-introduce a scrubbed key** —
 *      defense-in-depth so an operator passing
 *      `{ QWEN_SERVER_TOKEN: 'x' }` in overrides can't smuggle the
 *      daemon's bearer token back into the child.
 *
 * Used by `defaultSpawnChannelFactory` above. The split mirrors the
 * "scrub" comment block's structure 1:1; behavior is byte-identical to
 * the pre-extraction inline implementation.
 */
export function scrubChildEnv(
  source: NodeJS.ProcessEnv,
  scrubbed: ReadonlySet<string>,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...source };
  for (const key of scrubbed) {
    delete childEnv[key];
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (scrubbed.has(key)) continue;
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
  }
  return childEnv;
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!resolved && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* swallow */
        }
      }
    }, 5_000).unref();
    // Even SIGKILL doesn't return if the child is in uninterruptible
    // sleep (D-state, e.g. NFS read blocked on a dead server). Without
    // this hard deadline, `bridge.shutdown()`'s `Promise.all` waits
    // forever on that one wedged child and SHUTDOWN_FORCE_CLOSE_MS in
    // `runQwenServe` only covers `server.close()`, not the bridge.
    // After the deadline give up: the child is probably stuck in a
    // kernel call we can't cancel, and `process.exit(0)` will reap it
    // when the daemon returns to its caller.
    //
    // Emit a stderr line BEFORE we
    // abandon the child so operators see a signal that a zombie
    // exists. Without this, `shutdown()` returns "graceful" while a
    // wedged `qwen --acp` process keeps holding FDs / memory / locks;
    // under systemd/k8s supervision, the daemon respawn would then
    // race the orphan for the same workspace. Single-line warning is
    // intentionally noisy on the daemon's stderr so monitoring/log
    // aggregators catch it.
    setTimeout(() => {
      if (!resolved) {
        process.stderr.write(
          `qwen serve: killChild hard deadline (${KILL_HARD_DEADLINE_MS}ms) ` +
            `reached; child pid=${child.pid} still alive (uninterruptible sleep?) — ` +
            `abandoning. Operator should check for zombie qwen --acp processes ` +
            `holding workspace resources.\n`,
        );
        finish();
      }
    }, KILL_HARD_DEADLINE_MS).unref();
  });
}
