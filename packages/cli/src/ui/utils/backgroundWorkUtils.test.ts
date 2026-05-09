/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  agentRegister,
  monitorRegister,
  shellRegister,
  TaskRegistry,
  type Config,
} from '@qwen-code/qwen-code-core';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from './backgroundWorkUtils.js';

function createMockConfig(registry: TaskRegistry): Config {
  return {
    getTaskRegistry: () => registry,
  } as unknown as Config;
}

describe('hasBlockingBackgroundWork', () => {
  it('returns false when nothing is running', () => {
    const registry = new TaskRegistry();
    expect(hasBlockingBackgroundWork(createMockConfig(registry))).toBe(false);
  });

  it('returns true when a backgrounded agent is still running (unfinalized)', () => {
    const registry = new TaskRegistry();
    agentRegister(registry, {
      agentId: 'a1',
      description: 'agent',
      isBackgrounded: true,
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/a.jsonl',
    });
    expect(hasBlockingBackgroundWork(createMockConfig(registry))).toBe(true);
  });

  it('returns true when a monitor is running', () => {
    const registry = new TaskRegistry();
    monitorRegister(registry, {
      monitorId: 'm1',
      description: 'monitor',
      command: 'tail -f log',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/m.log',
      eventCount: 0,
      lastEventTime: 0,
      maxEvents: 100,
      idleTimeoutMs: 60000,
      droppedLines: 0,
    });
    expect(hasBlockingBackgroundWork(createMockConfig(registry))).toBe(true);
  });

  it('returns true when a shell is running', () => {
    const registry = new TaskRegistry();
    shellRegister(registry, {
      shellId: 's1',
      command: 'sleep 30',
      cwd: '/tmp',
      status: 'running',
      startTime: Date.now(),
      outputPath: '/tmp/s.out',
      abortController: new AbortController(),
    });
    expect(hasBlockingBackgroundWork(createMockConfig(registry))).toBe(true);
  });

  it('returns false once the only running entry has settled', () => {
    const registry = new TaskRegistry();
    shellRegister(registry, {
      shellId: 's1',
      command: 'sleep 30',
      cwd: '/tmp',
      status: 'completed',
      startTime: Date.now(),
      outputPath: '/tmp/s.out',
      abortController: new AbortController(),
    });
    expect(hasBlockingBackgroundWork(createMockConfig(registry))).toBe(false);
  });
});

describe('resetBackgroundStateForSessionSwitch', () => {
  it('clears every kind from the registry', () => {
    const registry = new TaskRegistry();
    agentRegister(registry, {
      agentId: 'a1',
      description: 'agent',
      isBackgrounded: false,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/a.jsonl',
    });
    shellRegister(registry, {
      shellId: 's1',
      command: 'sleep 30',
      cwd: '/tmp',
      status: 'completed',
      startTime: Date.now(),
      outputPath: '/tmp/s.out',
      abortController: new AbortController(),
    });
    monitorRegister(registry, {
      monitorId: 'm1',
      description: 'monitor',
      command: 'tail -f log',
      status: 'completed',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/m.log',
      eventCount: 0,
      lastEventTime: 0,
      maxEvents: 100,
      idleTimeoutMs: 60000,
      droppedLines: 0,
    });

    resetBackgroundStateForSessionSwitch(createMockConfig(registry));

    expect(registry.getAll()).toEqual([]);
  });
});
