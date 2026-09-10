/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebugLogger } from './debug-log.js';

const previous = process.env['QWEN_NODE_REPL_DEBUG'];

afterEach(() => {
  if (previous === undefined) delete process.env['QWEN_NODE_REPL_DEBUG'];
  else process.env['QWEN_NODE_REPL_DEBUG'] = previous;
  vi.restoreAllMocks();
});

describe('createDebugLogger', () => {
  it('is disabled unless the env var is set to a truthy value', () => {
    const logger = createDebugLogger('T');
    for (const value of ['', '0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      process.env['QWEN_NODE_REPL_DEBUG'] = value;
      expect(logger.isEnabled()).toBe(false);
    }
    delete process.env['QWEN_NODE_REPL_DEBUG'];
    expect(logger.isEnabled()).toBe(false);

    process.env['QWEN_NODE_REPL_DEBUG'] = '1';
    expect(logger.isEnabled()).toBe(true);
  });

  it('writes to stderr only — stdout is the MCP JSON-RPC channel', () => {
    process.env['QWEN_NODE_REPL_DEBUG'] = '1';
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const out = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const logger = createDebugLogger('NS');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(err).toHaveBeenCalledTimes(4);
    expect(out).not.toHaveBeenCalled();
    // Written directly, not routed through console.* (which a host could rebind).
    expect(consoleErr).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^\[NS\] d\n$/);
  });

  it('emits nothing at all when disabled', () => {
    delete process.env['QWEN_NODE_REPL_DEBUG'];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const logger = createDebugLogger('NS');
    logger.debug('d');
    logger.warn('w');
    expect(err).not.toHaveBeenCalled();
  });
});
