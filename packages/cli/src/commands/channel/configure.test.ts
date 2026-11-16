/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The terminal output moved out of `login.ts` into this command, so the
// command is now the only place that decides what an operator sees. Nothing
// else in the suite reads its stderr.
const startLogin = vi.hoisted(() => vi.fn());
const waitForLogin = vi.hoisted(() => vi.fn());
const loadAccount = vi.hoisted(() => vi.fn());
const saveAccount = vi.hoisted(() => vi.fn());
const clearAccount = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/channel-weixin/login', () => ({
  startLogin,
  waitForLogin,
}));
vi.mock('@qwen-code/channel-weixin/accounts', () => ({
  loadAccount,
  saveAccount,
  clearAccount,
  DEFAULT_BASE_URL: 'https://ilinkai.weixin.qq.com',
}));

const { configureWeixinCommand } = await import('./configure.js');

type Handler = (argv: { action?: string }) => Promise<void>;
const run = (action?: string) =>
  (configureWeixinCommand.handler as unknown as Handler)({ action });

let stderr: string[];
let stdout: string[];

beforeEach(() => {
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  startLogin.mockReset();
  waitForLogin.mockReset();
  loadAccount.mockReset();
  saveAccount.mockReset();
  clearAccount.mockReset();
  loadAccount.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configure-weixin terminal output', () => {
  it('prints the QR URL and the scan prompt before waiting', async () => {
    startLogin.mockResolvedValue({
      qrcodeId: 'qr-1',
      qrcodeUrl: 'https://scan.example/qr-1',
    });
    waitForLogin.mockResolvedValue({
      connected: true,
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      message: 'Connected to WeChat successfully!',
    });

    await run();

    expect(stderr.join('')).toBe(
      'QR code URL: https://scan.example/qr-1\n' +
        'Scan this URL with WeChat.\n' +
        'Scan the QR code with WeChat to connect.\n',
    );
    // The result message is stdout, not stderr — the split is part of the
    // output contract this test exists to hold.
    expect(stdout.join('')).toContain('Connected to WeChat successfully!');
    expect(saveAccount).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok' }),
    );
  });

  it('omits the URL lines when the server sends no image content', async () => {
    startLogin.mockResolvedValue({ qrcodeId: 'qr-1' });
    waitForLogin.mockResolvedValue({
      connected: true,
      token: 'tok',
      message: 'Connected to WeChat successfully!',
    });

    await run();

    expect(stderr.join('')).toBe('Scan the QR code with WeChat to connect.\n');
    expect(stdout.join('')).toContain('Connected to WeChat successfully!');
  });

  it('prints scan, expiry and the replacement QR in order', async () => {
    startLogin.mockResolvedValue({
      qrcodeId: 'qr-1',
      qrcodeUrl: 'https://scan.example/qr-1',
    });
    waitForLogin.mockImplementation(
      async (params: {
        onEvent?: (event: Record<string, unknown>) => void;
      }) => {
        params.onEvent?.({ type: 'scanned' });
        params.onEvent?.({ type: 'expired' });
        params.onEvent?.({
          type: 'qrcode',
          qrcodeId: 'qr-2',
          qrcodeUrl: 'https://scan.example/qr-2',
        });
        return {
          connected: true,
          token: 'tok',
          message: 'Connected to WeChat successfully!',
        };
      },
    );

    await run();

    expect(stderr.join('')).toBe(
      'QR code URL: https://scan.example/qr-1\n' +
        'Scan this URL with WeChat.\n' +
        'Scan the QR code with WeChat to connect.\n' +
        'QR code scanned, waiting for confirmation...\n' +
        'QR code expired, refreshing...\n' +
        'QR code URL: https://scan.example/qr-2\n' +
        'Scan this URL with WeChat.\n' +
        'Scan the QR code with WeChat to connect.\n',
    );
    expect(stdout.join('')).toContain('Connected to WeChat successfully!');
  });

  it('reports status and clears without touching the login helpers', async () => {
    loadAccount.mockReturnValue({
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      userId: 'u-1',
      savedAt: '2026-11-09T00:00:00.000Z',
    });

    await run('status');
    expect(stdout.join('')).toContain(
      'WeChat account configured (saved 2026-11-09T00:00:00.000Z)',
    );
    expect(stdout.join('')).toContain('User ID: u-1');
    expect(stdout.join('')).not.toContain('tok');

    stdout.length = 0;
    await run('clear');
    expect(clearAccount).toHaveBeenCalledOnce();
    expect(stdout.join('')).toBe('WeChat credentials cleared.\n');
    expect(startLogin).not.toHaveBeenCalled();
  });
});
