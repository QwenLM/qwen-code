/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStore, saveStore, upsertEntry } from './background-store.js';

describe('background-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-test-'));
    // mock the store path to use tmpDir
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no store file', () => {
    expect(loadStore()).toEqual([]);
  });

  it('saves and loads entries', () => {
    const entry = {
      agentId: 'test-1',
      agentName: 'general-purpose',
      description: 'do something',
      startTime: Date.now(),
      status: 'completed' as const,
      result: 'done',
    };
    saveStore([entry]);
    const loaded = loadStore();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].agentId).toBe('test-1');
  });

  it('prunes entries older than 24h on load', () => {
    const old = {
      agentId: 'old-1',
      agentName: 'general-purpose',
      description: 'old task',
      startTime: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      status: 'completed' as const,
    };
    const recent = {
      agentId: 'new-1',
      agentName: 'general-purpose',
      description: 'new task',
      startTime: Date.now(),
      status: 'running' as const,
    };
    saveStore([old, recent]);
    const loaded = loadStore();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].agentId).toBe('new-1');
  });

  it('prunes entries older than 24h on save', () => {
    const old = {
      agentId: 'old-1',
      agentName: 'general-purpose',
      description: 'old task',
      startTime: Date.now() - 25 * 60 * 60 * 1000,
      status: 'completed' as const,
    };
    saveStore([old]);
    // File should exist but be empty after pruning
    const loaded = loadStore();
    expect(loaded).toHaveLength(0);
  });

  it('upsertEntry updates existing by agentId', () => {
    const original = {
      agentId: 'a',
      agentName: 'x',
      description: 'p',
      startTime: 1,
      status: 'running' as const,
    };
    const updated = {
      ...original,
      status: 'completed' as const,
      result: 'done',
    };
    const result = upsertEntry([original], updated);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('completed');
  });

  it('upsertEntry appends new entry', () => {
    const a = {
      agentId: 'a',
      agentName: 'x',
      description: 'p',
      startTime: 1,
      status: 'running' as const,
    };
    const b = {
      agentId: 'b',
      agentName: 'y',
      description: 'q',
      startTime: 2,
      status: 'running' as const,
    };
    expect(upsertEntry([a], b)).toHaveLength(2);
  });

  it('handles corrupted store file gracefully', () => {
    const storePath = path.join(tmpDir, '.proto', 'agents', 'background.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, 'not valid json', 'utf-8');
    expect(loadStore()).toEqual([]);
  });
});
