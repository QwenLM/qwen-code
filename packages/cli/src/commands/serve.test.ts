/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import yargs, { type Argv } from 'yargs';
import { serveCommand, maybeOpenWebShellBrowser } from './serve.js';

const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());
const mockShouldLaunchBrowser = vi.hoisted(() => vi.fn(() => true));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    openBrowserSecurely: mockOpenBrowserSecurely,
    shouldLaunchBrowser: mockShouldLaunchBrowser,
  };
});

function buildParser(): Argv {
  return (serveCommand.builder as (argv: Argv) => Argv)(
    yargs([]).exitProcess(false).fail(false).locale('en'),
  );
}

describe('serve command args', () => {
  it('parses --enable-session-shell', () => {
    const parsed = buildParser().parseSync('--enable-session-shell');
    expect(parsed['enable-session-shell']).toBe(true);
  });

  it('defaults direct session shell to disabled', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['enable-session-shell']).toBe(false);
  });

  it('parses --permission-response-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync(
      '--permission-response-timeout-ms 60000',
    );
    expect(parsed['permission-response-timeout-ms']).toBe(60000);
  });

  it('leaves --permission-response-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['permission-response-timeout-ms']).toBeUndefined();
  });

  it('parses --experimental-lsp for daemon child opt-in', () => {
    const parsed = buildParser().parseSync('--experimental-lsp');
    expect(parsed['experimentalLsp']).toBe(true);
  });

  it('registers --experimental-lsp as an explicit serve option', () => {
    const options = (
      buildParser() as Argv & {
        getOptions(): { key: Record<string, boolean> };
      }
    ).getOptions();
    expect(options.key['experimental-lsp']).toBe(true);
  });

  it('parses --web (default true) and --no-web', () => {
    expect(buildParser().parseSync('')['web']).toBe(true);
    expect(buildParser().parseSync('--no-web')['web']).toBe(false);
  });

  it('parses --open (default false)', () => {
    expect(buildParser().parseSync('')['open']).toBe(false);
    expect(buildParser().parseSync('--open')['open']).toBe(true);
  });
});

describe('maybeOpenWebShellBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldLaunchBrowser.mockReturnValue(true);
  });

  const firstOpenedUrl = () =>
    String(mockOpenBrowserSecurely.mock.calls[0]?.[0]);

  it('does nothing when --open is false', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: true },
      false,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('does nothing when the Web Shell is not mounted', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: false },
      true,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('does nothing when shouldLaunchBrowser() is false', async () => {
    mockShouldLaunchBrowser.mockReturnValue(false);
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: true },
      true,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('rewrites a wildcard bind host to loopback', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://0.0.0.0:4170/', webShellMounted: true },
      true,
    );
    expect(firstOpenedUrl()).toContain('127.0.0.1');
    expect(firstOpenedUrl()).not.toContain('0.0.0.0');
  });

  it('puts the token in the URL fragment, not the query', async () => {
    await maybeOpenWebShellBrowser(
      {
        url: 'http://127.0.0.1:4170/',
        webShellMounted: true,
        resolvedToken: 'secret',
      },
      true,
    );
    expect(firstOpenedUrl()).toContain('#token=secret');
    expect(firstOpenedUrl()).not.toContain('?token=');
  });

  it('swallows openBrowserSecurely failures (never throws)', async () => {
    mockOpenBrowserSecurely.mockRejectedValueOnce(new Error('boom'));
    await expect(
      maybeOpenWebShellBrowser(
        { url: 'http://127.0.0.1:4170/', webShellMounted: true },
        true,
      ),
    ).resolves.toBeUndefined();
  });
});
