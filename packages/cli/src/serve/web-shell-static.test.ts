/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildWebShellCsp,
  buildWebShellPermissionsPolicy,
  loopbackSandboxOrigins,
  portFromHostHeader,
} from './web-shell-static.js';

describe('Web Shell sandbox framing', () => {
  it('pins loopback sandbox origins to the request Host port', () => {
    expect(portFromHostHeader('localhost:4170')).toBe('4170');
    expect(portFromHostHeader('[::1]:4170')).toBe('4170');
    expect(portFromHostHeader('127.0.0.1')).toBeUndefined();
    expect(loopbackSandboxOrigins('127.0.0.1:4170')).toEqual([
      'http://localhost:4170',
      'http://127.0.0.1:4170',
      'https://localhost:4170',
      'https://127.0.0.1:4170',
    ]);
    expect(loopbackSandboxOrigins('127.0.0.1:4170').join(' ')).not.toContain(
      '[::1]',
    );
    expect(loopbackSandboxOrigins('127.0.0.2:4170')).toContain(
      'http://127.0.0.2:4170',
    );
    expect(loopbackSandboxOrigins('127.0.0.2:4170')).not.toContain(
      'http://127.0.0.2:*',
    );
    expect(loopbackSandboxOrigins('example.com:4170')).not.toContain(
      'example.com',
    );
  });

  it('allows only the daemon loopback port in frame-src', () => {
    const csp = buildWebShellCsp([], loopbackSandboxOrigins('localhost:4170'));
    expect(csp).toContain(
      'frame-src http://localhost:4170 http://127.0.0.1:4170 https://localhost:4170 https://127.0.0.1:4170',
    );
    expect(csp).not.toContain('[::1]');
    expect(csp).not.toContain('http://localhost:*');
    expect(csp).not.toContain('http://127.0.0.1:*');
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
});
