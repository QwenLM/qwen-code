/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { hasDocumentMcpAppBridgeStubInput } from '../../packages/web-templates/src/export-html/document-mcp-stub-guard.mjs';

describe('document MCP Apps stub guard', () => {
  it('recognizes the document bridge stub with either path separator', () => {
    expect(
      hasDocumentMcpAppBridgeStubInput([
        '/repo/packages/web-templates/src/export-html/src/document-mcp-app-bridge-stub.ts',
      ]),
    ).toBe(true);
    expect(
      hasDocumentMcpAppBridgeStubInput([
        'C:\\repo\\packages\\web-templates\\src\\export-html\\src\\document-mcp-app-bridge-stub.ts',
      ]),
    ).toBe(true);
  });

  it('rejects a document graph that only reaches the transcript entry', () => {
    expect(
      hasDocumentMcpAppBridgeStubInput([
        'packages/web-shell/dist/transcript.js',
        'packages/web-templates/src/export-html/src/document-main.tsx',
      ]),
    ).toBe(false);
  });
});
