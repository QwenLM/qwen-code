/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, vi } from 'vitest';
import { getErrorMessage } from '../utils/errors.js';
import { connectWithStartupStderr } from './mcp-startup-stderr.js';

function client() {
  return new Client(
    { name: 'startup-diagnostic-test', version: '1' },
    { versionNegotiation: { mode: 'legacy' } },
  );
}

function stdio(script = '') {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['-e', script],
    stderr: 'pipe',
  });
}

describe('MCP startup stderr', () => {
  it('includes a real child diagnostic when it exits before initialization', async () => {
    const sdk = client();
    const transport = stdio(
      'process.stderr.write("env: node: No such file or directory\\n"); process.exitCode = 23;',
    );
    try {
      await expect(
        connectWithStartupStderr(sdk, transport, { timeout: 5000 }),
      ).rejects.toThrow('env: node: No such file or directory');
      expect(transport.stderr?.listenerCount('data')).toBe(0);
    } finally {
      await sdk.close();
      await transport.close();
    }
  });

  it('decodes UTF-8 diagnostics split across transport chunks', async () => {
    const sdk = client();
    const transport = stdio();
    vi.spyOn(sdk, 'connect').mockImplementation(async () => {
      const bytes = Buffer.from('启动失败 😀');
      for (const byte of bytes) {
        transport.stderr?.emit('data', Buffer.from([byte]));
      }
      throw new Error('Connection closed');
    });
    await expect(connectWithStartupStderr(sdk, transport, {})).rejects.toThrow(
      '启动失败 😀',
    );
  });

  it('keeps the bounded actionable tail visible through public error formatting', async () => {
    const sdk = client();
    const transport = stdio();
    const original = new Error('Connection closed');
    vi.spyOn(sdk, 'connect').mockImplementation(async () => {
      transport.stderr?.emit(
        'data',
        Buffer.from('old diagnostic\n'.repeat(1000)),
      );
      transport.stderr?.emit(
        'data',
        Buffer.from('FINAL: interpreter missing\n'),
      );
      throw original;
    });

    const failure = await connectWithStartupStderr(sdk, transport, {}).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBe(original);
    expect(getErrorMessage(failure)).toContain('(truncated)');
    expect(getErrorMessage(failure)).toContain('FINAL: interpreter missing');
    expect(getErrorMessage(failure).length).toBeLessThanOrEqual(1000);
    expect(transport.stderr?.listenerCount('data')).toBe(0);
  });

  it('uses credential and terminal display policies before clipping the output', async () => {
    const sdk = client();
    const transport = stdio();
    vi.spyOn(sdk, 'connect').mockImplementation(async () => {
      transport.stderr?.emit(
        'data',
        Buffer.from(
          '\u001b[31mfailed https://user:private-password@example.test\u001b[0m\n' +
            'HTTP Author',
        ),
      );
      transport.stderr?.emit(
        'data',
        Buffer.from(
          'ization: Bearer private-bearer-value\n' +
            '{"Proxy-Authorization": "Basic private-proxy-value"}\n' +
            'configuration missing',
        ),
      );
      throw new Error('Connection closed');
    });

    const failure = await connectWithStartupStderr(sdk, transport, {}).catch(
      (error: unknown) => error,
    );
    const message = getErrorMessage(failure);
    expect(message).toContain('https://***REDACTED***@example.test');
    expect(message).toContain('\nconfiguration missing');
    expect(message).not.toContain('private-password');
    expect(message).not.toContain('private-bearer-value');
    expect(message).not.toContain('private-proxy-value');
    expect(message).toContain('Authorization: <redacted>');
    expect(message).not.toContain('\u001b');
  });

  it('does not expose a credential whose line crossed the retention boundary', async () => {
    const sdk = client();
    const transport = stdio();
    vi.spyOn(sdk, 'connect').mockImplementation(async () => {
      transport.stderr?.emit(
        'data',
        Buffer.from(
          `https://user:${'s'.repeat(5000)}@example.test\ninterpreter missing`,
        ),
      );
      throw new Error('Connection closed');
    });

    const failure = await connectWithStartupStderr(sdk, transport, {}).catch(
      (error: unknown) => error,
    );
    expect(getErrorMessage(failure)).toContain('interpreter missing');
    expect(getErrorMessage(failure)).not.toContain('ssss');
    expect(getErrorMessage(failure)).not.toContain('example.test');
  });

  it('releases capture after success and retains an existing debug listener', async () => {
    const sdk = client();
    const transport = stdio();
    const debug = vi.fn();
    transport.stderr?.on('data', debug);
    const original = new Error('later connection failure');
    vi.spyOn(sdk, 'connect')
      .mockImplementationOnce(async () => {
        transport.stderr?.emit('data', Buffer.from('healthy startup message'));
      })
      .mockRejectedValueOnce(original);

    await connectWithStartupStderr(sdk, transport, {});
    expect(transport.stderr?.listeners('data')).toEqual([debug]);
    expect(debug).toHaveBeenCalledOnce();
    await expect(connectWithStartupStderr(sdk, transport, {})).rejects.toBe(
      original,
    );
    expect(transport.stderr?.listeners('data')).toEqual([debug]);
    transport.stderr?.off('data', debug);
  });

  it('preserves cancellation and removes its listener', async () => {
    const sdk = client();
    const transport = stdio();
    const cancelled = new DOMException('Cancelled', 'AbortError');
    vi.spyOn(sdk, 'connect').mockImplementation(async () => {
      transport.stderr?.emit('data', Buffer.from('starting'));
      throw cancelled;
    });

    await expect(connectWithStartupStderr(sdk, transport, {})).rejects.toBe(
      cancelled,
    );
    expect(transport.stderr?.listenerCount('data')).toBe(0);
  });

  it('preserves non-stdio connection errors', async () => {
    const sdk = client();
    const transport: Transport = {
      start: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    const original = new Error('HTTP connection refused');
    vi.spyOn(sdk, 'connect').mockRejectedValue(original);
    await expect(connectWithStartupStderr(sdk, transport, {})).rejects.toBe(
      original,
    );
  });
});
