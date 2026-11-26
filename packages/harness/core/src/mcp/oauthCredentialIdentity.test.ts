/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from './mcpServerConfig.js';
import { withMcpHostAuthentication } from './authenticationOwnership.js';
import {
  mcpOAuthCredentialIdentity,
  normalizeMcpServerUrl,
} from './oauthCredentialIdentity.js';

const URL_ = 'https://mcp.example.com/mcp';
const keyOf = (config: MCPServerConfig, name = 'github') =>
  mcpOAuthCredentialIdentity(name, config)?.key;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mcpOAuthCredentialIdentity', () => {
  it('keys a server by name plus a digest of type, address and headers', () => {
    expect(mcpOAuthCredentialIdentity('github', { url: URL_ })).toEqual({
      key: expect.stringMatching(/^github\|[0-9a-f]{16}$/),
      legacyKey: 'github',
      url: URL_,
      fromPlugin: false,
    });
  });

  it('prefixes a plugin server with the plugin name', () => {
    const identity = mcpOAuthCredentialIdentity('linear', {
      url: URL_,
      plugin: { id: 'linear@market', name: 'linear', path: '/p' },
    });

    expect(identity?.key).toMatch(/^plugin:linear:linear\|[0-9a-f]{16}$/);
    expect(identity).toMatchObject({ legacyKey: 'linear', fromPlugin: true });
  });

  it('gives each spelling of the same Streamable HTTP server one key', () => {
    const httpUrl = keyOf({ httpUrl: URL_ });

    expect(keyOf({ url: URL_, type: 'http' })).toBe(httpUrl);
    // A bare url is tried as Streamable HTTP first.
    expect(keyOf({ url: URL_ })).toBe(httpUrl);
    expect(keyOf({ url: 'https://MCP.example.com:443/mcp/' })).toBe(httpUrl);
    // A config read without normalization, as `qwen mcp list` reads it.
    expect(
      keyOf({ url: URL_, type: 'streamable-http' } as unknown as MCPServerConfig),
    ).toBe(httpUrl);
  });

  it('is a new identity when the transport, address or static headers change', () => {
    const base = keyOf({ url: URL_ });

    expect(keyOf({ url: URL_, type: 'sse' })).not.toBe(base);
    expect(keyOf({ url: 'https://other.example.com/mcp' })).not.toBe(base);
    expect(keyOf({ url: URL_, headers: { 'X-Tenant': 'a' } })).not.toBe(base);
    expect(keyOf({ url: URL_ }, 'gitlab')).not.toBe(base);
  });

  it('ignores what does not change the endpoint: header order, headersHelper, scope', () => {
    const headers = keyOf({ url: URL_, headers: { a: '1', b: '2' } });

    expect(keyOf({ url: URL_, headers: { b: '2', a: '1' } })).toBe(headers);
    expect(keyOf({ url: URL_, headersHelper: 'print-token' })).toBe(keyOf({ url: URL_ }));
    expect(keyOf({ url: URL_, scope: 'user' })).toBe(keyOf({ url: URL_ }));
  });

  it('expands variables, so a raw and an expanded config agree', () => {
    vi.stubEnv('MCP_HOST', 'mcp.example.com');
    vi.stubEnv('MCP_TOKEN', 't0');

    expect(
      keyOf({ url: 'https://${MCP_HOST}/mcp', headers: { Authorization: '${MCP_TOKEN}' } }),
    ).toBe(keyOf({ url: URL_, headers: { Authorization: 't0' } }));
  });

  it('is undefined for servers that do not sign in with local OAuth', () => {
    expect(mcpOAuthCredentialIdentity('local', { command: 'node' })).toBeUndefined();
    expect(mcpOAuthCredentialIdentity('sdk', { type: 'sdk' })).toBeUndefined();
    expect(
      mcpOAuthCredentialIdentity('external', withMcpHostAuthentication({ url: URL_ })),
    ).toBeUndefined();
  });

  it('retains the endpoint identity when OAuth is not explicitly enabled', () => {
    expect(keyOf({ url: URL_, oauth: { enabled: false } })).toBe(keyOf({ url: URL_ }));
  });
});

describe('normalizeMcpServerUrl', () => {
  it.each([
    ['https://MCP.example.com/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com:443/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp/', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp#x', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/', 'https://mcp.example.com/'],
    ['https://mcp.example.com/mcp?a=1', 'https://mcp.example.com/mcp?a=1'],
    [' not a url ', 'not a url'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMcpServerUrl(input)).toBe(expected);
  });
});
