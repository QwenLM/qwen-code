/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockProcessImageAttachments,
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockExportSessionToFile,
} = vi.hoisted(() => ({
  mockProcessImageAttachments: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockExportSessionToFile: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

vi.mock('../utils/imageHandler.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/imageHandler.js')>();
  return {
    ...actual,
    processImageAttachments: mockProcessImageAttachments,
  };
});

vi.mock('../../services/sessionExportService.js', () => ({
  parseExportSlashCommand: (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '/export') {
      return 'html';
    }
    if (trimmed === '/export md') {
      return 'md';
    }
    return null;
  },
  exportSessionToFile: mockExportSessionToFile,
}));

import { SessionMessageHandler } from './SessionMessageHandler.js';

describe('SessionMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: '',
      displayText: '',
      savedImageCount: 0,
      promptImages: [],
    });
    mockShowInformationMessage.mockResolvedValue(undefined);
    mockExportSessionToFile.mockResolvedValue({
      cancelled: false,
      filename: 'export.html',
      uri: { fsPath: '/workspace/export.html' },
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

  it('sends formatted prompt text so session restore can reconstruct pasted images', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: '这是什么内容\n\n@/tmp/clipboard/clipboard-123.png',
      displayText: '这是什么内容\n\n@/tmp/clipboard/clipboard-123.png',
      savedImageCount: 1,
      promptImages: [
        {
          path: '/tmp/clipboard/clipboard-123.png',
          name: 'clipboard-123.png',
          mimeType: 'image/png',
        },
      ],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn().mockResolvedValue(undefined),
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
        text: '这是什么内容',
        attachments: [
          {
            id: 'img-1',
            name: 'clipboard-123.png',
            type: 'image/png',
            size: 3,
            data: 'data:image/png;base64,YWJj',
            timestamp: Date.now(),
          },
        ],
      },
    });

    expect(agentManager.sendMessage).toHaveBeenCalledWith([
      {
        type: 'text',
        text: '这是什么内容\n\n@/tmp/clipboard/clipboard-123.png',
      },
      {
        type: 'resource_link',
        name: 'clipboard-123.png',
        mimeType: 'image/png',
        uri: 'file:///tmp/clipboard/clipboard-123.png',
      },
    ]);
  });

  it('intercepts /export and uses the VSCode export flow instead of sending a prompt', async () => {
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      getSessionList: vi
        .fn()
        .mockResolvedValue([{ sessionId: 'session-1', cwd: '/workspace' }]),
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      addMessage: vi.fn(),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'sendMessage',
      data: {
        text: '/export',
      },
    });

    expect(mockExportSessionToFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/workspace',
      format: 'html',
    });
    expect(conversationStore.addMessage).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Session exported to HTML: export.html',
      'Open File',
    );
  });

  it('reports export failures back to the user', async () => {
    mockExportSessionToFile.mockRejectedValue(new Error('disk full'));

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      getSessionList: vi
        .fn()
        .mockResolvedValue([{ sessionId: 'session-1', cwd: '/workspace' }]),
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      addMessage: vi.fn(),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'sendMessage',
      data: {
        text: '/export md',
      },
    });

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'Failed to export session: disk full',
    );
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'Failed to export session: disk full' },
    });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });
});
