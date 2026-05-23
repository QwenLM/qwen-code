/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { AcpChannelExitInfo, ChannelFactory } from './channel.js';
import { MissingCliEntryError } from './status.js';

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
 * this factory for a sandbox-aware variant; see issue #3803 §11.
 *
 * Lifted from `cli/src/serve/httpAcpBridge.ts` to `@qwen-code/acp-bridge`
 * in #4175 PR F1 so `channels/base/AcpBridge.ts` and the VSCode IDE
 * companion can share one spawn implementation instead of each
 * reimplementing the child lifecycle (the current divergence noted in
 * `channel.ts`'s top-of-file comment).
 */
export const defaultSpawnChannelFactory: ChannelFactory = async (
  workspaceCwd,
  childEnvOverrides,
) => {
  // Resolution order:
  //   1. `QWEN_CLI_ENTRY` env override — escape hatch for non-standard
  //      launch paths (bundled binaries, npx wrappers, `node -e`,
  //      `tsx ./src/...`, custom shims, container images that
  //      relocate the entry script). Anyone hitting "process.argv[1]
  //      is empty" or "process.argv[1] points at the wrong file" can
  //      set this without code changes.
  //   2. `process.argv[1]` — works when launched via the `qwen` bin
  //      shim, which is the common path.
  // Fail loudly with an actionable error if neither resolves.
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
  if (!cliEntry) {
    throw new MissingCliEntryError();
  }
  // Each session takes ~3 file descriptors (stdin/stdout/stderr) for the
  // child plus a few sockets. Operators running many concurrent sessions
  // should bump `ulimit -n` accordingly. Stage 1 doesn't pre-flight FD
  // headroom — Stage 2 in-process drops the per-session FD cost entirely.
  // Child stderr is piped (NOT `inherit`ed) so we can prefix each
  // line with `[serve pid=… cwd=…]` before forwarding to the
  // daemon's stderr — see the prefix-and-forward loop below the
  // `spawn(...)` call. Sessions are still interleaved on the
  // daemon's stderr stream but each line carries its own session
  // identifier, so operators can `grep pid=12345` to pull one
  // session's trace cleanly. Stage 4+ remote sandboxes will isolate
  // stderr at the transport level.
  //
  // Note: spawning `process.execPath` only works when the entry script can
  // be loaded by raw Node. In dev (e.g. `npm run dev` via `tsx`) the entry
  // is a `.ts` file Node can't run; users should `npm run build` before
  // `qwen serve` or set `process.execPath` to a tsx-aware shim. Stage 1
  // accepts this — the daemon is meant for built deployments.
  // Pass through the daemon's full environment to the child, scrubbing
  // ONLY daemon-internal secrets (see SCRUBBED_CHILD_ENV_KEYS at module
  // scope). An earlier version used an allowlist, but that broke the
  // common deployment shape: users export `OPENAI_API_KEY` /
  // `ANTHROPIC_API_KEY` / `QWEN_*` / `DASHSCOPE_API_KEY` / a custom
  // `modelProviders[].envKey` to authenticate the agent's LLM calls,
  // and core's model config resolves those from `process.env`. An
  // exhaustive allowlist can't enumerate user-defined provider keys,
  // so the agent ends up unable to authenticate.
  //
  // Threat-model rationale: the agent already runs as the same UID
  // with shell-tool access — anything in `~/.bashrc`, `~/.npmrc`,
  // `~/.aws/credentials`, etc. is reachable by prompt injection
  // regardless of what we put in `env`. The env passthrough is not
  // the security boundary; the user-as-trust-root is. The only thing
  // we MUST scrub is `QWEN_SERVER_TOKEN` (daemon-only auth that
  // would let a prompt-injected shell turn the agent into an
  // authenticated client of its own daemon — escalation the agent
  // doesn't otherwise have).
  const childEnv = scrubChildEnv(
    process.env,
    SCRUBBED_CHILD_ENV_KEYS,
    childEnvOverrides,
  );
  // CodeQL `js/path-injection` flags the `cwd: workspaceCwd` flow.
  // Stage 1 trust model accepts this — see the function-level comment
  // above for the design rationale. Defense-in-depth: the cwd is
  // canonicalized via `path.resolve()` upstream in `spawnOrAttach`,
  // and `spawn`'s `cwd` only changes the child's working directory,
  // it doesn't pass through any shell.
  //
  // NOTE: GitHub Code Scanning does NOT honor inline `// lgtm` /
  // `// codeql` annotations (LGTM.com retired in 2021). Suppressing
  // this alert requires either (a) UI dismissal as "won't fix" with
  // the rationale above, or (b) a repo-level
  // `.github/codeql/codeql-config.yml` query exclusion. Both are
  // out of scope for a code-only PR; flagging here for the human
  // reviewer.
  const child = spawn(process.execPath, [cliEntry, '--acp'], {
    cwd: workspaceCwd,
    // Pipe stderr (was: 'inherit') so we can prefix each line with
    // the spawn's pid + workspace, making per-session crash output
    // attributable. Bare 'inherit' sends every child's stderr to
    // the daemon's stderr verbatim and unprefixed — under any
    // multi-session load the operator's log becomes a salad of
    // unattributed traces.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  // Forward child stderr to the daemon's stderr line-by-line, with a
  // `[serve pid=… cwd=…]` prefix on each line so operators can
  // correlate stack traces back to the spawning request. Best-effort:
  // a child that prints partial lines without a trailing newline is
  // flushed when the stream emits `end`.
  if (child.stderr) {
    let buf = '';
    const prefix = `[serve pid=${child.pid} cwd=${workspaceCwd}] `;
    // BRAp3 cap: a buggy child that writes a huge stderr line, or
    // never emits `\n`, would otherwise grow `buf` per spawn
    // unboundedly. 64 KiB is generous for the longest legitimate
    // stack trace line we'd expect from a Node child; anything
    // past that gets force-flushed with a `[truncated]` marker so
    // the operator still sees a prefix-attributed log line and
    // memory stays bounded. We DON'T drop content — we flush
    // chunks at the cap. (Picking 64 KiB matches our SSE per-frame
    // write budget; anything above this already implies the child
    // is misbehaving.)
    const STDERR_LINE_CAP_CHARS = 64 * 1024;
    const flush = (line: string) => {
      if (line.length > 0) process.stderr.write(prefix + line + '\n');
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
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
        flush(buf.slice(0, STDERR_LINE_CAP_CHARS) + ' [truncated]');
        buf = buf.slice(STDERR_LINE_CAP_CHARS);
      }
    });
    child.stderr.on('end', () => {
      if (buf.length > 0) flush(buf);
    });
    child.stderr.on('error', () => {
      // Don't crash the daemon if the pipe breaks; the child is
      // already gone or about to be.
    });
  }

  // Build the `exited` promise BEFORE checking stdin/stdout so the listener
  // is in place before any error event can fire. We treat both `exit` and
  // `error` as termination — without an `error` listener Node would treat
  // an async spawn failure (ENOMEM, EACCES, …) as an unhandled error and
  // crash the whole daemon.
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
      // Bd1y6: synchronous SIGKILL for the double-signal force-exit
      // path. Skip if child already exited (kill on a dead process
      // raises an OS-level error that's noise here).
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
 * See issue #3803 §11 for the Stage 4+ remote-sandbox plan.
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
    // #4319 wenshao round 5 fold-in: emit a stderr line BEFORE we
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
