/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal, parse } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  parse: vi.fn((url: string) => ({ url })),
}));
vi.mock('vscode', () => ({ env: { openExternal }, Uri: { parse } }));

import { EditorMessageHandler } from './EditorMessageHandler.js';

describe('external browser host bridge', () => {
  const send = vi.fn();
  const handler = new EditorMessageHandler(
    {} as never,
    {} as never,
    null,
    send,
  );
  beforeEach(() => {
    vi.clearAllMocks();
    openExternal.mockResolvedValue(true);
  });

  it('opens an authorization URL through VS Code instead of the daemon host', async () => {
    const url =
      'https://pre4-chat.qwen.ai/authorize?user_code=123&client=qwen-code';
    expect(handler.canHandle('openExternalUrl')).toBe(true);
    await handler.handle({ type: 'openExternalUrl', data: { url } });
    expect(openExternal).toHaveBeenCalledWith({ url });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    'command:workbench.action.closeWindow',
    'file:///private/data',
    'javascript:alert(1)',
    'not a URL',
    'https://user:secret@example.com',
    undefined,
  ])('rejects unsafe or malformed URLs: %s', async (url) => {
    await handler.handle({ type: 'openExternalUrl', data: { url } });
    expect(openExternal).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      data: { message: expect.any(String) },
    });
  });

  it('reports browser opening failures without losing the displayed authorization link', async () => {
    openExternal.mockResolvedValue(false);
    await handler.handle({
      type: 'openExternalUrl',
      data: {
        url: 'https://pre4-chat.qwen.ai/authorize?user_code=123&client=qwen-code',
      },
    });
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      data: {
        message: 'Could not open the browser. Please use the displayed link.',
      },
    });
  });
});
