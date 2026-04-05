/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  selectTip,
  tipRegistry,
  type TipContext,
} from '../../services/tips/index.js';
import { TipHistory } from '../../services/tips/tipHistory.js';

const tempPaths: string[] = [];

function tmpPath(): string {
  const p = join(
    tmpdir(),
    `test-tips-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tempPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempPaths) {
    rmSync(p, { force: true });
  }
  tempPaths.length = 0;
});

function createContext(overrides: Partial<TipContext> = {}): TipContext {
  return {
    lastPromptTokenCount: 0,
    contextWindowSize: 1_000_000,
    compressionThreshold: 0.7,
    sessionPromptCount: 0,
    sessionCount: 1,
    platform: 'linux',
    ...overrides,
  };
}

function createHistory(): TipHistory {
  return new TipHistory({ sessionCount: 1, tips: {} }, tmpPath());
}

describe('selectTip', () => {
  it('returns a startup tip for new user', () => {
    const ctx = createContext({ sessionCount: 1 });
    const history = createHistory();
    const tip = selectTip('startup', ctx, tipRegistry, history);
    expect(tip).not.toBeNull();
    expect(tip!.trigger).toBe('startup');
  });

  it('returns context-high tip when context usage is high', () => {
    const ctx = createContext({
      lastPromptTokenCount: 850_000,
      contextWindowSize: 1_000_000,
      sessionPromptCount: 10,
    });
    const history = createHistory();
    const tip = selectTip('post-response', ctx, tipRegistry, history);
    expect(tip).not.toBeNull();
    expect(tip!.id).toBe('context-high');
  });

  it('returns context-critical tip when context usage is critical', () => {
    const ctx = createContext({
      lastPromptTokenCount: 960_000,
      contextWindowSize: 1_000_000,
      sessionPromptCount: 10,
    });
    const history = createHistory();
    const tip = selectTip('post-response', ctx, tipRegistry, history);
    expect(tip).not.toBeNull();
    expect(tip!.id).toBe('context-critical');
  });

  it('returns compress-intro tip when context is moderate and session is long', () => {
    const ctx = createContext({
      lastPromptTokenCount: 550_000,
      contextWindowSize: 1_000_000,
      sessionPromptCount: 10,
    });
    const history = createHistory();
    const tip = selectTip('post-response', ctx, tipRegistry, history);
    expect(tip).not.toBeNull();
    expect(tip!.id).toBe('compress-intro');
  });

  it('returns null for post-response when context usage is low', () => {
    const ctx = createContext({
      lastPromptTokenCount: 100_000,
      contextWindowSize: 1_000_000,
      sessionPromptCount: 2,
    });
    const history = createHistory();
    const tip = selectTip('post-response', ctx, tipRegistry, history);
    expect(tip).toBeNull();
  });

  it('respects cooldown — does not re-show same tip within cooldown period', () => {
    const ctx = createContext({
      lastPromptTokenCount: 850_000,
      contextWindowSize: 1_000_000,
      sessionPromptCount: 10,
    });
    const history = createHistory();

    // First selection should return context-high
    const tip1 = selectTip('post-response', ctx, tipRegistry, history);
    expect(tip1!.id).toBe('context-high');

    // Record it as shown
    history.recordShown(tip1!.id, 10);

    // Same prompt count — should be cooled down, skip context-high
    const tip2 = selectTip('post-response', ctx, tipRegistry, history);
    // Should either be null or a different tip
    expect(tip2?.id).not.toBe('context-high');
  });

  it('selects a new-user tip for brand new users', () => {
    const ctx = createContext({ sessionCount: 1 });
    const history = createHistory();
    const tip = selectTip('startup', ctx, tipRegistry, history);
    // New user tips have priority 70, so one of them should be selected
    expect(tip).not.toBeNull();
    expect(tip!.priority).toBe(70);
  });

  it('rotates startup tips across sessions via LRU', () => {
    const ctx = createContext({ sessionCount: 1 });
    const history = createHistory();

    // Pick first tip
    const tip1 = selectTip('startup', ctx, tipRegistry, history);
    expect(tip1).not.toBeNull();
    history.recordShown(tip1!.id, 0);

    // Pick second tip — should be different due to LRU
    const tip2 = selectTip('startup', ctx, tipRegistry, history);
    expect(tip2).not.toBeNull();
    expect(tip2!.id).not.toBe(tip1!.id);
  });

  it('returns a priority-70 tip for experienced users with insight available', () => {
    const ctx = createContext({ sessionCount: 25 });
    const history = createHistory();
    const tip = selectTip('startup', ctx, tipRegistry, history);
    // insight-command has priority 70, same as other new-user tips
    expect(tip).not.toBeNull();
    expect(tip!.priority).toBe(70);
  });
});
