/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopAvailableCommand,
  DesktopAskUserQuestionRequest,
  DesktopPlanEntry,
  DesktopPermissionRequest,
  DesktopServerMessage,
  DesktopToolCallUpdate,
  DesktopUsageStats,
} from '../../shared/desktopProtocol.js';

type ChatConnectionState = 'idle' | 'connecting' | 'connected' | 'closed';

export type ChatTimelineItem =
  | {
      id: string;
      type: 'message';
      role: 'assistant' | 'thinking' | 'user';
      text: string;
      streaming: boolean;
      timestamp: number;
    }
  | {
      id: string;
      type: 'tool';
      toolCall: DesktopToolCallUpdate;
      timestamp: number;
    }
  | {
      id: string;
      type: 'plan';
      entries: DesktopPlanEntry[];
      timestamp: number;
    }
  | {
      id: string;
      type: 'event';
      label: string;
      timestamp: number;
    };

export interface ChatState {
  connection: ChatConnectionState;
  streaming: boolean;
  items: ChatTimelineItem[];
  latestUsage: DesktopUsageStats | null;
  availableCommands: DesktopAvailableCommand[];
  availableSkills: string[];
  pendingPermission: {
    requestId: string;
    request: DesktopPermissionRequest;
  } | null;
  pendingAskUserQuestion: {
    requestId: string;
    request: DesktopAskUserQuestionRequest;
  } | null;
  mode: string | null;
  currentModelId: string | null;
  error: string | null;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'history_loaded' }
  | { type: 'append_user_message'; content: string }
  | { type: 'clear_permission_request'; requestId: string }
  | { type: 'clear_ask_user_question'; requestId: string }
  | { type: 'server_message'; message: DesktopServerMessage };

export function createInitialChatState(): ChatState {
  return {
    connection: 'idle',
    streaming: false,
    items: [],
    latestUsage: null,
    availableCommands: [],
    availableSkills: [],
    pendingPermission: null,
    pendingAskUserQuestion: null,
    mode: null,
    currentModelId: null,
    error: null,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return createInitialChatState();

    case 'connect':
      return {
        ...state,
        connection: 'connecting',
        error: null,
      };

    case 'disconnect':
      return {
        ...state,
        connection: 'closed',
        streaming: false,
      };

    case 'history_loaded':
      return {
        ...state,
        streaming: false,
        items: markStreamingMessagesComplete(state.items),
      };

    case 'append_user_message':
      return {
        ...state,
        streaming: true,
        error: null,
        items: [
          ...state.items,
          createMessageItem('user', action.content, false),
        ],
      };

    case 'clear_permission_request':
      return state.pendingPermission?.requestId === action.requestId
        ? { ...state, pendingPermission: null }
        : state;

    case 'clear_ask_user_question':
      return state.pendingAskUserQuestion?.requestId === action.requestId
        ? { ...state, pendingAskUserQuestion: null }
        : state;

    case 'server_message':
      return applyServerMessage(state, action.message);

    default:
      return state;
  }
}

function applyServerMessage(
  state: ChatState,
  message: DesktopServerMessage,
): ChatState {
  switch (message.type) {
    case 'connected':
      return {
        ...state,
        connection: 'connected',
        error: null,
      };

    case 'pong':
      return state;

    case 'message_delta':
      return {
        ...state,
        streaming: true,
        items: appendMessageDelta(state.items, message.role, message.text),
      };

    case 'tool_call':
      return {
        ...state,
        items: upsertToolCall(state.items, message.data),
      };

    case 'plan':
      return {
        ...state,
        items: upsertPlan(state.items, message.entries),
      };

    case 'usage':
      return {
        ...state,
        latestUsage: message.data,
      };

    case 'mode_changed':
      return {
        ...state,
        mode: message.mode,
      };

    case 'model_changed':
      return {
        ...state,
        currentModelId: message.modelId,
      };

    case 'available_commands':
      return {
        ...state,
        availableCommands: message.commands,
        availableSkills: message.skills,
      };

    case 'permission_request':
      return {
        ...state,
        pendingPermission: {
          requestId: message.requestId,
          request: message.request,
        },
      };

    case 'ask_user_question':
      return {
        ...state,
        pendingAskUserQuestion: {
          requestId: message.requestId,
          request: message.request,
        },
      };

    case 'message_complete':
      return {
        ...state,
        streaming: false,
        items: markStreamingMessagesComplete(state.items),
      };

    case 'error':
      return {
        ...state,
        streaming: false,
        error: message.message,
        items: [...state.items, createEventItem(message.message)],
      };

    default:
      return state;
  }
}

function appendMessageDelta(
  items: ChatTimelineItem[],
  role: 'assistant' | 'thinking' | 'user',
  text: string,
): ChatTimelineItem[] {
  const lastItem = items[items.length - 1];
  if (
    lastItem?.type === 'message' &&
    lastItem.role === role &&
    lastItem.streaming
  ) {
    return [
      ...items.slice(0, -1),
      {
        ...lastItem,
        text: `${lastItem.text}${text}`,
      },
    ];
  }

  return [...items, createMessageItem(role, text, true)];
}

function upsertToolCall(
  items: ChatTimelineItem[],
  update: DesktopToolCallUpdate,
): ChatTimelineItem[] {
  const index = items.findIndex(
    (item) =>
      item.type === 'tool' && item.toolCall.toolCallId === update.toolCallId,
  );
  if (index === -1) {
    return [...items, createToolItem(update)];
  }

  return items.map((item, itemIndex) => {
    if (itemIndex !== index || item.type !== 'tool') {
      return item;
    }

    return {
      ...item,
      toolCall: {
        ...item.toolCall,
        ...update,
      },
    };
  });
}

function upsertPlan(
  items: ChatTimelineItem[],
  entries: DesktopPlanEntry[],
): ChatTimelineItem[] {
  const index = items.findIndex((item) => item.type === 'plan');
  if (index === -1) {
    return [...items, createPlanItem(entries)];
  }

  return items.map((item, itemIndex) =>
    itemIndex === index && item.type === 'plan'
      ? { ...item, entries, timestamp: Date.now() }
      : item,
  );
}

function markStreamingMessagesComplete(
  items: ChatTimelineItem[],
): ChatTimelineItem[] {
  return items.map((item) =>
    item.type === 'message' ? { ...item, streaming: false } : item,
  );
}

function createMessageItem(
  role: 'assistant' | 'thinking' | 'user',
  text: string,
  streaming: boolean,
): ChatTimelineItem {
  return {
    id: `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'message',
    role,
    text,
    streaming,
    timestamp: Date.now(),
  };
}

function createToolItem(toolCall: DesktopToolCallUpdate): ChatTimelineItem {
  return {
    id: `tool-${toolCall.toolCallId}`,
    type: 'tool',
    toolCall,
    timestamp: toolCall.timestamp ?? Date.now(),
  };
}

function createPlanItem(entries: DesktopPlanEntry[]): ChatTimelineItem {
  return {
    id: 'plan-current',
    type: 'plan',
    entries,
    timestamp: Date.now(),
  };
}

function createEventItem(label: string): ChatTimelineItem {
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'event',
    label,
    timestamp: Date.now(),
  };
}
