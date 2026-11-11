/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { isMcpHostAuthenticated, withMcpHostAuthentication } from './authenticationOwnership.js';

it('keeps host authentication runtime-only and preserves it through config copies', () => {
  const original = { url: 'https://mcp.example/mcp' };
  const runtime = withMcpHostAuthentication(original);
  expect(isMcpHostAuthenticated(original)).toBe(false);
  expect(isMcpHostAuthenticated(runtime)).toBe(true);
  expect(isMcpHostAuthenticated({ ...runtime })).toBe(true);
  expect(isMcpHostAuthenticated(Object.assign({}, runtime))).toBe(true);
  expect(isMcpHostAuthenticated(JSON.parse(JSON.stringify(runtime)))).toBe(false);
  expect(JSON.stringify(runtime)).toBe(JSON.stringify(original));
});

it('does not trust ownership supplied by JSON', () => {
  const config = JSON.parse('{"url":"https://other.example/mcp","authMode":"host","mcp.hostAuthentication":true}');
  expect(isMcpHostAuthenticated(config)).toBe(false);
});
