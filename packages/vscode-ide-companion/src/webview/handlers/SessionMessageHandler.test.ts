/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockProcessImageAttachments, mockShowErrorMessage } = vi.hoisted(
  () => ({
    mockProcessImageAttachments: vi.fn(),
    mockShowErrorMessage: vi.fn(),
  }),
);

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

vi.mock('../utils/imageAttachmentHandler.js', () => ({
  processImageAttachments: mockProcessImageAttachments,
}));

import { SessionMessageHandler } from './SessionMessageHandler.js';

describe('SessionMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: '',
      displayText: '',
      savedImageCount: 0,
    });
  });

  it('does not create conversation state or send an empty prompt when all pasted images fail to materialize', async () => {
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      getConversation: vi.fn().mockResolvedValue(null),
      addMessage: vi.fn(),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      null,
      sendToWebView,
    );

    await handler.handle({
      type: 'sendMessage',
      data: {
        text: '',
        attachments: [
          {
            id: 'img-1',
            name: 'pasted.png',
            type: 'image/png',
            size: 3,
            data: 'data:image/png;base64,YWJj',
            timestamp: Date.now(),
          },
        ],
      },
    });

    expect(conversationStore.createConversation).not.toHaveBeenCalled();
    expect(conversationStore.addMessage).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({
          message: expect.stringContaining('image'),
        }),
      }),
    );
  });
});
