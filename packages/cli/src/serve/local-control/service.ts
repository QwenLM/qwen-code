/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { Application } from 'express';
import type { SleepInhibitorHandle } from '@qwen-code/qwen-code-core';
import { sleepInhibitor } from '@qwen-code/qwen-code-core';
import type { MutableOriginAllowlist } from '../auth.js';
import type { CredentialStore } from './credentials.js';
import { tagListener } from './listener-identity.js';
import { selectLanAddress, type LanCandidate } from './lan-interfaces.js';
import { mintPairingToken, type PairingToken } from './pairing-token.js';

/** Key under which the LAN origin is registered in the mutable CORS allowlist. */
const CORS_KEY = 'local-control';

export interface LocalControlStatus {
  active: boolean;
  /**
   * Paired URL, token in the fragment. Present only while active.
   *
   * The fragment is deliberate and inherited from the Rust implementation
   * (`local_control.rs:421-442`): fragments are not sent to the server, do not
   * appear in access logs, and are not carried on cross-origin navigations, so
   * the pairing secret stays client-side after the scan.
   */
  url?: string;
  interfaceName?: string;
  address?: string;
  port?: number;
  sleepInhibited?: boolean;
  issuedAt?: number;
}

export interface LocalControlEnableOptions {
  /** Which LAN address to expose, when the host has more than one. */
  address?: string;
  /**
   * Path + query the QR should open, e.g. `/?workspace=%2Fsrc%2Fapp`. Lets the
   * phone land on the session the operator was looking at rather than the
   * daemon root — the CLI path always advertised the root.
   */
  target?: string;
}

export interface LocalControlServiceDeps {
  /** The same Express app the primary listener serves. */
  app: Application;
  /** Credential store the LAN listener's pairing token is registered in. */
  credentials: CredentialStore;
  /** CORS allowlist the LAN origin is added to while active. */
  originAllowlist: MutableOriginAllowlist;
  /** Attach/detach the ACP WebSocket upgrade listener to the LAN server. */
  attachWebSocket(server: Server): void;
  detachWebSocket(server: Server): void;
  /** Port to advertise. Read lazily — the primary listener may be on port 0. */
  getPort(): number;
  /** Injected for tests. */
  now?(): number;
}

/**
 * Owns the LAN listener, its credential, and its sleep assertion.
 *
 * This is the whole of what `local_control.rs` did, minus the proxying. The
 * Rust file bound a LAN socket and forwarded bytes to the loopback daemon,
 * rewriting `Host`, `Origin`, `Authorization`, and `Sec-WebSocket-Protocol` on
 * the way through — all of it compensation for one fact: `qwen serve` fixed
 * its bind address at startup and could not add a listener later.
 *
 * Here the second listener serves the same Express app directly. There are no
 * bytes to rewrite because there is no hop: the request arrives at the daemon
 * already, and the checks the proxy performed by rewriting are performed by
 * the middleware the app already has, scoped by listener identity.
 */
export class LocalControlService {
  readonly #deps: LocalControlServiceDeps;
  #server: Server | undefined;
  #token: PairingToken | undefined;
  #selected: LanCandidate | undefined;
  #sleep: SleepInhibitorHandle | undefined;
  #url: string | undefined;

  constructor(deps: LocalControlServiceDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#server !== undefined;
  }

  status(): LocalControlStatus {
    if (!this.#server || !this.#token || !this.#selected) {
      return { active: false };
    }
    return {
      active: true,
      url: this.#url,
      interfaceName: this.#selected.interfaceName,
      address: this.#selected.address,
      port: this.#deps.getPort(),
      sleepInhibited: this.#sleep !== undefined,
      issuedAt: this.#token.issuedAt,
    };
  }

  /**
   * Bring the LAN listener up. Enabling while already active is a no-op that
   * returns the existing status rather than re-minting: a second scan of the
   * same QR must keep working, and silently invalidating the token the user is
   * mid-pairing with would be indistinguishable from a bug.
   */
  async enable(
    options: LocalControlEnableOptions = {},
  ): Promise<LocalControlStatus> {
    if (this.active) return this.status();

    const selected = selectLanAddress(options.address);
    const port = this.#deps.getPort();
    const authority = `${selected.address}:${port}`;
    const token = mintPairingToken();

    const server = createServer(this.#deps.app);
    // Tag before listening. Identity must be resolvable by the first request,
    // and a request can arrive between `listen()` resolving and the next line
    // of this function running.
    tagListener(server, { kind: 'local-control', authority });

    // Register the credential and the origin BEFORE the socket accepts
    // anything. Reversed, there is a window where the LAN listener is up but
    // the pairing token is not yet valid — the phone's first request 401s and
    // the user re-scans a QR that was never broken.
    this.#deps.credentials.addPairingToken(token.id, token.secret);
    this.#deps.originAllowlist.add(CORS_KEY, `http://${authority}`);

    try {
      await listen(server, port, selected.address);
    } catch (error) {
      this.#deps.credentials.revokePairingToken(token.id);
      this.#deps.originAllowlist.remove(CORS_KEY);
      throw error;
    }

    this.#deps.attachWebSocket(server);
    this.#server = server;
    this.#token = token;
    this.#selected = selected;
    this.#url = buildPairedUrl(authority, token.secret, options.target);
    // Best-effort, and reported as such: the core inhibitor no-ops on headless
    // SSH sessions and on hosts without a usable backend. A phone losing its
    // session to a sleeping laptop should be explainable from the status, so
    // `sleepInhibited` reflects what actually happened rather than intent.
    this.#sleep = sleepInhibitor.acquire('Qwen Code Local Control is active');
    return this.status();
  }

  /**
   * Take the LAN listener down and invalidate its credential.
   *
   * Revocation happens first and unconditionally. If closing the socket fails
   * or hangs, the outcome is a listener that accepts connections no credential
   * can authenticate — inert. The reverse order would leave a live, reachable
   * listener with a valid token if teardown failed partway.
   */
  async disable(): Promise<LocalControlStatus> {
    const server = this.#server;
    const token = this.#token;
    this.#server = undefined;
    this.#token = undefined;
    this.#selected = undefined;
    this.#url = undefined;

    if (token) this.#deps.credentials.revokePairingToken(token.id);
    this.#deps.originAllowlist.remove(CORS_KEY);
    this.#sleep?.release();
    this.#sleep = undefined;

    if (server) {
      this.#deps.detachWebSocket(server);
      await close(server);
    }
    return { active: false };
  }

  /**
   * Called from the daemon's drain path. Local Control must not outlive the
   * daemon that owns it: a listener surviving drain would hold the port and
   * keep answering with a token nothing can revoke anymore.
   */
  async dispose(): Promise<void> {
    await this.disable();
  }
}

function buildPairedUrl(
  authority: string,
  secret: string,
  target?: string,
): string {
  const url = new URL(`http://${authority}`);
  if (target) {
    // Parsed relative to the LAN origin so an absolute or protocol-relative
    // `target` cannot redirect the QR at a host the operator did not choose.
    const resolved = new URL(target, url);
    url.pathname = resolved.pathname;
    url.search = resolved.search;
  }
  url.hash = `token=${encodeURIComponent(secret)}`;
  return url.toString();
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // `closeAllConnections` cuts keep-alive sockets that `close()` alone would
    // wait on indefinitely. Without it, disable() would resolve only once the
    // phone happened to disconnect.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
