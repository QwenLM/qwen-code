/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseLiveCliArgs } from './cli-args.js';
import { displayLiveMessage } from './i18n/messages.js';

describe('parseLiveCliArgs', () => {
  it('enables debug logging for either debug spelling', () => {
    expect(parseLiveCliArgs(['--debug'])).toEqual({
      command: 'start',
      debug: true,
    });
    expect(parseLiveCliArgs(['init', '-d'])).toEqual({
      command: 'init',
      debug: true,
    });
  });

  it('parses help and rejects unknown arguments', () => {
    expect(parseLiveCliArgs(['--help'])).toEqual({
      command: 'help',
      debug: false,
    });
    try {
      parseLiveCliArgs(['--verbose']);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(displayLiveMessage('en', (error as Error).message)).toBe(
        'Unknown qwen-live argument: --verbose',
      );
    }
  });
});
