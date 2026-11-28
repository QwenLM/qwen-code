/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLogger } from '../../utils/runLogger.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import {
  hasRequestedProtocolVersion,
  pinnedLegacyProtocolVersion,
  pinsModernProtocolVersion,
  resolveProtocolNegotiation,
} from './protocolVersion.js';

const AUTOMATIC = { mode: 'auto' } as const;

function server(fields: Partial<MCPServerConfig>): MCPServerConfig {
  return fields as MCPServerConfig;
}

describe('resolveProtocolNegotiation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the transport default through when no revision is configured', () => {
    expect(
      resolveProtocolNegotiation('stdio', server({ command: 'node' }), AUTOMATIC),
    ).toEqual(AUTOMATIC);
    expect(
      resolveProtocolNegotiation(
        'sse',
        server({ type: 'sse', url: 'https://example.test/sse' }),
        undefined,
      ),
    ).toBeUndefined();
  });

  it('pins a known modern revision without falling back', () => {
    expect(
      resolveProtocolNegotiation(
        'http',
        server({
          url: 'https://example.test/mcp',
          protocolVersion: '2026-07-28',
        }),
        AUTOMATIC,
      ),
    ).toEqual({ mode: { pin: '2026-07-28' } });
  });

  it('runs the legacy handshake for a known legacy revision', () => {
    expect(
      resolveProtocolNegotiation(
        'http',
        server({
          url: 'https://example.test/mcp',
          protocolVersion: '2025-11-25',
        }),
        AUTOMATIC,
      ),
    ).toEqual({ mode: 'legacy' });
  });

  it('applies an explicit revision on SSE and WebSocket transports', () => {
    expect(
      resolveProtocolNegotiation(
        'sse',
        server({
          type: 'sse',
          url: 'https://example.test/sse',
          protocolVersion: '2026-07-28',
        }),
        { mode: 'legacy' },
      ),
    ).toEqual({ mode: { pin: '2026-07-28' } });
    expect(
      resolveProtocolNegotiation(
        'sse',
        server({
          type: 'sse',
          url: 'https://example.test/sse',
          protocolVersion: '2025-06-18',
        }),
        { mode: 'legacy' },
      ),
    ).toEqual({ mode: 'legacy' });
  });

  it('ignores the revision on transports that cannot negotiate', () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    expect(
      resolveProtocolNegotiation(
        'sdk',
        server({ type: 'sdk', protocolVersion: '2026-07-28' }),
        undefined,
      ),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the default for unknown revisions', () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    for (const protocolVersion of ['2027-03-01', 'latest']) {
      expect(
        resolveProtocolNegotiation(
          'http',
          server({ url: 'https://example.test/mcp', protocolVersion }),
          AUTOMATIC,
        ),
      ).toEqual(AUTOMATIC);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy retry for unrecognized revisions', () => {
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    expect(
      hasRequestedProtocolVersion(server({ protocolVersion: '2.0' })),
    ).toBe(false);
    expect(
      hasRequestedProtocolVersion(server({ protocolVersion: '2026-07-28' })),
    ).toBe(true);
  });

  it('treats a blank revision as unconfigured', () => {
    expect(
      hasRequestedProtocolVersion(
        server({ command: 'node', protocolVersion: '  ' }),
      ),
    ).toBe(false);
    expect(
      resolveProtocolNegotiation(
        'stdio',
        server({ command: 'node', protocolVersion: '  ' }),
        AUTOMATIC,
      ),
    ).toEqual(AUTOMATIC);
  });
});

describe('pinnedLegacyProtocolVersion', () => {
  it('returns only a configured legacy revision', () => {
    expect(
      pinnedLegacyProtocolVersion(server({ protocolVersion: '2025-06-18' })),
    ).toBe('2025-06-18');
    expect(
      pinnedLegacyProtocolVersion(server({ protocolVersion: '2026-07-28' })),
    ).toBeUndefined();
    expect(pinnedLegacyProtocolVersion(server({}))).toBeUndefined();
  });
});

describe('pinsModernProtocolVersion', () => {
  it('is true only for a configured modern revision', () => {
    expect(
      pinsModernProtocolVersion(server({ protocolVersion: '2026-07-28' })),
    ).toBe(true);
    expect(
      pinsModernProtocolVersion(server({ protocolVersion: '2025-11-25' })),
    ).toBe(false);
    expect(pinsModernProtocolVersion(server({}))).toBe(false);
  });
});
