/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cloneUsage } from '../../provider/empty-usage.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isTranscriptMessage } from '../entry.js';
import type {
  ActiveLeafEntry,
  AiTitleEntry,
  ContentReplacementEntry,
  CustomTitleEntry,
  Entry,
  LastPromptEntry,
  ModeEntry,
  SessionMode,
  SummaryMessage,
  TagEntry,
  TranscriptMessage,
} from '../entry.js';
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../message.js';

const uuid = () => randomUUID();

function makeUserMessage(): UserMessage {
  return {
    type: 'user',
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: 'What is 2+2?',
    },
  };
}

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: uuid(),

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: {
        ...cloneUsage(),
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'The answer is 4.' }],
    },
  };
}

function makeSystemMessage(): SystemMessage {
  return {
    type: 'system',
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    subtype: 'informational',
    content: 'Session started.',
    level: 'info',
  };
}

function makeTranscriptMessage(base?: Message): TranscriptMessage {
  const message = base ?? makeAssistantMessage();
  return {
    ...message,
    parentUuid: null,
    isSidechain: false,
    cwd: '/home/user/project',
    sessionId: uuid(),
    userType: 'human',
    version: '1.0.0',
    timestamp: message.timestamp ?? new Date().toISOString(),
  };
}

describe('Message variants', () => {
  it('UserMessage can be constructed', () => {
    const message = makeUserMessage();
    expect(message.type).toBe('user');
    expect(message.message.role).toBe('user');
    expect(message.uuid).toBeDefined();
  });

  it('AssistantMessage can be constructed with full API response', () => {
    const message = makeAssistantMessage();
    expect(message.type).toBe('assistant');
    expect(message.message.id).toBeDefined();
    expect(message.message.content).toHaveLength(1);
    expect(message.message.container).toBeNull();
    expect(message.message.context_management).toBeNull();
  });

  it('SystemMessage can be constructed', () => {
    const message = makeSystemMessage();
    expect(message.type).toBe('system');
    expect(message.subtype).toBe('informational');
    expect(message.level).toBe('info');
  });

  it('discriminated union narrows correctly', () => {
    const messages: Message[] = [
      makeUserMessage(),
      makeAssistantMessage(),
      makeSystemMessage(),
    ];

    for (const message of messages) {
      switch (message.type) {
        case 'user':
          expect(message.message.role).toBe('user');
          break;
        case 'assistant':
          expect(message.message.id).toBeDefined();
          break;
        case 'system':
          expect(message.subtype).toBeDefined();
          break;
        default:
          break;
      }
    }
  });
});

describe('TranscriptMessage', () => {
  it('can be constructed with all required fields', () => {
    const message = makeTranscriptMessage();
    expect(message.type).toBe('assistant');
    expect(message.parentUuid).toBeNull();
    expect(message.isSidechain).toBe(false);
    expect(message.cwd).toBeDefined();
    expect(message.sessionId).toBeDefined();
    expect(message.timestamp).toBeDefined();
    expect(message.version).toBe('1.0.0');
  });

  it('supports optional fields', () => {
    const message: TranscriptMessage = {
      ...makeTranscriptMessage(),
      gitBranch: 'feat/parity',
      agentId: 'agent-001',
      teamName: 'my-team',
      agentName: 'researcher',
      agentColor: '#FF5733',
      promptId: 'prompt-001',
      logicalParentUuid: uuid(),
      forkedFrom: {
        sessionId: uuid(),
        messageUuid: uuid(),
      },
    };
    expect(message.gitBranch).toBe('feat/parity');
    expect(message.agentId).toBe('agent-001');
    expect(message.agentColor).toBe('#FF5733');
    expect(message.forkedFrom?.messageUuid).toBeDefined();
  });

  it('can represent a user turn', () => {
    const message = makeTranscriptMessage(makeUserMessage());
    expect(message.type).toBe('user');
    if (message.type === 'user') {
      expect(message.message.role).toBe('user');
    }
  });

  it('satisfies the Entry type', () => {
    const entry: Entry = makeTranscriptMessage();
    expect(entry.type).toBe('assistant');
  });
});

describe('SummaryMessage', () => {
  it('can be constructed', () => {
    const entry: SummaryMessage = {
      type: 'summary',
      leafUuid: uuid(),
      summary:
        'User asked about file editing. Assistant helped with a code change.',
    };
    expect(entry.type).toBe('summary');
    expect(entry.summary).toContain('file editing');
  });
});

describe('CustomTitleEntry', () => {
  it('can be constructed', () => {
    const entry: CustomTitleEntry = {
      type: 'custom-title',
      sessionId: uuid(),
      customTitle: 'My Session',
    };
    expect(entry.type).toBe('custom-title');
  });
});

describe('AiTitleEntry', () => {
  it('can be constructed', () => {
    const entry: AiTitleEntry = {
      type: 'ai-title',
      sessionId: uuid(),
      aiTitle: 'AI Generated Title',
    };
    expect(entry.type).toBe('ai-title');
  });
});

describe('LastPromptEntry', () => {
  it('can be constructed', () => {
    const entry: LastPromptEntry = {
      type: 'last-prompt',
      sessionId: uuid(),
      lastPrompt: 'Fix the bug in auth.ts',
    };
    expect(entry.type).toBe('last-prompt');
  });
});

describe('TagEntry', () => {
  it('can be constructed', () => {
    const entry: TagEntry = {
      type: 'tag',
      sessionId: uuid(),
      tag: 'bugfix',
    };
    expect(entry.type).toBe('tag');
  });
});

describe('ModeEntry', () => {
  it('can represent coordinator mode', () => {
    const entry: ModeEntry = {
      type: 'mode',
      sessionId: uuid(),
      mode: 'coordinator',
    };
    expect(entry.mode).toBe('coordinator');
  });

  it('can represent normal mode', () => {
    const entry: ModeEntry = {
      type: 'mode',
      sessionId: uuid(),
      mode: 'normal',
    };
    expect(entry.mode).toBe('normal');
  });
});

describe('ContentReplacementEntry', () => {
  it('can be constructed', () => {
    const entry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: uuid(),
      replacements: [
        {
          messageUuid: uuid(),
          blockIndex: 0,
          originalType: 'tool_result',
          stubContent: '[truncated]',
        },
      ],
    };
    expect(entry.type).toBe('content-replacement');
    expect(entry.replacements).toHaveLength(1);
  });
});

describe('ActiveLeafEntry', () => {
  it('can select a durable conversation branch without becoming a message', () => {
    const entry: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'assistant-2',
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };

    expect(entry.leafUuid).toBe('assistant-2');
    expect(isTranscriptMessage(entry)).toBe(false);
  });
});

describe('SessionMode', () => {
  it('accepts coordinator and normal', () => {
    const modes: SessionMode[] = ['coordinator', 'normal'];
    expect(modes).toHaveLength(2);
  });
});

describe('Entry union', () => {
  it('can discriminate all entry types', () => {
    const entries: Entry[] = [
      makeTranscriptMessage(),
      {
        type: 'summary',
        leafUuid: uuid(),
        summary: 'Summary text',
      },
      { type: 'custom-title', sessionId: uuid(), customTitle: 'My Title' },
      { type: 'ai-title', sessionId: uuid(), aiTitle: 'AI Title' },
      { type: 'last-prompt', sessionId: uuid(), lastPrompt: 'Last prompt' },
      { type: 'tag', sessionId: uuid(), tag: 'important' },
      { type: 'mode', sessionId: uuid(), mode: 'normal' },
      {
        type: 'content-replacement',
        sessionId: uuid(),
        replacements: [],
      },
      {
        type: 'active-leaf',
        sessionId: uuid(),
        leafUuid: null,
        explicit: true,
        rewound: true,
        timestamp: 1_754_300_000_000,
      },
    ];

    const types = entries.map((entry) => entry.type);
    expect(types).toContain('assistant');
    expect(types).toContain('summary');
    expect(types).toContain('custom-title');
    expect(types).toContain('ai-title');
    expect(types).toContain('last-prompt');
    expect(types).toContain('tag');
    expect(types).toContain('mode');
    expect(types).toContain('content-replacement');
    expect(types).toContain('active-leaf');
  });
});

describe('isTranscriptMessage', () => {
  it('returns true for user, assistant, system, and durable attachments', () => {
    expect(isTranscriptMessage(makeTranscriptMessage(makeUserMessage()))).toBe(
      true,
    );
    expect(
      isTranscriptMessage(makeTranscriptMessage(makeAssistantMessage())),
    ).toBe(true);
    expect(
      isTranscriptMessage(makeTranscriptMessage(makeSystemMessage())),
    ).toBe(true);
    expect(
      isTranscriptMessage({
        type: 'attachment',
        uuid: uuid(),
        timestamp: new Date().toISOString(),
        attachment: { type: 'queued_command', content: 'queued' },
      } as never),
    ).toBe(true);
    expect(
      isTranscriptMessage({
        type: 'attachment',
        uuid: uuid(),
        timestamp: new Date().toISOString(),
        attachment: { type: 'task_reminder', content: [], itemCount: 0 },
      } as never),
    ).toBe(true);
    expect(
      isTranscriptMessage({
        type: 'attachment',
        uuid: uuid(),
        timestamp: new Date().toISOString(),
        attachment: {
          type: 'skill_listing',
          content: '- inspect: Inspect a repository',
          names: ['inspect'],
          skillCount: 1,
          isInitial: true,
        },
      } as never),
    ).toBe(true);
    expect(
      isTranscriptMessage({
        type: 'attachment',
        uuid: uuid(),
        timestamp: new Date().toISOString(),
        attachment: {
          type: 'dynamic_skill',
          skillDir: '/workspace/.skills',
          names: ['inspect'],
          displayPath: '.skills',
        },
      } as never),
    ).toBe(true);
  });

  it('returns false for metadata entries', () => {
    expect(
      isTranscriptMessage({
        type: 'summary',
        leafUuid: uuid(),
        summary: 'sum',
      }),
    ).toBe(false);
    expect(
      isTranscriptMessage({ type: 'mode', sessionId: uuid(), mode: 'normal' }),
    ).toBe(false);
    expect(
      isTranscriptMessage({
        type: 'active-leaf',
        sessionId: uuid(),
        leafUuid: null,
        explicit: true,
        timestamp: 1_754_300_000_000,
      }),
    ).toBe(false);
  });
});
