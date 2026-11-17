/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkControlServerTransport } from '../../src/daemon-mcp/SdkControlServerTransport.js';
import { parseJsonLinesStream } from '../../src/utils/jsonLines.js';
import { SdkLogger } from '../../src/utils/logger.js';

afterEach(() => SdkLogger.configure({}));

describe('scoped SDK logging', () => {
  it('preserves dynamic global logging for callers without a scoped config', () => {
    const initial = vi.fn();
    const replacement = vi.fn();
    SdkLogger.configure({ stderr: initial });
    const logger = SdkLogger.createLogger('global');
    SdkLogger.configure({ stderr: replacement });
    logger.error('after reconfiguration');
    expect(initial).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(
      expect.stringContaining('after reconfiguration'),
    );
  });

  it('captures global defaults without letting later changes replace a scoped callback', () => {
    const initial = vi.fn();
    const replacement = vi.fn();
    SdkLogger.configure({ stderr: initial, logLevel: 'warn' });
    const logger = SdkLogger.createLogger('query', {});
    SdkLogger.configure({ stderr: replacement, logLevel: 'error' });
    logger.warn('original query');
    expect(initial).toHaveBeenCalledWith(
      expect.stringContaining('original query'),
    );
    expect(replacement).not.toHaveBeenCalled();
  });

  it('keeps the explicit log level above the debug flag', () => {
    const stderr = vi.fn();
    const logger = SdkLogger.createLogger('query', {
      stderr,
      debug: true,
      logLevel: 'error',
    });
    logger.debug('hidden');
    logger.error('visible');
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('visible'));
  });

  it('routes JSON parsing diagnostics through the owning transport logger', async () => {
    const stderr = vi.fn();
    const unrelated = vi.fn();
    const logger = SdkLogger.createLogger('transport', { stderr, debug: true });
    SdkLogger.configure({ stderr: unrelated, debug: true });
    async function* lines() {
      yield 'invalid JSON';
      yield '{"noType":true}';
      yield '{"type":"result"}';
    }
    const messages: unknown[] = [];
    for await (const message of parseJsonLinesStream(
      lines(),
      'transport',
      logger,
    )) {
      messages.push(message);
    }
    expect(messages).toEqual([{ type: 'result' }]);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(unrelated).not.toHaveBeenCalled();
  });

  it('keeps embedded MCP diagnostics with the owning query configuration', async () => {
    const stderr = vi.fn();
    const unrelated = vi.fn();
    const transport = new SdkControlServerTransport({
      serverName: 'local-tools',
      sendToQuery: async () => {},
      loggerConfig: { stderr, debug: true },
    });
    SdkLogger.configure({ stderr: unrelated, debug: true });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    await transport.close();
    expect(stderr).toHaveBeenCalledTimes(3);
    expect(unrelated).not.toHaveBeenCalled();
  });
});
