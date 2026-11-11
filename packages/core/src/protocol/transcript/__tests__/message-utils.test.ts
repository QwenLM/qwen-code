/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LOCAL_COMMAND_CAVEAT } from '../../../constants/xmlTags.js';
import { createToolResultMessage, createUserMessage } from '../conversions.js';
import {
  countHumanPromptMessages,
  getDisplayablePromptText,
  getDisplayableUserText,
  getRealUserPromptText,
  getUserPromptFallbackText,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isMeaningfulUserPromptMessage,
  isHiddenUserMessageInDefaultHistory,
  isReplayableUserMessage,
  isSyntheticMessage,
  parseLocalCommandStdoutText,
} from '../message-utils.js';

describe('message-utils displayable user text', () => {
  it('counts only persisted human prompt inputs', () => {
    const prompt = createUserMessage('fix the bug', {
      humanInput: { text: 'fix the bug', mode: 'prompt' },
    });
    const bash = createUserMessage('<bash-input>npm test</bash-input>', {
      humanInput: { text: 'npm test', mode: 'bash' },
    });
    const internal = createUserMessage('internal context', { isMeta: true });
    const toolResult = createToolResultMessage([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false }
    ], 'assistant-1');

    expect(
      countHumanPromptMessages([prompt, bash, internal, toolResult]),
    ).toBe(1);
  });

  it('renders known XML transcript payloads into user-facing text', () => {
    expect(
      getDisplayablePromptText(
        '<command-name>/remote-control</command-name>\n<command-message>remote-control</command-message>\n<command-args></command-args>',
      ),
    ).toBe('/remote-control');

    expect(getDisplayablePromptText('<bash-input>npm test</bash-input>')).toBe(
      '! npm test',
    );

    expect(
      getDisplayablePromptText(
        '<local-command-stdout>Model set to efficient\n(persisted)</local-command-stdout>',
      ),
    ).toBe('Model set to efficient\n(persisted)');
  });

  it('suppresses internal XML transcript payloads instead of leaking raw tags', () => {
    expect(getDisplayablePromptText(LOCAL_COMMAND_CAVEAT)).toBeUndefined();
    expect(
      getDisplayablePromptText('<system-reminder>internal</system-reminder>'),
    ).toBeUndefined();
    expect(
      getDisplayablePromptText('<unknown-internal>value</unknown-internal>'),
    ).toBeUndefined();
  });

  it('preserves user text after leading hook context blocks', () => {
    expect(
      getDisplayablePromptText(
        '<hook_context>[安全会话] 会话已启动</hook_context>\n\n用write工具创建一个文件test.txt',
      ),
    ).toBe('用write工具创建一个文件test.txt');

    expect(
      getDisplayablePromptText(
        '<system-reminder>memory context</system-reminder>\n\n<hook_context source="SessionStart">audit context</hook_context>\n\n重试',
      ),
    ).toBe('重试');
  });

  it('strips loaded context before displaying and classifying a delegated prompt', () => {
    const message = createUserMessage(
      '<loaded_context>\n<project_context>internal AGENTS instructions</project_context>\n</loaded_context>\n\nReview this commit for efficiency only.\nDo not modify code.',
    );

    expect(getDisplayableUserText(message)).toBe(
      'Review this commit for efficiency only.\nDo not modify code.',
    );
    expect(getRealUserPromptText(message)).toBe(
      'Review this commit for efficiency only. Do not modify code.',
    );
    expect(getDisplayableUserText(message)).not.toContain('loaded_context');
    expect(getRealUserPromptText(message)).not.toContain('AGENTS');
  });

  it('keeps context-only and malformed internal payloads hidden', () => {
    const contextOnly = createUserMessage(
      '<loaded_context><project_context>internal</project_context></loaded_context>',
    );
    const malformed = createUserMessage(
      '<loaded_context><project_context>internal</project_context>visible text',
    );

    expect(getDisplayableUserText(contextOnly)).toBeUndefined();
    expect(getRealUserPromptText(contextOnly)).toBeNull();
    expect(getDisplayableUserText(malformed)).toBeUndefined();
    expect(getRealUserPromptText(malformed)).toBeNull();
  });

  it('classifies a command after loaded context as a prompt fallback', () => {
    const message = createUserMessage(
      '<loaded_context><project_context>internal</project_context></loaded_context>\n\n/model efficient',
    );

    expect(getDisplayableUserText(message)).toBe('/model efficient');
    expect(getUserPromptFallbackText(message)).toBe('/model efficient');
    expect(getRealUserPromptText(message)).toBeNull();
  });

  it('classifies an absolute-path prompt as real user text', () => {
    const text = '/Users/me/project 这里面有啥';
    const message = createUserMessage(text);

    expect(getDisplayableUserText(message)).toBe(text);
    expect(getUserPromptFallbackText(message)).toBeNull();
    expect(getRealUserPromptText(message)).toBe(text);
  });

  it('extracts displayable text from mixed user text blocks', () => {
    const message = createUserMessage([
      { type: 'text', text: LOCAL_COMMAND_CAVEAT },
      {
        type: 'text',
        text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>efficient</command-args>',
      },
      { type: 'text', text: 'plain follow-up' },
    ]);

    expect(getDisplayableUserText(message)).toBe(
      '/model efficient\nplain follow-up',
    );
  });

  it('内容为空时不生成展示文本或人类提示词', () => {
    const emptyMessage = createUserMessage([]);

    expect(getDisplayableUserText(emptyMessage)).toBeUndefined();
    expect(getRealUserPromptText(emptyMessage)).toBeNull();
    expect(getUserPromptFallbackText(emptyMessage)).toBeNull();
    expect(isMeaningfulUserPromptMessage(emptyMessage)).toBe(false);
  });

  it('preserves plain user text whitespace for transcript display', () => {
    const message = createUserMessage(
      '依次调用内置工具\n内置工具\n\n   - Read - 读取文件内容\n   - Write - 创建/覆盖文件',
    );

    expect(getDisplayableUserText(message)).toBe(
      '依次调用内置工具\n内置工具\n\n   - Read - 读取文件内容\n   - Write - 创建/覆盖文件',
    );
    expect(getDisplayablePromptText(getDisplayableUserText(message))).toBe(
      '依次调用内置工具 内置工具 - Read - 读取文件内容 - Write - 创建/覆盖文件',
    );
  });

  it('does not classify local command output as a prompt fallback', () => {
    const content = '<local-command-stdout>Saved settings</local-command-stdout>';
    const message = createUserMessage(content);

    expect(parseLocalCommandStdoutText(content)).toBe(
      'Saved settings',
    );
    expect(getDisplayableUserText(message)).toBe('Saved settings');
    expect(getUserPromptFallbackText(message)).toBeNull();
    expect(isMeaningfulUserPromptMessage(message)).toBe(true);
  });

  it('treats interruption marker text as synthetic transcript content', () => {
    const message = createUserMessage([
      { type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE },
    ]);

    expect(getDisplayablePromptText(INTERRUPT_MESSAGE_FOR_TOOL_USE)).toBe(
      undefined,
    );
    expect(getDisplayableUserText(message)).toBe(undefined);
    expect(isHiddenUserMessageInDefaultHistory(message)).toBe(true);
    expect(isMeaningfulUserPromptMessage(message)).toBe(false);
    expect(isSyntheticMessage(message)).toBe(true);
  });

  it('selects only public user input for SDK replay', () => {
    const commandMessage = createUserMessage(
      '<command-message>init</command-message>\n<command-name>/init</command-name>',
    );
    const metaMessage = createUserMessage('quick init prompt', {
      isMeta: true,
    });
    const transcriptOnlyMessage = createUserMessage('compact summary', {
      isVisibleInTranscriptOnly: true,
    });
    const toolResultMessage = createToolResultMessage([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false }
    ], 'assistant-1');
    const syntheticMessage = createUserMessage([
      { type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE },
    ]);

    expect(isReplayableUserMessage(commandMessage)).toBe(true);
    expect(isReplayableUserMessage(metaMessage)).toBe(false);
    expect(isReplayableUserMessage(transcriptOnlyMessage)).toBe(false);
    expect(isReplayableUserMessage(toolResultMessage)).toBe(false);
    expect(isReplayableUserMessage(syntheticMessage)).toBe(false);
  });
});
