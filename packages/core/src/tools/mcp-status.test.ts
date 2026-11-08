/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  getMCPServerLastError,
  MCPServerStatus,
  recordMCPServerLastError,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-status.js';

describe('mcp-status last-error carrier (issue #9944)', () => {
  // Discovery is best-effort and swallows connect errors (debugLogger only),
  // so the status enum alone cannot tell a consumer WHY a server is not
  // CONNECTED. The registry therefore carries the most recent failure cause
  // per server for consumers like `qwen mcp reconnect`.
  const serverName = 'last-error-carrier-server';

  afterEach(() => {
    removeMCPServerStatus(serverName);
  });

  it('returns undefined when no failure was recorded', () => {
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });

  it('round-trips a recorded failure cause', () => {
    recordMCPServerLastError(serverName, 'connect ECONNREFUSED 127.0.0.1:3939');
    expect(getMCPServerLastError(serverName)).toBe(
      'connect ECONNREFUSED 127.0.0.1:3939',
    );
  });

  it('keeps the most recent cause when failures repeat', () => {
    recordMCPServerLastError(serverName, 'first cause');
    recordMCPServerLastError(serverName, 'second cause');
    expect(getMCPServerLastError(serverName)).toBe('second cause');
  });

  it('keeps the recorded cause across DISCONNECTED status writes', () => {
    recordMCPServerLastError(serverName, 'HTTP 401 Unauthorized');
    updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
    expect(getMCPServerLastError(serverName)).toBe('HTTP 401 Unauthorized');
  });

  it('clears the recorded cause when the server reaches CONNECTED', () => {
    recordMCPServerLastError(serverName, 'HTTP 401 Unauthorized');
    updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });

  it('clears the recorded cause when the server is removed from the registry', () => {
    recordMCPServerLastError(serverName, 'spawn ENOENT');
    removeMCPServerStatus(serverName);
    expect(getMCPServerLastError(serverName)).toBeUndefined();
  });
});
