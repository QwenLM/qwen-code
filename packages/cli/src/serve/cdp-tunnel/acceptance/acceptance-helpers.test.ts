/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  cdpEndpoint,
  isCdpSmokePassed,
  parseSelectedPageUrl,
  stopChild,
  waitForJson,
} from './acceptance-helpers.mjs';

describe('CDP acceptance helpers', () => {
  it('derives the CDP endpoint from PORT', () => {
    expect(cdpEndpoint({ PORT: '4999' })).toBe('ws://127.0.0.1:4999/cdp');
    expect(cdpEndpoint({ WS: 'ws://example.test/cdp', PORT: '4999' })).toBe(
      'ws://example.test/cdp',
    );
  });

  it('parses hierarchical and non-hierarchical selected page URLs', () => {
    expect(
      parseSelectedPageUrl(
        '## Pages\n1: Example (https://example.test/a?token=secret) [selected]',
      ),
    ).toBe('https://example.test/a?token=secret');
    expect(
      parseSelectedPageUrl('## Pages\n1: Blank (about:blank) [selected]'),
    ).toBe('about:blank');
  });

  it('aborts a stalled JSON request at the deadline', async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    await expect(
      waitForJson('http://example.test/health', () => true, 20, fetchImpl),
    ).rejects.toThrow('Timed out waiting for');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('forces an adapter to exit when it ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise((resolve) => child.stdout.once('data', resolve));

    try {
      await stopChild(child, { graceMs: 20 });
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 15_000);

  it('fails the reconnect smoke when MCP checks fail', () => {
    expect(isCdpSmokePassed({ tools: 29, listPages: '{}', error: null })).toBe(
      true,
    );
    expect(
      isCdpSmokePassed({ tools: 29, listPages: null, error: 'failed' }),
    ).toBe(false);
  });
});
