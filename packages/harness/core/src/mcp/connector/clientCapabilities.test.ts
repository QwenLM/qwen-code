/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildClientCapabilities } from './connectMcpServer.js';

describe('buildClientCapabilities', () => {
  it('merges host extension payloads over connector extension ids', () => {
    const capabilities = buildClientCapabilities(
      true,
      ['qoder/auth-state', 'io.modelcontextprotocol/ui'],
      {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
          ignored: 42,
        },
      },
    );

    expect(capabilities.extensions).toEqual({
      'qoder/auth-state': {},
      'io.modelcontextprotocol/ui': {
        mimeTypes: ['text/html;profile=mcp-app'],
      },
    });
    expect(capabilities.elicitation).toEqual({});
    expect(capabilities.roots).toEqual({ listChanged: true });
  });

  it('leaves capabilities untouched when no host extensions are given', () => {
    expect(buildClientCapabilities(false, [], undefined)).toEqual({
      roots: { listChanged: true },
    });
  });
});
