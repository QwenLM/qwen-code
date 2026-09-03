/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

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

  it('parses a selected page URL containing parentheses', () => {
    expect(
      parseSelectedPageUrl(
        '## Pages\n1: Wiki (https://en.wikipedia.org/wiki/Rust_(language)) [selected]',
      ),
    ).toBe('https://en.wikipedia.org/wiki/Rust_(language)');
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

  it('resolves when the predicate matches after non-matching responses', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({ n: call }),
      } as Response;
    });

    const result = await waitForJson(
      'http://example.test/health',
      (v: { n: number }) => v.n === 2,
      5_000,
      fetchImpl,
    );
    expect(result).toEqual({ n: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      // Windows has no catchable POSIX signals: kill('SIGTERM') terminates
      // the child directly, so stopChild never escalates to SIGKILL there.
      expect(child.signalCode).toBe(
        process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL',
      );
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

  it('parses a selected page URL when the title contains parentheses', () => {
    expect(
      parseSelectedPageUrl(
        '## Pages\n1: Rust (programming language) (https://en.wikipedia.org/wiki/Rust) [selected]',
      ),
    ).toBe('https://en.wikipedia.org/wiki/Rust');
  });

  it('stopChild resolves for a child that failed to spawn', async () => {
    const child = spawn('qwen-nonexistent-binary-for-test');
    child.on('error', () => {});
    await stopChild(child, { graceMs: 10 });
    expect(child.pid).toBeUndefined();
  }, 15_000);
});
