/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-turn regression tests (R2): the prompt reaches the client as a full
 * PartListUnion (multimodal included) and the per-turn modelOverride travels
 * through SendMessageOptions.
 */

import { describe, it, expect, vi } from 'vitest';
import { SendMessageType } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import { livePromptEvents } from './live-session.js';

function createFakeConfig(sendMessageStream: (...args: unknown[]) => unknown) {
  return {
    initialize: vi.fn(async () => {}),
    getGeminiClient: () => ({ sendMessageStream }),
  } as unknown as Config;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('livePromptEvents', () => {
  it('forwards string prompts without send options', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const signal = new AbortController().signal;

    await drain(livePromptEvents(config, 'hello', signal));

    expect(config.initialize).toHaveBeenCalled();
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt, passedSignal, promptId, options] = sendMessageStream.mock
      .calls[0] as unknown[];
    expect(prompt).toBe('hello');
    expect(passedSignal).toBe(signal);
    expect(String(promptId)).toMatch(/^opentui-/);
    expect(options).toBeUndefined();
  });

  it('forwards multimodal part lists unchanged', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const parts = [
      { text: 'describe this: ' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ];

    await drain(livePromptEvents(config, parts));

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
  });

  it('passes the per-turn modelOverride through send options', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'go', undefined, { modelOverride: 'fast-x' }),
    );

    const [, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      modelOverride: 'fast-x',
    });
  });
});
