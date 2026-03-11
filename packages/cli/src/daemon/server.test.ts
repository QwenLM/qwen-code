/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonServer } from './server.js';

vi.mock('./lock-file.js', () => ({
  writeLockFile: vi.fn(),
  removeLockFile: vi.fn(),
}));

vi.mock('./session-runner.js', () => ({
  runDaemonSession: vi.fn(() => Promise.resolve()),
}));

describe('DaemonServer', () => {
  let server: DaemonServer;
  let port: number;
  let authToken: string;

  beforeEach(async () => {
    server = new DaemonServer('/test/cwd', 0, 'test-token');
    const info = await server.start();
    port = info.port;
    authToken = info.authToken;
  });

  afterEach(async () => {
    await server.stop();
  });

  const fetchUrl = (path: string, options?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, options);

  it('should start and respond to health check without auth', async () => {
    const res = await fetchUrl('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.pid).toBe(process.pid);
  });

  it('should return 401 for unauthenticated requests', async () => {
    const res = await fetchUrl('/api/sessions');
    expect(res.status).toBe(401);
  });

  it('should return sessions list with auth', async () => {
    const res = await fetchUrl(`/api/sessions?token=${authToken}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('should serve sessions list HTML on root', async () => {
    const res = await fetchUrl(`/?token=${authToken}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Qwen Code Daemon');
  });

  it('should create new session via /session/new', async () => {
    const res = await fetchUrl(`/session/new?token=${authToken}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(/^\/session\/[a-f0-9-]+\?token=/);
  });

  it('should return 404 for non-existent session', async () => {
    const res = await fetchUrl(
      `/session/00000000-0000-0000-0000-000000000000?token=${authToken}`,
    );
    expect(res.status).toBe(404);
  });

  it('should return 404 for unknown routes', async () => {
    const res = await fetchUrl(`/unknown?token=${authToken}`);
    expect(res.status).toBe(404);
  });

  it('should reject /api/stop with GET method', async () => {
    const res = await fetchUrl(`/api/stop?token=${authToken}`);
    expect(res.status).toBe(405);
  });

  it('should accept /api/stop with POST method', async () => {
    // Register onStop handler so process.exit is not called
    let stopCalled = false;
    server.onStop(() => {
      stopCalled = true;
    });

    const res = await fetchUrl(`/api/stop?token=${authToken}`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('stopping');

    // Wait for the setTimeout callback
    await new Promise((r) => setTimeout(r, 200));
    expect(stopCalled).toBe(true);
  });

  it('should support Bearer token auth', async () => {
    const res = await fetchUrl('/api/sessions', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('should report correct session count after creating sessions', async () => {
    // Create a session via /session/new
    await fetchUrl(`/session/new?token=${authToken}`, { redirect: 'manual' });

    const res = await fetchUrl(`/api/sessions?token=${authToken}`);
    const body = await res.json();
    expect(body.length).toBe(1);
  });
});
