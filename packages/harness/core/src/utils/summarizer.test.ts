/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import type { Config } from '../config/config.js';
import { summarizeToolOutput } from './summarizer.js';
import { runLogger } from './runLogger.js';

describe('summarizeToolOutput', () => {
  let select: Mock;
  let inference: Mock;
  let config: Config;
  const abortSignal = new AbortController().signal;
  const model = { key: 'lite', source: 'qwen-provider', limits: {} };

  const respond = (text: string) =>
    inference.mockResolvedValue({
      completed: Promise.resolve({ blocks: [{ type: 'text', text }] }),
    });

  beforeEach(() => {
    select = vi.fn().mockResolvedValue({ model, config: {} });
    inference = vi.fn();
    config = {
      getSessionId: () => 'session-1',
      getModelProviderManager: () => ({ select, inference }),
    } as unknown as Config;
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns short or empty text without calling the model', async () => {
    for (const text of ['', 'This is a short text.']) {
      expect(
        await summarizeToolOutput(config, text, abortSignal),
      ).toBe(text);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it('summarizes long text through the summary purpose', async () => {
    const longText = 'This is a very long text.'.repeat(200);
    respond('This is a summary.');

    const result = await summarizeToolOutput(config, longText, abortSignal);

    expect(select).toHaveBeenCalledWith({ purpose: 'summary' });
    const request = inference.mock.calls[0][0];
    expect(request.model).toBe(model);
    expect(request.maxTokens).toBe(2000);
    expect(request.messages[0].content).toContain(`"${longText}"`);
    expect(result).toBe('This is a summary.');
  });

  it('returns the original text when inference fails', async () => {
    const longText = 'This is a very long text.'.repeat(200);
    inference.mockRejectedValue(new Error('API Error'));

    expect(
      await summarizeToolOutput(config, longText, abortSignal),
    ).toBe(longText);
  });
});
