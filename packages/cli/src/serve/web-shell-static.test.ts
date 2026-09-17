/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWebShellCsp,
  buildWebShellPermissionsPolicy,
  remoteDaemonConnectOrigins,
  requestedDaemonParam,
} from './web-shell-static.js';

describe('Web Shell sandbox framing', () => {
  it('allows live previews and PDF blobs while retaining shell isolation', () => {
    const csp = buildWebShellCsp();
    expect(csp).toContain('frame-src http: https: blob:;');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("media-src 'self' data:");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data:;",
    );
    expect(csp).toContain("style-src 'self' 'unsafe-inline' data:;");
    expect(csp).toContain("connect-src 'self' https://unpkg.com/@qwen-code/");
    expect(csp).not.toContain('frame-src *');
  });

  it('retains the explicit embedding ancestor allowlist', () => {
    const csp = buildWebShellCsp(['chrome-extension://test-extension']);
    expect(csp).toContain('frame-ancestors chrome-extension://test-extension');
    expect(csp).toContain('frame-src http: https: blob:;');
  });

  it('keeps camera, microphone, and geolocation host-blocked', () => {
    const policy = buildWebShellPermissionsPolicy();
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=(self)');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('payment=()');
    expect(policy).toContain('clipboard-write=(self)');
    expect(policy).not.toContain('localhost');
  });

  it('adds only a validated remote daemon to connect-src', () => {
    expect(
      remoteDaemonConnectOrigins('https://daemon.example.com:4170'),
    ).toEqual([
      'https://daemon.example.com:4170',
      'wss://daemon.example.com:4170',
    ]);
    expect(remoteDaemonConnectOrigins('http://127.0.0.1:4271')).toEqual([
      'http://127.0.0.1:4271',
      'ws://127.0.0.1:4271',
    ]);
    expect(remoteDaemonConnectOrigins('http://daemon.example.com')).toEqual([
      'http://daemon.example.com',
      'ws://daemon.example.com',
    ]);
    expect(
      remoteDaemonConnectOrigins('https://daemon.example.com/path'),
    ).toEqual([]);

    // The parameter is read with the client's parser, so a repeated
    // `?daemon=` is first-value-wins on both sides and the header allows the
    // value the client will actually connect to.
    expect(
      requestedDaemonParam(
        '/?daemon=https%3A%2F%2Fdaemon.example.com%3A4170&daemon=https%3A%2F%2Fother.example',
      ),
    ).toBe('https://daemon.example.com:4170');
    expect(
      remoteDaemonConnectOrigins(
        requestedDaemonParam(
          '/?daemon=https%3A%2F%2Fdaemon.example.com%3A4170&daemon=https%3A%2F%2Fother.example',
        ),
      ),
    ).toEqual([
      'https://daemon.example.com:4170',
      'wss://daemon.example.com:4170',
    ]);
    expect(
      remoteDaemonConnectOrigins(
        requestedDaemonParam('/?daemon=file%3A%2F%2F%2Ftmp%2Fdaemon'),
      ),
    ).toEqual([]);
    expect(remoteDaemonConnectOrigins(requestedDaemonParam('/'))).toEqual([]);
    expect(
      buildWebShellCsp(
        [],
        remoteDaemonConnectOrigins(
          requestedDaemonParam(
            '/?daemon=https%3A%2F%2Fdaemon.example.com%3A4170&daemon=https%3A%2F%2Fother.example',
          ),
        ),
      ),
    ).toContain(
      "connect-src 'self' https://daemon.example.com:4170 wss://daemon.example.com:4170",
    );

    expect(remoteDaemonConnectOrigins('http://evil.example%3Bsandbox')).toEqual(
      [],
    );
    // A bracketed IPv6 host is not a valid CSP host-source, so it is never
    // emitted; a page served from that origin is covered by 'self'.
    expect(remoteDaemonConnectOrigins('https://[::1]:4170')).toEqual([]);
    expect(
      buildWebShellCsp(
        [],
        remoteDaemonConnectOrigins('http://evil.example;sandbox'),
      ),
    ).toBe(buildWebShellCsp());

    const csp = buildWebShellCsp(
      [],
      remoteDaemonConnectOrigins('https://daemon.example.com:4170'),
    );
    expect(csp).toContain(
      "connect-src 'self' https://daemon.example.com:4170 wss://daemon.example.com:4170",
    );
  });

  it('never widens connect-src for a key the client parser does not report', () => {
    // `requestedDaemonParam` must agree with the client's
    // `URLSearchParams.get('daemon')` on every shape, so the emitted header can
    // never depend on how Express was configured to parse queries. The
    // bracketed rows are the ones that diverged under the old `req.query` read
    // *when the parser is qs* (`'extended'`): qs folds them into a `daemon`
    // array the client never sees. Under the shipped default (`'simple'`, Node
    // `querystring`, Express 5 — nothing in this repo sets it) they do not
    // diverge, because `req.query.daemon` is simply absent. So this table pins
    // parser-independence, not a defect in the shipped configuration;
    // `server.test.ts` drives the same shapes through a real app forced to
    // `'extended'`.
    //
    // `expected` is what the client resolves for the same URL, re-derived from
    // `URLSearchParams` below rather than trusted from this table, so the client
    // stays the oracle.
    const shapes: ReadonlyArray<{ url: string; expected: string | null }> = [
      // qs: { daemon: ['…4182', '…4181'] } → the old read granted 4182, but
      // the client connects to 4181, so its own target was CSP-blocked.
      {
        url: '/?daemon[]=http%3A%2F%2Flocalhost%3A4182&daemon=http%3A%2F%2Flocalhost%3A4181',
        expected: 'http://localhost:4181',
      },
      { url: '/?daemon[]=http%3A%2F%2Flocalhost%3A4182', expected: null },
      { url: '/?daemon[0]=http%3A%2F%2Flocalhost%3A4182', expected: null },
      {
        url: '/?daemon[0]=http%3A%2F%2Flocalhost%3A4182&daemon[1]=http%3A%2F%2Flocalhost%3A4183',
        expected: null,
      },
      // A plain repeated parameter is first-value-wins on both sides.
      {
        url: '/?daemon=http%3A%2F%2Fa&daemon=http%3A%2F%2Fb',
        expected: 'http://a',
      },
      { url: '/', expected: null },
    ];
    for (const { url, expected } of shapes) {
      expect(requestedDaemonParam(url)).toBe(expected);
      // The client's own parse of the same URL is the oracle.
      expect(
        new URL(`http://127.0.0.1:4170${url}`).searchParams.get('daemon'),
      ).toBe(expected);
      const csp = buildWebShellCsp(
        [],
        remoteDaemonConnectOrigins(requestedDaemonParam(url)),
      );
      if (expected === null) {
        expect(csp).toBe(buildWebShellCsp());
      } else {
        expect(csp).toContain(`connect-src 'self' ${expected}`);
      }
    }
    // The one shape that both granted and blocked the wrong origin: the
    // foreign origin must not appear, and the client's own target must.
    const mixed = buildWebShellCsp(
      [],
      remoteDaemonConnectOrigins(
        requestedDaemonParam(
          '/?daemon[]=http%3A%2F%2Flocalhost%3A4182&daemon=http%3A%2F%2Flocalhost%3A4181',
        ),
      ),
    );
    expect(mixed).not.toContain('4182');
    expect(mixed).toContain(
      "connect-src 'self' http://localhost:4181 ws://localhost:4181",
    );
  });
});
