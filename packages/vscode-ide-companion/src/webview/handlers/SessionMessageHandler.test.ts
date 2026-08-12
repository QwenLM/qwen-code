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

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    pathToFileURL: (filePath: string) => {
      if (process.platform !== 'win32' && /^[a-zA-Z]:\\/.test(filePath)) {
        return actual.pathToFileURL(filePath, { windows: true });
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
      formattedText: 'иї™жЇд»Ђд№€е†…е®№\n\n@/tmp/clipboard/clipboard-123.png',
      displayText: 'иї™жЇд»Ђд№€е†…е®№\n\n@/tmp/clipboard/clipboard-123.png',
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
        text: 'иї™жЇд»Ђд№€е†…е®№',
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
        text: 'иї™жЇд»Ђд№€е†…е®№\n\n@/tmp/clipboard/clipboard-123.png',
      },
      {
        type: 'resource_link',
        name: 'clipboard-123.png',
        mimeType: 'image/png',
        uri: pathToFileURL('/tmp/clipboard/clipboard-123.png').href,
      },
    ]);
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
      rewindSessionЯќx¶‰ћЛkєwµзH[ШЪФ›ШЩ\ЬТ[XYЩP]XЪY[ќЛ›[ШЪФ™\ЫЫ™Y[YJВ€›Ь›X]Y^€	ЩY]Y›Ы\	Л€\Ь^U^€	ЩY]Y›Ы\	Л€Ш]™Y[XYЩPЫЭ[ќ€€›Ы\[XYЩ\О€ЧK€JNВ‚€ЫЫњЭ\ЭЬћP™Y›Ь™T™]Ъ[™HЮИ›ЫN€	Э\Щ\‰Л\ќО€ЮИ^€	Щљ\њЭ	ИWHWNВ€ЫЫњЭЬљYЪ[[ЫЫќ™\њШ][Ы€HВ€Y€	ЬЩ\ЬЪ[Ы‹LIЛ€]N€	С^\Э[™ИЩ\ЬЪ[Ы‰Л€Y\ЬШYЩ\О€В€И›ЫN€	Э\Щ\‰И\ИЫЫњЭЫЫќ[ќ€	Щљ\њЭ	Л[Y\Э[\€HK€И›ЫN€	Ш\ЬЪ\Э[ќ	И\ИЫЫњЭЫЫќ[ќ€	Щљ\њЭ™\IЛ[Y\Э[\€€K€И›ЫN€	Э\Щ\‰И\ИЫЫњЭЫЫќ[ќ€	ЬЩXЫЫ™	Л[Y\Э[\€ИK€K€Ь™X]Y]€K€\]Y]€Л€NВ€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€™]Ъ[™Щ\ЬЪ[ЫЋ€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJИ\ЭЬћP™Y›Ь™T™]Ъ[™JK€™\ЭЬ™TЩ\ЬЪ[Ы’\ЭЬћN€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJ[™Yљ[™Y
K€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJЬљYЪ[[ЫЫќ™\њШ][ЫЉK€YY\ЬШYЩN€љK™›Љ
K›[ШЪФ™Z™XЭY[YJ™]И\њ›ЬЉ	ЬЭЬYЩHZ[Y	КJK€™\XЩSY\ЬШYЩ\О€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJќYJK€ќ[Ш]Qњ›ЫU\Щ\•\›Ћ€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJќYJK€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЩY]Y\ЬШYЩIЛ€]N€В€^€	ЩY]Y›Ы\	Л€\™Щ]\›’[™^€K€K€JNВ‚€^XЭ
YЩ[ќX[YЩ\‹њ™\ЭЬ™TЩ\ЬЪ[Ы’\ЭЬћJKќТ]™P™Y[ђШ[YЪ]
€\ЭЬћP™Y›Ь™T™]Ъ[™€
NВ€^XЭ
ЫЫќ™\њШ][Ы”ЭЬ™Kњ™\XЩSY\ЬШYЩ\КKќТ]™P™Y[ђШ[YЪ]
€	ЬЩ\ЬЪ[Ы‹LIЛ€ЬљYЪ[[ЫЫќ™\њШ][Ы‹›Y\ЬШYЩ\Л€
NВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	Щ\њ›Ь‰Л€]N€ИY\ЬШYЩN€	ЬЭЬYЩHZ[Y	ИK€JNВ€JNВ‚€]
	Ь™Z™XЭИY]ЭX›Z\ЬЪ[ЫњИЪ][ќ[Y\™Щ]\›€[™^\ЙЛ\Ю[И

HO€В€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€™]Ъ[™Щ\ЬЪ[ЫЋ€љK™›Љ
K€™\ЭЬ™TЩ\ЬЪ[Ы’\ЭЬћN€љK™›Љ
K€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€™\XЩSY\ЬШYЩ\О€љK™›Љ
K€ќ[Ш]Qњ›ЫU\Щ\•\›Ћ€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЩY]Y\ЬШYЩIЛ€]N€В€^€	ЩY]Y›Ы\	Л€\™Щ]\›’[™^€LK€K€JNВ‚€^XЭ
YЩ[ќX[YЩ\‹њ™]Ъ[™Щ\ЬЪ[ЫЉK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
ЫЫќ™\њШ][Ы”ЭЬ™Kќќ[Ш]Qњ›ЫU\Щ\•\›ЉK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	Щ\њ›Ь‰Л€]N€ИY\ЬШYЩN€	Т[ќ[YY\ЬШYЩHY]\™Щ]‰ИK€JNВ€JNВ‚€]
	ЪЩY\ИЭ\њ™[ќЫЫќ™\њШ][Ы’Y[YЫ™YЪ]H\Ъ]™YЩ\ЬЪ[Ы’YЪ[€Щ\ЬЪ[Ы‹ЫШY[ИXЪИИH™]ИPФЩ\ЬЪ[Ы‰Л\Ю[И

HO€В€ЫЫњЭ\Ъ]™YЩ\ЬЪ[Ы’YH	Ш\Ъ]™Y\Щ\ЬЪ[Ы‰ОВ€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЫЫXXЬ\Щ\ЬЪ[Ы‰Л€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИY€\Ъ]™YЩ\ЬЪ[Ы’YЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€ШYЩ\ЬЪ[Ы•љXPXЬ€љB€™›Љ
B€›[ШЪФ™Z™XЭY[YJ™]И\њ›ЬЉ	ЬЩ\ЬЪ[Ы€›Э›Э[™Ы€Щ\ќ™\‰КJK€Щ]Щ\ЬЪ[Ы“Y\ЬШYЩ\О€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJЧJK€Ь™X]S™]ФЩ\ЬЪ[ЫЋ€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJ	Ы™]ЛXXЬ\Щ\ЬЪ[Ы‰КK€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€ќ[€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЭЪ]Ъ]Щ[”Щ\ЬЪ[Ы‰Л€]N€ИЩ\ЬЪ[Ы’Y€\Ъ]™YЩ\ЬЪ[Ы’YK€JNВ‚€ЛИXЪЩ[™]XЪЩYЭ\њ™[ќЩ\ЬЪ[Ы€]\ЭX]ЪHЩ\ЬЪ[Ы’YHЩXќљY]ИЩY\Л€ЛИЭ\ќЪ\ЩH™[[YKЩ[]KЭ]K]\]H›ЭЬИЪ[\™Щ]HЬ›Ы™ИЩ\ЬЪ[Ы‚€ЛИ\љ[™ИH[XЪИЪ[™ЭИ
ЩYH€ММLИ™]љY]КK‚€^XЭ
[™\‹™Щ]Э\њ™[ќЫЫќ™\њШ][Ы’Y

JKќР™J\Ъ]™YЩ\ЬЪ[Ы’Y
NВ€^XЭ
YЩ[ќX[YЩ\‹Ь™X]S™]ФЩ\ЬЪ[ЫЉKќТ]™P™Y[ђШ[Y

NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
€^XЭ›Шљ™XЭЫЫќZ[љ[™КВ€\N€	Ь]Щ[”Щ\ЬЪ[Ы”ЭЪ]ЪY	Л€]N€^XЭ›Шљ™XЭЫЫќZ[љ[™КИЩ\ЬЪ[Ы’Y€\Ъ]™YЩ\ЬЪ[Ы’YJK€JK€
NВ€JNВ‚€]
	Щ›ЬЩ\ИHњ™\ЪPФЩ\ЬЪ[Ы€Ъ[€HЩXќљY]И™\]Y\ЭИH™]ИЩ\ЬЪ[Ы‰Л\Ю[И

HO€В€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Ь™X]S™]ФЩ\ЬЪ[ЫЋ€љK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJ	ЬЩ\ЬЪ[Ы‹L‰КK€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ШЫЫќ™\њШ][Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	Ы™]Ф]Щ[”Щ\ЬЪ[Ы‰Л€JNВ‚€^XЭ
[™\‹™Щ]Э\њ™[ќЫЫќ™\њШ][Ы’Y

JKќР™Sќ[

NВ€^XЭ
YЩ[ќX[YЩ\‹Ь™X]S™]ФЩ\ЬЪ[ЫЉKќТ]™P™Y[ђШ[YЪ]
	ЛЭЫЬљЬЬXЩIЛВ€›ЬЩS™]О€ќYK€JNВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	ШЫЫќ™\њШ][ЫђЫX\™Y	Л€]N€ЯK€JNВ€JNВ‚€]
	Ъ[ќ\Щ\ИЩ^Ьќ[[™\Щ\ИH”РЫЩH^Ьќ›ЭИ[њЭXYЩ€Щ[™[™ИH›Ы\	Л\Ю[И

HO€В€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^Ьќ[	Л€K€JNВ‚€^XЭ
[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[JKќТ]™P™Y[ђШ[YЪ]
В€Щ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€ЭЩ€	ЛЭЫЬљЬЬXЩIЛ€›Ь›X]€	Ъ[	Л€JNВ€^XЭ
ЫЫќ™\њШ][Ы”ЭЬ™KYY\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	ЫY\ЬШYЩIЛ€]N€^XЭ›Шљ™XЭЫЫќZ[љ[™КВ€›ЫN€	Ш\ЬЪ\Э[ќ	Л€ЫЫќ[ќ‚€	ФЩ\ЬЪ[Ы€^ЬќYИS€Щ^Ьќљ[Jљ[N‹ЛЛЭЫЬљЬЬXЩKЩ^Ьќљ[
IЛ€JK€JNВ€JNВ‚€]
	Ь™Y™\њИHXЭ]™HPФЩ\ЬЪ[Ы€YЭ™\€HШШ[ЫЫќ™\њШ][Ы€YЪ[€^Ьќ[™ЙЛ\Ю[И

HO€В€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ШЫЫќ—ЫШШ[МLЊЙЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^Ьќ[	Л€K€JNВ‚€^XЭ
[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[JKќТ]™P™Y[ђШ[YЪ]
В€Щ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€ЭЩ€	ЛЭЫЬљЬЬXЩIЛ€›Ь›X]€	Ъ[	Л€JNВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€JNВ‚€]
	Ь™\ЬќИ\™HЩ^Ьќ\ИHZ\ЬЪ[™ИЭXЫЫ[X[™[њЭXYЩ€^Ьќ[™ЙЛ\Ю[И

HO€В€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љK™›Љ
K€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^Ьќ	Л€K€JNВ‚€^XЭ
[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[JK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	Щ\њ›Ь‰Л€]N€ИY\ЬШYЩN€ђЫЫ[X[™	ЛЩ^Ьќ	И™\]Z\™\ИHЭXЫЫ[X[™€€K€JNВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€JNВ‚€]
	Ь™\ЬќИ^ЬќZ[\™\ИXЪИИH\Щ\‰Л\Ю[И

HO€В€[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[K›[ШЪФ™Z™XЭY[YJ™]И\њ›ЬЉ	Щ\ЪИќ[	КJNВ‚€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^ЬќY	Л€K€JNВ‚€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	Щ\њ›Ь‰Л€]N€ИY\ЬШYЩN€	СZ[YИ^ЬќЩ\ЬЪ[ЫЋ€\ЪИќ[	ИK€JNВ€^XЭ
YЩ[ќX[YЩ\‹њЩ[™Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€JNВ‚€]
	Щ[ЫЩ\И^ЬќYљ[H[љЬИ™Y›Ь™H™[™\љ[™ИX\љЩЭЫ‰Л\Ю[И

HO€В€[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[K›[ШЪФ™\ЫЫ™Y[YJВ€љ[[[YN€	Щ^ЬќJKљ[	Л€\љN€ИњФ]€	ЛЭЫЬљЬЬXЩKЩ^ЬќJKљ[	ИK€JNВ‚€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^Ьќ[	Л€K€JNВ‚€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	ЫY\ЬШYЩIЛ€]N€^XЭ›Шљ™XЭЫЫќZ[љ[™КВ€›ЫN€	Ш\ЬЪ\Э[ќ	Л€ЫЫќ[ќ‚€	ФЩ\ЬЪ[Ы€^ЬќYИS€Щ^ЬќJKљ[Jљ[N‹ЛЛЭЫЬљЬЬXЩKЩ^Ьќ	LЊILЋKљ[
IЛ€JK€JNВ€JNВ‚€\ШЬљX™J	Ъ[™TЩ][Щ[8 %\ШЫЫќ[ќYY[Щ[Y™[њЪ]™H[Y][Ы€
\ЬЭYHМННJIЛ

HO€В€]
	Ь™Z™XЭИH›Ы‹\ќ[ќ[YH]Щ[€Р]][Щ[[™Э\™XЩ\И[€\њ›Ь‰Л\Ю[И

HO€В€ЫЫњЭЩ][Щ[њ›ЫUZHHљK™›Љ
NВ€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ][Щ[њ›ЫUZK€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЯH\И™]™\‹€ќ[€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ][Щ[	Л€]N€И[Щ[Y€	Ь]Щ[ЊЛXЫЩ\‹\\К]Щ[‹[Ш]]
IИK€JNВ‚€^XЭ
Щ][Щ[њ›ЫUZJK››ЭќТ]™P™Y[ђШ[Y

NВ€^XЭ
[ШЪФЪЭС\њ›Ь“Y\ЬШYЩJKќТ]™P™Y[ђШ[YЪ]
€^XЭњЭљ[™РЫЫќZ[љ[™К€	Ф]Щ[€Р]]њ™YHY\€Ш\И\ШЫЫќ[ќYYЫ€ЊЌ‹LLMIЛ€
K€
NВ€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	Щ\њ›Ь‰Л€]N€^XЭ›Шљ™XЭЫЫќZ[љ[™КВ€Y\ЬШYЩN€^XЭњЭљ[™РЫЫќZ[љ[™К	Щ\ШЫЫќ[ќYY	КK€JK€JNВ€JNВ‚€]
	Ш[ЭЬИHќ[ќ[YH]Щ[€Р]]Ы\ЪЭИ\ЬИ›ЭYЪ	Л\Ю[И

HO€В€ЫЫњЭЩ][Щ[њ›ЫUZHHљK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJ[™Yљ[™Y
NВ€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ][Щ[њ›ЫUZK€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЯH\И™]™\‹€ќ[€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ][Щ[	Л€]N€В€[Щ[Y€	Йќ[ќ[Y_]Щ[‹[Ш]]]Щ[ЊЛXЫЩ\‹\\К]Щ[‹[Ш]]
IЛ€K€JNВ‚€^XЭ
Щ][Щ[њ›ЫUZJKќТ]™P™Y[ђШ[YЪ]
€	Йќ[ќ[Y_]Щ[‹[Ш]]]Щ[ЊЛXЫЩ\‹\\К]Щ[‹[Ш]]
IЛ€
NВ€^XЭ
[ШЪФЪЭС\њ›Ь“Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€JNВ‚€]
	Ь\ЬЩ\И›ЭYЪЭ\‹\›ЭљY\€[Щ[И
™YЬ™\ЬЪ[Ы€8 %›И[ЩHЬЪ]]™\КIЛ\Ю[И

HO€В€ЫЫњЭЩ][Щ[њ›ЫUZHHљK™›Љ
K›[ШЪФ™\ЫЫ™Y[YJ[™Yљ[™Y
NВ€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ][Щ[њ›ЫUZK€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЯH\И™]™\‹€ќ[€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ][Щ[	Л€]N€И[Щ[Y€	ЩЬM
Ь[ZJIИK€JNВ‚€^XЭ
Щ][Щ[њ›ЫUZJKќТ]™P™Y[ђШ[YЪ]
	ЩЬM
Ь[ZJIКNВ€^XЭ
[ШЪФЪЭС\њ›Ь“Y\ЬШYЩJK››ЭќТ]™P™Y[ђШ[Y

NВ€JNВ€JNВ€]
	Ь™\Щ\ќ™\ИHљ]™K[]\€ЫЫЫ€[€Ъ[™ЭЬИ^ЬќYљ[H[љЬЙЛ\Ю[И

HO€В€[ШЪС^ЬќЩ\ЬЪ[Ы•Сљ[K›[ШЪФ™\ЫЫ™Y[YJВ€љ[[[YN€	Щљ[K›Y	Л€\љN€ИњФ]€	С—\ZШXЪWљ[K›Y	ИK€JNВ‚€ЫЫњЭYЩ[ќX[YЩ\€HВ€\РЫЫ›™XЭY€ќYK€Э\њ™[ќЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ]Щ\ЬЪ[Ы“\Э€љB€™›Љ
B€›[ШЪФ™\ЫЫ™Y[YJЮИЩ\ЬЪ[Ы’Y€	ЬЩ\ЬЪ[Ы‹LIЛЭЩ€	ЛЭЫЬљЬЬXЩIИWJK€Щ[™Y\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЫЫќ™\њШ][Ы”ЭЬ™HHВ€Ь™X]PЫЫќ™\њШ][ЫЋ€љK™›Љ
K€Щ]ЫЫќ™\њШ][ЫЋ€љK™›Љ
K€YY\ЬШYЩN€љK™›Љ
K€NВ€ЫЫњЭЩ[™ХЩX•љY]ИHљK™›Љ
NВ‚€ЫЫњЭ[™\€H™]ИЩ\ЬЪ[Ы“Y\ЬШYЩR[™\Љ€YЩ[ќX[YЩ\€\И™]™\‹€ЫЫќ™\њШ][Ы”ЭЬ™H\И™]™\‹€	ЬЩ\ЬЪ[Ы‹LIЛ€Щ[™ХЩX•љY]Л€
NВ‚€]ШZ][™\‹љ[™JВ€\N€	ЬЩ[™Y\ЬШYЩIЛ€]N€В€^€	ЛЩ^ЬќY	Л€K€JNВ‚€^XЭ
Щ[™ХЩX•љY]КKќТ]™P™Y[ђШ[YЪ]
В€\N€	ЫY\ЬШYЩIЛ€]N€^XЭ›Шљ™XЭЫЫќZ[љ[™КВ€›ЫN€	Ш\ЬЪ\Э[ќ	Л€ЫЫќ[ќ‚€	ФЩ\ЬЪ[Ы€^ЬќYИQ€Щљ[K›YJљ[N‹ЛЛС‹Ш\ZШXЪKЩљ[K›Y
IЛ€JK€JNВ€JNВџJNВ