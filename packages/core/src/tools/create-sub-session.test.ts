/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { CreateSubSessionTool } from './create-sub-session.js';
import type { Config, SubSessionSpawner } from '../config/config.js';

function makeConfig(spawner?: SubSessionSpawner): Config {
  return {
    getSubSessionSpawner: () => spawner,
  } as unknown as Config;
}

describe('CreateSubSessionTool', () => {
  it('has the correct name', () => {
    expect(new CreateSubSessionTool(makeConfig()).name).toBe(
      'create_sub_session',
    );
  });

  it('defaults to ask permission so delegated prompts face classifier review', async () => {
    const tool = new CreateSubSessionTool(makeConfig());
    const invocation = tool.build({ prompt: 'do X' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
  });

  it('reports daemon-only when no spawner is wired (interactive / headless)', async () => {
    const tool = new CreateSubSessionTool(makeConfig(undefined));
    const res = await tool
      .build({ prompt: 'do X' })
      .execute(new AbortController().signal);
    expect(res.error?.message).toContain('qwen serve');
    expect(res.returnDisplay).toContain('daemon-only');
  });

  it('first-turn (default): passes trimmed params to the spawner and returns its result', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-1',
      result: 'the answer',
      stopReason: 'end_turn',
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: '  summarize  ', model: 'm1', name: 'digest' })
      .execute(new AbortController().signal);

    expect(spawner).toHaveBeenCalledWith({
      prompt: 'summarize',
      completion: 'first-turn',
      model: 'm1',
      name: 'digest',
    });
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('the answer');
    expect(res.llmContent).toContain('sub-1');
  });

  it('sent: returns immediately with the session id, not a result', async () => {
    const spawner = vi.fn(async () => ({ sessionId: 'sub-2' }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'go', completion: 'sent' })
      .execute(new AbortController().signal);

    expect(spawner).toHaveBeenCalledWith({ prompt: 'go', completion: 'sent' });
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('sub-2');
    expect(res.llmContent).toMatch(/did not wait/i);
  });

  it('reports a completed-but-empty first turn without an error', async () => {
    const spawner = vi.fn(async () => ({
      sessionId: 'sub-3',
      result: '',
      stopReason: 'end_turn',
    }));
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(res.error).toBeUndefined();
    expect(res.llmContent).toContain('no text output');
  });

  it('surfaces a spawner error as a tool error', async () => {
    const spawner = vi.fn(async () => {
      throw new Error('spawn boom');
    });
    const tool = new CreateSubSessionTool(makeConfig(spawner));
    const res = await tool
      .build({ prompt: 'x' })
      .execute(new AbortController().signal);
    expect(res.error?.message).toContain('spawn boom');
  });
});
