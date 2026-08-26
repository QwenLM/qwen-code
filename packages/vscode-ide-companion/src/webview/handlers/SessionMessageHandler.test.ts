/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';

const {
  mockProcessImageAttachments,
  mockShowErrorMessage,
  mockExportSessionToFile,
  mockReadFile,
  mockStat,
} = vi.hoisted(() => ({
  mockProcessImageAttachments: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockExportSessionToFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));
const { mockExecuteCommand } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  stat: mockStat,
  default: { readFile: mockReadFile, stat: mockStat },
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

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    pathToFileURL: (filePath: string) => {
      if (process.platform !== 'win32' && /^[a-zA-Z]:\\/.test(filePath)) {
        return actual.pathToFileURL(filePath, { windows: true });
      }
      // The mirror case: fixtures spell workspace paths POSIX-style, and on
      // win32 the real pathToFileURL would drive-qualify them against the
      // process cwd (file:///C:/workspace/…). Parse them as POSIX so the
      // expected URLs read the same on every host.
      if (process.platform === 'win32' && filePath.startsWith('/')) {
        return actual.pathToFileURL(filePath, { windows: false });
      }
      return actual.pathToFileURL(filePath);
    },
  };
});

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
import { MAX_IMAGE_SIZE } from '../../utils/imageSupport.js';

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
    mockStat.mockResolvedValue({ size: 3 });
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
    mockReadFile.mockResolvedValue(Buffer.from('abc'));

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
        uri: pathToFileURL('/tmp/clipboard/clipboard-123.png').href,
      },
    ]);
  });

  it('echoes the user prompt into the ACP transcript as a user_message_chunk', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'hello transcript',
      displayText: 'hello transcript',
      savedImageCount: 0,
      promptImages: [],
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
      data: { text: 'hello transcript' },
    });

    // The direct stdio ACP channel never emits user_message_chunk for an
    // interactive prompt; the handler must synthesize it so the user's own
    // turn renders in the WebShell transcript timeline.
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'transcriptUpdate',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello transcript' },
        },
      },
    });
    // The echo must be posted before the prompt is dispatched so the user
    // block renders ahead of this turn's assistant frames.
    const echoCallIndex = sendToWebView.mock.calls.findIndex(
      (call) =>
        (call[0] as { type?: string } | undefined)?.type === 'transcriptUpdate',
    );
    expect(echoCallIndex).toBeGreaterThanOrEqual(0);
    expect(sendToWebView.mock.invocationCallOrder[echoCallIndex]).toBeLessThan(
      agentManager.sendMessage.mock.invocationCallOrder[0],
    );
  });

  it('echoes attached prompt images into the transcript as inline image chunks', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'look at this\n\n@/tmp/clipboard/clipboard-1.png',
      displayText: 'look at this\n\n@/tmp/clipboard/clipboard-1.png',
      savedImageCount: 1,
      promptImages: [
        {
          path: '/tmp/clipboard/clipboard-1.png',
          name: 'pasted_image.png',
          mimeType: 'image/png',
        },
      ],
    });
    mockReadFile.mockResolvedValue(Buffer.from([1, 2, 3]));

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
        text: 'look at this',
        attachments: [
          {
            id: 'img-1',
            name: 'pasted_image.png',
            type: 'image/png',
            size: 3,
            data: 'data:image/png;base64,AQID',
            timestamp: Date.now(),
          },
        ],
      },
    });

    // The prompt itself still carries the image as a resource_link block,
    // but the transcript echo must carry inline data the reducer can render.
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/clipboard/clipboard-1.png');
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'transcriptUpdate',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'look at this' },
        },
      },
    });
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'transcriptUpdate',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            data: Buffer.from([1, 2, 3]).toString('base64'),
            mimeType: 'image/png',
          },
        },
      },
    });
    // Image echoes land before the prompt is dispatched, mirroring the text
    // echo, so the user turn renders complete ahead of assistant frames.
    const imageEchoCallIndex = sendToWebView.mock.calls.findIndex(
      (call) =>
        (
          (call[0] as { type?: string; data?: unknown } | undefined)?.data as
            | { update?: { content?: { type?: string } } }
            | undefined
        )?.update?.content?.type === 'image',
    );
    expect(imageEchoCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      sendToWebView.mock.invocationCallOrder[imageEchoCallIndex],
    ).toBeLessThan(agentManager.sendMessage.mock.invocationCallOrder[0]);
  });

  it('keeps the send flowing when a prompt image cannot be read back for the echo', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'look at this\n\n@/tmp/clipboard/clipboard-1.png',
      displayText: 'look at this\n\n@/tmp/clipboard/clipboard-1.png',
      savedImageCount: 1,
      promptImages: [
        {
          path: '/tmp/clipboard/clipboard-1.png',
          name: 'pasted_image.png',
          mimeType: 'image/png',
        },
      ],
    });
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {}));

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
      data: { text: 'look at this' },
    });

    // The unreadable image is skipped (no image chunk) but the text echo and
    // the prompt itself still go through.
    const imageEchoCallIndex = sendToWebView.mock.calls.findIndex(
      (call) =>
        (
          (call[0] as { type?: string; data?: unknown } | undefined)?.data as
            | { update?: { content?: { type?: string } } }
            | undefined
        )?.update?.content?.type === 'image',
    );
    expect(imageEchoCallIndex).toBe(-1);
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'transcriptUpdate',
      data: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: 'look at this',
          },
        },
      },
    });
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('skips oversized context images without reading them into memory', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'inspect image',
      displayText: 'inspect image',
      savedImageCount: 0,
      promptImages: [
        {
          path: '/workspace/huge.tiff',
          name: 'huge.tiff',
          mimeType: 'image/tiff',
        },
      ],
    });
    mockStat.mockResolvedValue({ size: MAX_IMAGE_SIZE + 1 });

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
      data: { text: 'inspect image' },
    });

    expect(mockStat).toHaveBeenCalledWith('/workspace/huge.tiff');
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(sendToWebView).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'transcriptUpdate',
        data: expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({ type: 'image' }),
          }),
        }),
      }),
    );
  });

  it('sends image file context as prompt image blocks', async () => {
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
    const conversationStore = {
      createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
      getConversation: vi.fn().mockResolvedValue(null),
      addMessage: vi.fn(),
      renameConversationId: vi.fn().mockResolvedValue(true),
    };

    const handler = new SessionMessageHandler(
      agentManager as never,
      conversationStore as never,
      'conversation-1',
      vi.fn(),
    );

    await handler.handle({
      type: 'sendMessage',
      data: {
        text: 'describe it',
        context: [
          {
            type: 'file',
            name: 'screen shot.png',
            value: '/workspace/screen shot.png',
            isImage: true,
          },
          {
            type: 'file',
            name: 'notes.md',
            value: '/workspace/notes.md',
            isImage: false,
          },
        ],
      },
    });

    expect(agentManager.sendMessage).toHaveBeenCalledWith([
      {
        type: 'text',
        text: '/workspace/screen shot.png\n/workspace/notes.md\n\ndescribe it',
      },
      {
        type: 'resource_link',
        name: 'screen shot.png',
        mimeType: 'image/png',
        uri: pathToFileURL('/workspace/screen shot.png').href,
      },
    ]);
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

  it('publishes the fresh ACP session id as liveSessionId in the load-failure fallback boundary', async () => {
    const archivedSessionId = 'archived-session';
    const agentManager: {
      isConnected: boolean;
      currentSessionId: string | null;
      getSessionList: ReturnType<typeof vi.fn>;
      loadSessionViaAcp: ReturnType<typeof vi.fn>;
      getSessionMessages: ReturnType<typeof vi.fn>;
      createNewSession: ReturnType<typeof vi.fn>;
    } = {
      isConnected: true,
      currentSessionId: 'old-acp-session',
      getSessionList: vi
        .fn()
        .mockResolvedValue([{ id: archivedSessionId, cwd: '/workspace' }]),
      loadSessionViaAcp: vi
        .fn()
        .mockRejectedValue(new Error('session not found on server')),
      getSessionMessages: vi.fn().mockResolvedValue([]),
      createNewSession: vi.fn(),
    };
    // Mirror the real manager: session/new flips currentSessionId to the
    // freshly created ACP session.
    agentManager.createNewSession.mockImplementation(async () => {
      agentManager.currentSessionId = 'new-acp-session';
      return 'new-acp-session';
    });
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

    // The transcript filter must learn the live session id from the
    // boundary; otherwise every live frame of the fresh session is
    // dropped because it does not carry the archived id.
    expect(sendToWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'qwenSessionSwitched',
        data: expect.objectContaining({
          sessionId: archivedSessionId,
          liveSessionId: 'new-acp-session',
        }),
      }),
    );
  });

  it('forces a fresh ACP session when the webview requests a new session', async () => {
    let liveSessionId: string | null = 'session-1';
    const agentManager = {
      isConnected: true,
      get currentSessionId() {
        return liveSessionId;
      },
      createNewSession: vi.fn().mockImplementation(async () => {
        liveSessionId = 'session-2';
        return 'session-2';
      }),
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
    // The boundary publishes the fresh session id so the transcript guard
    // drops trailing frames from the abandoned session instead of
    // adopting them into the new conversation.
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationCleared',
      data: { sessionId: 'session-2' },
    });
  });

  it('publishes the live session id on the first-send conversationLoaded boundary', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'hello',
      displayText: 'hello',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const conversationStore = {
      createConversation: vi
        .fn()
        .mockResolvedValue({ id: 'conversation-1', messages: [] }),
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
      data: { text: 'hello' },
    });

    // The boundary re-pins the transcript guard; without the session id
    // the adopt-on-null window reopens for stale frames on every first
    // send of a fresh conversation.
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'conversationLoaded',
      data: expect.objectContaining({
        id: 'conversation-1',
        sessionId: 'session-1',
      }),
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
        // The confirmation never flows through ACP transcriptUpdate; without
        // localOnly the WebShell transcript renders it nowhere.
        localOnly: true,
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

  it('tags the timeout message localOnly so the notice slot renders it', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'hello',
      displayText: 'hello',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: 'session-1',
      sendMessage: vi.fn().mockRejectedValue(new Error('Request timeout')),
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
      data: { text: 'hello' },
    });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'assistant',
        content:
          'Request timed out. This may be due to a network issue. Please try again.',
        localOnly: true,
      }),
    });
  });

  it('re-surfaces the user message as a local notice when the agent is not connected', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'hello',
      displayText: 'hello',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: false,
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
      data: { text: 'hello' },
    });

    // The eager echo stays untagged (the transcript renders it on
    // successful sends); the aborted send re-posts a tagged copy so the
    // user's own message is visible in the notice slot.
    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'user',
        content: 'hello',
        localOnly: true,
      }),
    });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it('re-surfaces the user message as a local notice when session creation fails', async () => {
    mockProcessImageAttachments.mockResolvedValue({
      formattedText: 'hello',
      displayText: 'hello',
      savedImageCount: 0,
      promptImages: [],
    });

    const agentManager = {
      isConnected: true,
      currentSessionId: null,
      createNewSession: vi.fn().mockRejectedValue(new Error('spawn failed')),
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
      data: { text: 'hello' },
    });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'user',
        content: 'hello',
        localOnly: true,
      }),
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
          'Session exported to HTML: [export (#1).html](file:///workspace/export%20%28%231%29.html)',
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
  it('preserves the drive-letter colon in Windows exported file links', async () => {
    mockExportSessionToFile.mockResolvedValue({
      filename: 'file.md',
      uri: { fsPath: 'D:\\aplikacja\\file.md' },
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
        text: '/export md',
      },
    });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'message',
      data: expect.objectContaining({
        role: 'assistant',
        content:
          'Session exported to MD: [file.md](file:///D:/aplikacja/file.md)',
      }),
    });
  });
});
