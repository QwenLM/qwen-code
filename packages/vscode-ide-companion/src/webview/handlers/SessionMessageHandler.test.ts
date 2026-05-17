/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockProcessImageAttachments,
  mockShowErrorMessage,
  mockExportSessionToFile,
} = vi.hoisted(() => ({
  mockProcessImageAttachments: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockExportSessionToFile: vi.fn(),
}));
const { mockExecuteCommand } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: mockExecuteCommand,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      toString: () =>
        `file://${encodeURI(fsPath.replace(/\\/g, '/')).replace(/#/g, '%23')}`,
    }),
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
    if (trimmed === '/export html') {
      return 'html';
    }
    if (trimmed === '/export md') {
      return 'md';
    }
    if (trimmed === '/export') {
      throw new Error("Command '/export' requires a subcommand.");
    }
    return null;
  },
  exportSessionToFile: mockExportSessionToFile,
}));

vi.mock('@qwen-code/webui', () => ({
  stripZeroWidthSpaces: (text: string) => text.replace(/\u200B/g, ''),
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
    mockExportSessionToFile.mockResolvedValue({
      filename: 'export.html',
      uri: { fsPath: '/workspace/export.html' },
    });
  });

  it('forwards the active model when opening a new chat tab', async () => {
    const handler = new SessionMessageHandler(
      {
        isConnected: true,
        currentSessionId: 'session-1',
      } as never,
      {} as never,
      null,
      vi.fn(),
    );

    await handler.handle({
      type: 'openNewChatTab',
      data: { modelId: 'glm-5' },
    });

    expect(mockExecuteCommand).toHaveBeenCalledWith('qwenCode.openNewChatTab', {
      initialModelId: 'glm-5',
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
      renameConversationId: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'conversation-1',
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
      renameConversationId: vi.fn().mockResolvedValue(true),
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

  it('keeps the conversation store aligned with the ACP session id before editing', async () => {
    mockProcessImageAttachments.mockImplementation(
      async (promptText: string) => ({
        formattedText: promptText,
        displayText: promptText,
        savedImageCount: 0,
        promptImages: [],
      }),
    );

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({
        historyBeforeRewind: [{ role: 'user', parts: [{ text: 'first' }] }],
      }),
      restoreSessionHistory: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    let conversation = {
      id: 'conversation-1',
      title: 'Conversation',
      messages: [] as Array<{
        role: 'user' | 'assistant' | 'thinking';
        content: string;
        timestamp: number;
      }>,
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationStore = {
      createConversation: vi.fn().mockResolvedValue(conversation),
      getConversation: vi.fn(async (id: string) =>
        conversation.id === id ? conversation : null,
      ),
      addMessage: vi.fn(async (id: string, message) => {
        if (conversation.id === id) {
          conversation.messages.push(message);
        }
      }),
      renameConversationId: vi.fn(async (fromId: string, toId: string) => {
        if (conversation.id !== fromId) {
          return false;
        }
        conversation = { ...conversation, id: toId };
        return true;
      }),
      replaceMessages: vi.fn().mockResolvedValue(true),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
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
      data: { text: 'first prompt' },
    });

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 0,
      },
    });

    expect(conversationStore.renameConversationId).toHaveBeenCalledWith(
      'conversation-1',
      'session-1',
    );
    expect(conversationStore.getConversation).toHaveBeenCalledWith('session-1');
    expect(conversationStore.truncateFromUserTurn).toHaveBeenCalledWith(
      'session-1',
      0,
    );
    expect(agentManager.rewindSession).toHaveBeenCalledWith(0);
    expect(sendToWebView).not.toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'Failed to capture conversation state before editing.' },
    });
  });

  it('does not switch to a colliding ACP session id when rename fails', async () => {
    mockProcessImageAttachments.mockImplementation(
      async (promptText: string) => ({
        formattedText: promptText,
        displayText: promptText,
        savedImageCount: 0,
        promptImages: [],
      }),
    );

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const conversation = {
      id: 'conversation-1',
      title: 'Conversation',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationStore = {
      createConversation: vi.fn().mockResolvedValue(conversation),
      getConversation: vi.fn().mockResolvedValue(conversation),
      addMessage: vi.fn().mockResolvedValue(undefined),
      renameConversationId: vi.fn().mockResolvedValue(false),
    };
    const sendToWebView = vi.fn();
    const handlerRef: { current: SessionMessageHandler | null } = {
      current: null,
    };
    const syncCurrentConversationId = vi.fn((id: string | null) => {
      handlerRef.current?.setCurrentConversationId(id);
    });

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      null,
      sendToWebView,
      syncCurrentConversationId,
    );
    handlerRef.current = handler;

    await handler.handle({
      type: 'sendMessage',
      data: { text: 'first prompt' },
    });

    expect(conversationStore.renameConversationId).toHaveBeenCalledWith(
      'conversation-1',
      'session-1',
    );
    expect(syncCurrentConversationId).toHaveBeenCalledWith('conversation-1');
    expect(syncCurrentConversationId).not.toHaveBeenCalledWith('session-1');
    expect(handler.getCurrentConversationId()).toBe('conversation-1');
    expect(sendToWebView).not.toHaveBeenCalledWith({
      type: 'sessionTitleUpdated',
      data: {
        sessionId: 'session-1',
        title: 'first prompt',
      },
    });
  });

  it('syncs ACP session id alignment through the owning router setter', async () => {
    mockProcessImageAttachments.mockImplementation(
      async (promptText: string) => ({
        formattedText: promptText,
        displayText: promptText,
        savedImageCount: 0,
        promptImages: [],
      }),
    );

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const conversation = {
      id: 'conversation-1',
      title: 'Conversation',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationStore = {
      createConversation: vi.fn().mockResolvedValue(conversation),
      getConversation: vi.fn().mockResolvedValue(conversation),
      addMessage: vi.fn().mockResolvedValue(undefined),
      renameConversationId: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();
    const handlerRef: { current: SessionMessageHandler | null } = {
      current: null,
    };
    const syncCurrentConversationId = vi.fn((id: string | null) => {
      handlerRef.current?.setCurrentConversationId(id);
    });

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      null,
      sendToWebView,
      syncCurrentConversationId,
    );
    handlerRef.current = handler;

    await handler.handle({
      type: 'sendMessage',
      data: { text: 'first prompt' },
    });

    expect(syncCurrentConversationId).toHaveBeenCalledWith('conversation-1');
    expect(syncCurrentConversationId).toHaveBeenCalledWith('session-1');
    expect(handler.getCurrentConversationId()).toBe('session-1');
  });

  it('rewinds the active ACP session before sending an edited message', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({
        historyBeforeRewind: [{ role: 'user', parts: [{ text: 'first' }] }],
      }),
      restoreSessionHistory: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue({
        id: 'session-1',
        title: 'Existing session',
        messages: [
          { role: 'user', content: 'first', timestamp: 1 },
          { role: 'assistant', content: 'first reply', timestamp: 2 },
          { role: 'user', content: 'second', timestamp: 3 },
        ],
        createdAt: 1,
        updatedAt: 3,
      }),
      addMessage: vi.fn(),
      replaceMessages: vi.fn().mockResolvedValue(true),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(agentManager.rewindSession).toHaveBeenCalledWith(1);
    expect(conversationStore.truncateFromUserTurn).toHaveBeenCalledWith(
      'session-1',
      1,
    );
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationRewound',
      data: { targetTurnIndex: 1 },
    });
    expect(agentManager.sendMessage).toHaveBeenCalledWith([
      { type: 'text', text: 'edited prompt' },
    ]);
    expect(
      conversationStore.truncateFromUserTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(agentManager.rewindSession.mock.invocationCallOrder[0]);
    expect(agentManager.rewindSession.mock.invocationCallOrder[0]).toBeLessThan(
      agentManager.sendMessage.mock.invocationCallOrder[0],
    );
  });

  it('restores the edited conversation snapshot when replacement send fails', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const originalConversation = {
      id: 'session-1',
      title: 'Existing session',
      messages: [
        { role: 'user' as const, content: 'first', timestamp: 1 },
        { role: 'assistant' as const, content: 'first reply', timestamp: 2 },
        { role: 'user' as const, content: 'second', timestamp: 3 },
        { role: 'assistant' as const, content: 'second reply', timestamp: 4 },
      ],
      createdAt: 1,
      updatedAt: 4,
    };
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({
        historyBeforeRewind: [{ role: 'user', parts: [{ text: 'first' }] }],
      }),
      restoreSessionHistory: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(originalConversation),
      addMessage: vi.fn(),
      replaceMessages: vi.fn().mockResolvedValue(true),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(agentManager.restoreSessionHistory).toHaveBeenCalledWith([
      { role: 'user', parts: [{ text: 'first' }] },
    ]);
    expect(conversationStore.replaceMessages).toHaveBeenCalledWith(
      'session-1',
      originalConversation.messages,
    );
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationLoaded',
      data: originalConversation,
    });
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'send failed' },
    });
  });

  it('continues edits with ACP-only rewind when no local snapshot exists', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({
        historyBeforeRewind: [{ role: 'user', parts: [{ text: 'first' }] }],
      }),
      restoreSessionHistory: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSessionMessages: vi.fn().mockResolvedValue([]),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(null),
      addMessage: vi.fn(),
      replaceMessages: vi.fn(),
      truncateFromUserTurn: vi.fn(),
      upsertConversation: vi.fn(),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(conversationStore.truncateFromUserTurn).not.toHaveBeenCalled();
    expect(agentManager.rewindSession).toHaveBeenCalledWith(1);
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationRewound',
      data: { targetTurnIndex: 1 },
    });
    expect(agentManager.sendMessage).toHaveBeenCalledWith([
      { type: 'text', text: 'edited prompt' },
    ]);
    expect(sendToWebView).not.toHaveBeenCalledWith({
      type: 'sessionTitleUpdated',
      data: {
        sessionId: 'session-1',
        title: 'edited prompt',
      },
    });
    expect(sendToWebView).not.toHaveBeenCalledWith({
      type: 'error',
      data: expect.objectContaining({
        message: 'Failed to capture conversation state before editing.',
      }),
    });
  });

  it('recovers a missing edit snapshot from persisted session messages', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const persistedMessages = [
      { role: 'user' as const, content: 'first', timestamp: 1 },
      { role: 'assistant' as const, content: 'first reply', timestamp: 2 },
      { role: 'user' as const, content: 'second', timestamp: 3 },
    ];
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({
        historyBeforeRewind: [{ role: 'user', parts: [{ text: 'first' }] }],
      }),
      restoreSessionHistory: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSessionMessages: vi.fn().mockResolvedValue(persistedMessages),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(null),
      addMessage: vi.fn(),
      replaceMessages: vi.fn(),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
      upsertConversation: vi.fn().mockResolvedValue(undefined),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(agentManager.getSessionMessages).toHaveBeenCalledWith('session-1');
    expect(conversationStore.upsertConversation).toHaveBeenCalledWith({
      id: 'session-1',
      title: 'first',
      messages: persistedMessages,
      createdAt: 1,
      updatedAt: 3,
    });
    expect(conversationStore.truncateFromUserTurn).toHaveBeenCalledWith(
      'session-1',
      1,
    );
    expect(agentManager.rewindSession).toHaveBeenCalledWith(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith([
      { type: 'text', text: 'edited prompt' },
    ]);
    expect(sendToWebView).not.toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'Failed to capture conversation state before editing.' },
    });
  });

  it('restores the edited conversation snapshot when ACP rewind fails', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const originalConversation = {
      id: 'session-1',
      title: 'Existing session',
      messages: [
        { role: 'user' as const, content: 'first', timestamp: 1 },
        { role: 'assistant' as const, content: 'first reply', timestamp: 2 },
        { role: 'user' as const, content: 'second', timestamp: 3 },
      ],
      createdAt: 1,
      updatedAt: 3,
    };
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockRejectedValue(new Error('rewind failed')),
      restoreSessionHistory: vi.fn(),
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(originalConversation),
      addMessage: vi.fn(),
      replaceMessages: vi.fn().mockResolvedValue(true),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(agentManager.restoreSessionHistory).not.toHaveBeenCalled();
    expect(conversationStore.replaceMessages).toHaveBeenCalledWith(
      'session-1',
      originalConversation.messages,
    );
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'rewind failed' },
    });
  });

  it('restores store and ACP history when saving the edited user message fails', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'edited prompt',
      displayText: 'edited prompt',
      savedImageCount: 0,
      promptImages: [],
    });

    const historyBeforeRewind = [{ role: 'user', parts: [{ text: 'first' }] }];
    const originalConversation = {
      id: 'session-1',
      title: 'Existing session',
      messages: [
        { role: 'user' as const, content: 'first', timestamp: 1 },
        { role: 'assistant' as const, content: 'first reply', timestamp: 2 },
        { role: 'user' as const, content: 'second', timestamp: 3 },
      ],
      createdAt: 1,
      updatedAt: 3,
    };
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn().mockResolvedValue({ historyBeforeRewind }),
      restoreSessionHistory: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(originalConversation),
      addMessage: vi.fn().mockRejectedValue(new Error('storage failed')),
      replaceMessages: vi.fn().mockResolvedValue(true),
      truncateFromUserTurn: vi.fn().mockResolvedValue(true),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: 1,
      },
    });

    expect(agentManager.restoreSessionHistory).toHaveBeenCalledWith(
      historyBeforeRewind,
    );
    expect(conversationStore.replaceMessages).toHaveBeenCalledWith(
      'session-1',
      originalConversation.messages,
    );
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'storage failed' },
    });
  });

  it('rejects edit submissions with invalid target turn indexes', async () => {
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      rewindSession: vi.fn(),
      restoreSessionHistory: vi.fn(),
      sendMessage: vi.fn(),
    };
    const conversationStore = {
      createConversation: vi.fn(),
      getConversation: vi.fn(),
      addMessage: vi.fn(),
      replaceMessages: vi.fn(),
      truncateFromUserTurn: vi.fn(),
    };
    const sendToWebView = vi.fn();

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'session-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        targetTurnIndex: -1,
      },
    });

    expect(agentManager.rewindSession).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(conversationStore.truncateFromUserTurn).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'Invalid message edit target.' },
    });
  });

  it('keeps currentConversationId aligned with the archived sessionId when session/load falls back to a new ACP session', async () => {
    const archivedSessionId = 'archived-session';
    const agentManager = {
      isConnected: true,
      currentSessionId: 'old-acp-session',
      getSessionList: vi
        .fn()
        .mockResolvedValue([{ id: archivedSessionId, cwd: '/workspace' }]),
      loadSessionViaAcp: vi
        .fn()
        .mockRejectedValue(new Error('session not found on server')),
      getSessionMessages: vi.fn().mockResolvedValue([]),
      createNewSession: vi.fn().mockResolvedValue('new-acp-session'),
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
      null,
      sendToWebView,
    );

    await handler.handle({
      type: 'switchQwenSession',
      data: { sessionId: archivedSessionId },
    });

    // Backend-tracked current session must match the sessionId the webview sees,
    // otherwise rename/delete/title-update flows will target the wrong session
    // during the fallback window (see PR #3093 review).
    expect(handler.getCurrentConversationId()).toBe(archivedSessionId);
    expect(agentManager.createNewSession).toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'qwenSessionSwitched',
        data: expect.objectContaining({ sessionId: archivedSessionId }),
      }),
    );
  });

  it('forces a fresh ACP session when the webview requests a new session', async () => {
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      createNewSession: vi.fn().mockResolvedValue('session-2'),
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
      'conversation-1',
      sendToWebView,
    );

    await handler.handle({
      type: 'newQwenSession',
    });

    expect(handler.getCurrentConversationId()).toBeNull();
    expect(agentManager.createNewSession).toHaveBeenCalledWith('/workspace', {
      forceNew: true,
    });
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationCleared',
      data: {},
    });
  });

  it('intercepts /export html and uses the VSCode export flow instead of sending a prompt', async () => {
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
        text: '/export html',
      },
    });

    expect(mockExportSessionToFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/workspace',
      format: 'html',
    });
    expect(conversationStore.addMessage).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'assistant',
        content:
          'Session exported to HTML: [export.html](file:///workspace/export.html)',
      }),
    });
  });

  it('prefers the active ACP session id over the local conversation id when exporting', async () => {
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
      'conv_local_123',
      sendToWebView,
    );

    await handler.handle({
      type: 'sendMessage',
      data: {
        text: '/export html',
      },
    });

    expect(mockExportSessionToFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/workspace',
      format: 'html',
    });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it('reports bare /export as a missing subcommand instead of exporting', async () => {
    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      getSessionList: vi.fn(),
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

    expect(mockExportSessionToFile).not.toHaveBeenCalled();
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: "Command '/export' requires a subcommand." },
    });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
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

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'error',
      data: { message: 'Failed to export session: disk full' },
    });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it('encodes exported file links before rendering markdown', async () => {
    mockExportSessionToFile.mockResolvedValue({
      filename: 'export (#1).html',
      uri: { fsPath: '/workspace/export (#1).html' },
    });

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
        text: '/export html',
      },
    });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'assistant',
        content:
          'Session exported to HTML: [export (#1).html](file:///workspace/export%20(%231).html)',
      }),
    });
  });

  describe('handleSetModel — discontinued model defensive validation (Issue #3745)', () => {
    it('rejects a non-runtime Qwen OAuth model and surfaces an error', async () => {
      const setModelFromUi = vi.fn();
      const agentManager = {
        isConnected: true,
        currentSessionId: 'session-1',
        setModelFromUi,
      };
      const sendToWebView = vi.fn();
      const handler = new SessionMessageHandler(
        agentManager as never,
        {} as never,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'setModel',
        data: { modelId: 'qwen3-coder-plus(qwen-oauth)' },
      });

      expect(setModelFromUi).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          'Qwen OAuth free tier was discontinued on 2026-04-15',
        ),
      );
      expect(sendToWebView).toHaveBeenCalledWith({
        type: 'error',
        data: expect.objectContaining({
          message: expect.stringContaining('discontinued'),
        }),
      });
    });

    it('allows a runtime Qwen OAuth snapshot to pass through', async () => {
      const setModelFromUi = vi.fn().mockResolvedValue(undefined);
      const agentManager = {
        isConnected: true,
        currentSessionId: 'session-1',
        setModelFromUi,
      };
      const sendToWebView = vi.fn();
      const handler = new SessionMessageHandler(
        agentManager as never,
        {} as never,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'setModel',
        data: {
          modelId: '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
        },
      });

      expect(setModelFromUi).toHaveBeenCalledWith(
        '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
      );
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });

    it('passes through other-provider models (regression — no false positives)', async () => {
      const setModelFromUi = vi.fn().mockResolvedValue(undefined);
      const agentManager = {
        isConnected: true,
        currentSessionId: 'session-1',
        setModelFromUi,
      };
      const sendToWebView = vi.fn();
      const handler = new SessionMessageHandler(
        agentManager as never,
        {} as never,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'setModel',
        data: { modelId: 'gpt-4(openai)' },
      });

      expect(setModelFromUi).toHaveBeenCalledWith('gpt-4(openai)');
      expect(mockShowErrorMessage).not.toHaveBeenCalled();
    });
  });
});
