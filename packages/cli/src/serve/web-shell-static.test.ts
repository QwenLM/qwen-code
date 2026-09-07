/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWebShellCsp,
  buildWebShellPermissionsPolicy,
} from './web-shell-static.js';

describe('Web Shell sandbox framing', () => {
  it('allows live HTTP/HTTPS previews while retaining shell isolation', () => {
    const csp = buildWebShellCsp();
    expect(csp).toContain('frame-src http: https:');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
    );
    expect(csp).not.toContain('frame-src *');
  });

  it('retains the explicit embedding ancestor allowlist', () => {
    const csp = buildWebShellCsp(['chrome-extension://test-extension']);
    expect(csp).toContain('frame-ancestors chrome-extension://test-extension');
    expect(csp).toContain('frame-src http: https:');
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
