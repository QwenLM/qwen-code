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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
    );
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

    const csp = buildWebShellCsp(
      [],
      remoteDaemonConnectOrigins('https://daemon.example.com:4170'),
    );
    expect(csp).toContain(
      "connect-src 'self' https://daemon.example.com:4170 wss://daemon.example.com:4170",
    );
  });
});
