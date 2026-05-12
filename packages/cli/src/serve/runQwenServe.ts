/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Server } from 'node:http';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { createHttpAcpBridge, type HttpAcpBridge } from './httpAcpBridge.js';
import { isLoopbackBind } from './loopbackBinds.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

/**
 * Wrap raw IPv6 literals in brackets so the printed URL is a valid RFC 3986
 * authority. `host:port` is ambiguous when host contains `:`, so the URL
 * form requires `[host]:port` for IPv6. Pass-through for IPv4 and DNS
 * names. Already-bracketed input is left alone.
 *
 * RFC 6874 also requires the `%` in an IPv6 zone identifier (e.g.
 * `fe80::1%lo0`) to be percent-encoded as `%25` so the printed URL is
 * copy-paste-valid. We do that on raw IPv6 only — already-bracketed
 * input is the operator's responsibility (don't double-encode if they
 * pre-formed the URL part themselves).
 */
function formatHostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  if (host.includes(':')) {
    const encoded = host.includes('%') ? host.replace(/%/g, '%25') : host;
    return `[${encoded}]`;
  }
  return host;
}

export interface RunHandle {
  server: Server;
  url: string;
  bridge: HttpAcpBridge;
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

export interface RunQwenServeDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
}

/**
 * Validate options + start the listener. Resolves once the server is ready
 * to accept connections.
 *
 * Token resolution order:
 *   1. explicit `opts.token`
 *   2. `QWEN_SERVER_TOKEN` env var
 *
 * Boot refuses to start when bound beyond loopback without a token; this is a
 * hard rule, not a warning, per the threat model in the design issue.
 */
export async function runQwenServe(
  optsIn: Omit<ServeOptions, 'token'> & { token?: string },
  deps: RunQwenServeDeps = {},
): Promise<RunHandle> {
  // Trim both sources. Common gotcha: `export QWEN_SERVER_TOKEN=$(cat
  // token.txt)` keeps the file's trailing `\n` in the env value, so the
  // hashed-then-compared token never matches what well-behaved clients
  // send. Every request returns the generic 401 with no breadcrumb
  // pointing at the whitespace, and operators chase ghosts. Trim once
  // at boot so the comparison is over what humans intended to set.
  const rawToken = optsIn.token ?? process.env[QWEN_SERVER_TOKEN_ENV];
  const token =
    typeof rawToken === 'string' && rawToken.trim().length > 0
      ? rawToken.trim()
      : undefined;
  const opts: ServeOptions = { ...optsIn, token };

  // BU-sh: catch the `--hostname localhost:4170` / `127.0.0.1:4170`
  // typo BEFORE the loopback / token check so the operator sees a
  // useful "did you mean --port?" message instead of "Refusing to
  // bind localhost:4170:0 without a bearer token". Unbracketed input
  // with exactly one `:` is the unambiguous host:port shape — raw
  // IPv6 literals always have two-or-more `:` (the shortest is `::`),
  // and bracketed IPv6 is handled by its own form check below.
  if (!opts.hostname.startsWith('[') && opts.hostname.split(':').length === 2) {
    const [host, port] = opts.hostname.split(':');
    throw new Error(
      `Invalid --hostname "${opts.hostname}": looks like a "host:port" ` +
        `combination. Use --port for the port, e.g. ` +
        `"--hostname ${host} --port ${port}".`,
    );
  }

  if (!isLoopbackBind(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token. ` +
        `Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to loopback ` +
        `(127.0.0.1, localhost, ::1, or [::1]).`,
    );
  }

  const bridge =
    deps.bridge ?? createHttpAcpBridge({ maxSessions: opts.maxSessions });
  let actualPort = opts.port;
  const app = createServeApp(opts, () => actualPort, { bridge });

  // Node's `app.listen()` wants the unbracketed IPv6 literal (`::1`) but
  // operators conventionally type `[::1]` (or copy/paste from URLs that
  // need the brackets to disambiguate the port). Strip brackets at
  // bind-time, keep them for the printed URL — without this fixup
  // `qwen serve --hostname [::1]` would pass the loopback/token check
  // and then fail to start with ENOTFOUND.
  //
  // Only accept *pure* bracketed forms: `[…]` with no trailing `:port`
  // suffix. `[2001:db8::1]:8080` is operator-error (port goes through
  // `--port`, not the hostname) — fail loudly with a useful error
  // instead of silently stripping to a malformed `2001:db8::1]:8080`.
  let listenHostname = opts.hostname;
  if (opts.hostname.startsWith('[')) {
    const inner = opts.hostname.slice(1, -1);
    if (
      !opts.hostname.endsWith(']') ||
      inner.length === 0 ||
      inner.includes(']')
    ) {
      throw new Error(
        `Invalid --hostname "${opts.hostname}": brackets indicate an ` +
          `IPv6 literal but the value isn't a clean [addr] form. Pass the ` +
          `address without a trailing :port (use --port for that), e.g. ` +
          `"--hostname [::1] --port 4170".`,
      );
    }
    // Empty brackets `[]` would have stripped to `''`, which Node treats
    // as "bind to all interfaces" — the operator's intent was specific,
    // not wildcard. The check above (`inner.length === 0`) rejects.
    listenHostname = inner;
  }

  // BUF9-: validate maxConnections BEFORE binding so a typo fails the
  // promise instead of escaping as an uncaught exception inside the
  // listen callback (which fires from the `listening` event after the
  // outer promise has already resolved). Silent fail-OPEN on NaN /
  // negative would weaken the DoS/FD-exhaustion guard the cap exists
  // for.
  if (opts.maxConnections !== undefined) {
    if (Number.isNaN(opts.maxConnections)) {
      throw new TypeError(
        'Invalid maxConnections: NaN. Must be >= 0 ' +
          '(0 / Infinity = unlimited).',
      );
    }
    if (opts.maxConnections < 0) {
      throw new TypeError(
        `Invalid maxConnections: ${opts.maxConnections}. Must be >= 0 ` +
          `(0 / Infinity = unlimited).`,
      );
    }
  }

  return await new Promise<RunHandle>((resolve, reject) => {
    const server = app.listen(opts.port, listenHostname, () => {
      // Listener-level connection cap, set inside the listen callback
      // because Node only exposes the underlying `Server` after
      // `app.listen()` returns. Each session's `EventBus` already
      // refuses to admit more than `DEFAULT_MAX_SUBSCRIBERS` (64), but
      // an attacker can still open *connections* that never finish
      // their headers, never reach the bus, and just sit consuming
      // socket descriptors. The default of 256 leaves room for many
      // sessions × many legitimate clients while keeping the FD count
      // bounded; operators with high-concurrency deployments raise it
      // via `--max-connections` (BRQQb).
      //
      // tanzhenxin issue 1: `0` and `Infinity` are operator-visible
      // "disable the cap" sentinels — but on Node 22 setting
      // `server.maxConnections = 0` causes the listener to refuse
      // EVERY connection (verified on v22.15.0: every fetch fails
      // with `SocketError: other side closed`). Treat 0 / Infinity
      // as "leave the property unset" so the documented disable
      // path actually disables instead of silently bricking the
      // daemon. NaN / negative are rejected upstream (BUF9-) so
      // they never reach here.
      const cap = opts.maxConnections ?? 256;
      if (cap > 0 && Number.isFinite(cap)) {
        server.maxConnections = cap;
      }
      // else: leave unset (Node's default = unlimited at this layer).
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      const url = `http://${formatHostForUrl(opts.hostname)}:${actualPort}`;
      writeStdoutLine(`qwen serve listening on ${url} (mode=${opts.mode})`);
      if (!token) {
        writeStderrLine(
          `qwen serve: bearer auth disabled (loopback default). Set ${QWEN_SERVER_TOKEN_ENV} to enable.`,
        );
      }

      let shuttingDown = false;
      let closePromise: Promise<void> | undefined;

      // Forward declaration so handle.close can detach the listener after
      // drain completes. The handler is registered just before `resolve()`.
      const onSignal = async (signal: NodeJS.Signals) => {
        if (shuttingDown) {
          // BSA0K: second signal forces exit. During drain (up to
          // ~15s for a stuck child + the 5s force-close timer) an
          // operator's reflexive `^C^C` would otherwise be dropped.
          // Match standard daemon behavior (nginx, redis, etc.):
          // first signal = graceful drain; second = hard exit.
          //
          // Bd1y6: synchronously SIGKILL every live `qwen --acp`
          // child BEFORE `process.exit(1)`. Otherwise the daemon
          // vanishes but its child processes keep running with
          // dangling stdin/stdout pipes — visible as orphan
          // `qwen` processes in the operator's `ps` output.
          writeStderrLine(
            `qwen serve: received ${signal} during drain — forcing exit`,
          );
          try {
            bridge.killAllSync();
          } catch (err) {
            writeStderrLine(
              `qwen serve: force-kill error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          process.exit(1);
          return;
        }
        writeStderrLine(`qwen serve: received ${signal}, draining...`);
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          writeStderrLine(`qwen serve: shutdown error: ${String(err)}`);
          process.exit(1);
        }
      };

      const handle: RunHandle = {
        server,
        url,
        bridge,
        close: () => {
          // Idempotent: cache the in-flight (or settled) close promise so
          // overlapping calls (e.g. test harness + signal handler firing
          // simultaneously) all observe the same drain cycle. Without this
          // each caller would arm its own force-close timer + invoke
          // bridge.shutdown / server.close redundantly.
          if (closePromise) return closePromise;
          closePromise = new Promise<void>((res, rej) => {
            shuttingDown = true;
            // NOTE: the SIGINT/SIGTERM handlers stay attached during the
            // drain. Their `if (shuttingDown) return` guard makes a second
            // signal a no-op. Detaching them up front would leave Node's
            // default signal behavior in charge — a second SIGTERM mid-drain
            // would terminate the process and orphan agent children. We
            // detach AFTER drain completes (`finish` below).

            // Two-phase shutdown:
            //   1. `bridge.shutdown()` — tears down agent children with
            //      its own internal `KILL_HARD_DEADLINE_MS` (10s) so
            //      a wedged child can't block forever. We wait
            //      unconditionally; the bridge bounds itself.
            //   2. `server.close()` — drains in-flight HTTP connections
            //      (long-lived SSE subscribers especially). This is
            //      what `SHUTDOWN_FORCE_CLOSE_MS` actually protects:
            //      a single hung SSE consumer would otherwise pin
            //      the listener open forever.
            //
            // Crucially, the force timer is armed AFTER bridge.shutdown
            // resolves, not at the start of the whole sequence. An
            // earlier version raced both phases against the same 5s
            // timer; if the bridge took 5–10s to kill its children
            // (e.g. SIGTERM grace period), the timer fired first,
            // resolved this promise, and `process.exit(0)` ran while
            // the bridge was still tearing children down — orphaning
            // any that hadn't yet hit `KILL_HARD_DEADLINE_MS`.
            let settled = false;
            // BV-qW: track bridge.shutdown failures so close()
            // doesn't silently report success when the bridge
            // teardown itself failed. The contract says "resolves
            // when the listener has fully closed and the bridge is
            // drained" — propagating the failure lets `onSignal`
            // exit 1 instead of 0, and lets embedders react.
            let bridgeShutdownError: Error | undefined;
            const finish = (err?: Error | null) => {
              if (settled) return;
              settled = true;
              // Drain finished (or timed out) — safe to detach now.
              process.removeListener('SIGINT', onSignal);
              process.removeListener('SIGTERM', onSignal);
              // Server.close error takes precedence (operator-visible
              // listener problem); fall back to the bridge error
              // captured during shutdown if any.
              const finalErr = err ?? bridgeShutdownError;
              if (finalErr) rej(finalErr);
              else res();
            };

            bridge
              .shutdown()
              .catch((err) => {
                writeStderrLine(
                  `qwen serve: bridge shutdown error: ${String(err)}`,
                );
                bridgeShutdownError =
                  err instanceof Error ? err : new Error(String(err));
              })
              .finally(() => {
                // Phase 2: arm the force timer NOW so it only races
                // server.close, not the bridge tear-down above.
                // BUb7h: `RunHandle.close()` contract says "fully
                // closed and bridge drained" — the previous code
                // resolved on a 100ms shortcut AFTER
                // `closeAllConnections()` without waiting for
                // `server.close`'s callback, so embedders/tests
                // could observe a "closed" handle while the server
                // was still finalizing. Now: force-close just
                // accelerates `server.close` by killing the
                // sockets, but we still wait for `server.close`'s
                // callback to fire. A secondary deadline catches
                // the pathological case where `server.close` never
                // resolves at all (kernel-stuck socket etc.) so
                // shutdown is still bounded.
                const SECONDARY_DEADLINE_MS = 2_000;
                let secondaryTimer: NodeJS.Timeout | undefined;
                const forceTimer = setTimeout(() => {
                  writeStderrLine(
                    `qwen serve: ${SHUTDOWN_FORCE_CLOSE_MS}ms listener-drain timeout reached; force-closing remaining connections`,
                  );
                  server.closeAllConnections();
                  // After force-close, server.close's callback
                  // SHOULD fire promptly. Give it `SECONDARY_DEADLINE_MS`
                  // before we resolve anyway with a warning — much
                  // longer than the previous 100ms shortcut, and
                  // logged so the operator knows the contract was
                  // bent.
                  secondaryTimer = setTimeout(() => {
                    writeStderrLine(
                      `qwen serve: server.close did not fire ${SECONDARY_DEADLINE_MS}ms after force-close; resolving anyway`,
                    );
                    finish();
                  }, SECONDARY_DEADLINE_MS);
                  secondaryTimer.unref();
                }, SHUTDOWN_FORCE_CLOSE_MS);
                forceTimer.unref();
                server.close((err) => {
                  clearTimeout(forceTimer);
                  if (secondaryTimer) clearTimeout(secondaryTimer);
                  finish(err);
                });
              });
          });
          return closePromise;
        },
      };

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      // BX9_i: swap the boot-error listener for a runtime-error one
      // before resolving. `server.once('error', reject)` at the
      // bottom only catches errors BEFORE listening; post-listen
      // errors (EMFILE after FD exhaustion, runtime errors on the
      // listener) would be unhandled and crash the daemon. Use a
      // persistent listener that logs to stderr instead.
      server.removeAllListeners('error');
      server.on('error', (err) => {
        writeStderrLine(
          `qwen serve: server error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      resolve(handle);
    });
    server.once('error', reject);
  });
}
