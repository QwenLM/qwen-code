/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshotSettingsForRollback: vi.fn(),
  SessionMessageHandler: vi.fn(),
  FileMessageHandler: vi.fn(),
  EditorMessageHandler: vi.fn(),
  AuthMessageHandler: vi.fn(),
}));

vi.mock('../../services/settingsWriter.js', () => ({
  snapshotSettingsForRollback: mocks.snapshotSettingsForRollback,
}));

vi.mock('./SessionMessageHandler.js', () => ({
  SessionMessageHandler: mocks.SessionMessageHandler,
}));

vi.mock('./FileMessageHandler.js', () => ({
  FileMessageHandler: mocks.FileMessageHandler,
}));

vi.mock('./EditorMessageHandler.js', () => ({
  EditorMessageHandler: mocks.EditorMessageHandler,
}));

vi.mock('./AuthMessageHandler.js', () => ({
  AuthMessageHandler: mocks.AuthMessageHandler,
}));

import { MessageRouter } from './MessageRouter.js';

describe('MessageRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const constructor of [
      mocks.SessionMessageHandler,
      mocks.FileMessageHandler,
      mocks.EditorMessageHandler,
      mocks.AuthMessageHandler,
    ]) {
      constructor.mockImplementation(() => ({
        canHandle: () => false,
        handle: vi.fn(),
      }));
    }
  });

  it('provides saved model providers to the auth handler', () => {
    const modelProviders = {
      openai: [{ id: 'kimi-custom', baseUrl: undefined }],
    };
    mocks.snapshotSettingsForRollback.mockReturnValue({ modelProviders });

    new MessageRouter({} as never, {} as never, null, vi.fn());

    expect(mocks.FileMessageHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      expect.any(Function),
    );
    const getModelProviders = mocks.AuthMessageHandler.mock.calls[0]?.[4];
    expect(getModelProviders).toEqual(expect.any(Function));
    expect(getModelProviders()).toBe(modelProviders);
  });

  it('fails closed when saved provider settings cannot be read', () => {
    mocks.snapshotSettingsForRollback.mockReturnValue(null);

    new MessageRouter({} as never, {} as never, null, vi.fn());

    const getModelProviders = mocks.AuthMessageHandler.mock.calls[0]?.[4];
    expect(getModelProviders).toEqual(expect.any(Function));
    expect(() => getModelProviders()).toThrow(
      /aborting to protect the existing configuration/,
    );
  });
});
