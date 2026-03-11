/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { daemonCommand } from './daemon.js';

describe('daemonCommand', () => {
  it('should have correct command name', () => {
    expect(daemonCommand.command).toBe('daemon');
  });

  it('should have a description', () => {
    expect(daemonCommand.describe).toBeTruthy();
  });

  it('should have a builder that registers subcommands', () => {
    expect(daemonCommand.builder).toBeDefined();
  });

  it('should have a handler', () => {
    expect(daemonCommand.handler).toBeDefined();
  });
});
