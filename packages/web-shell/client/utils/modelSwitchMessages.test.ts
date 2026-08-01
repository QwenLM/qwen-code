import { describe, expect, it } from 'vitest';
import type { Message } from '../adapters/types';
import { filterModelSwitchMessages } from './modelSwitchMessages';

function modelSwitchSummary(id: string, modelId: string): Message {
  return {
    id,
    role: 'system',
    variant: 'info',
    content: `AuthType: openai\nUsing model: ${modelId}`,
    source: 'model_switch_summary',
    data: { modelId },
    timestamp: 1,
  };
}

function modelSwitchStatus(id: string, modelId: string): Message {
  return {
    id,
    role: 'system',
    variant: 'info',
    content: `Model switched: ${modelId}(openai)`,
    timestamp: 2,
  };
}

function userMessage(id: string): Message {
  return {
    id,
    role: 'user',
    content: 'hello',
    timestamp: 3,
  };
}

describe('filterModelSwitchMessages', () => {
  it('hides model switch messages at the start of a new session', () => {
    expect(
      filterModelSwitchMessages([
        modelSwitchSummary('summary', 'qwen-plus'),
        userMessage('user'),
      ]),
    ).toEqual([userMessage('user')]);
  });

  it('keeps model switch messages after conversation content exists', () => {
    const messages = [
      userMessage('user'),
      modelSwitchSummary('summary', 'qwen-plus'),
    ];
    expect(filterModelSwitchMessages(messages)).toEqual(messages);
  });

  it('deduplicates SDK status noise covered by a summary message', () => {
    expect(
      filterModelSwitchMessages([
        modelSwitchStatus('status', 'qwen-plus'),
        modelSwitchSummary('summary', 'qwen-plus'),
        userMessage('user'),
      ]),
    ).toEqual([userMessage('user')]);
  });
});
