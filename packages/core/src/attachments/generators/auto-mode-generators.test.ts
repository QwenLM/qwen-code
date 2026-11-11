/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AutoModeAttachment } from '../models/auto-mode-attachments.js';
import { AutoModeExitAttachment } from '../models/auto-mode-attachments.js';
import { UltraEffortEnterAttachment } from '../models/workflow-attachments.js';
import { UltraEffortExitAttachment } from '../models/workflow-attachments.js';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  getUltraEffortAttachments,
  AUTO_MODE_ATTACHMENT_CONFIG,
  ULTRA_EFFORT_ATTACHMENT_CONFIG,
} from './auto-mode-generators.js';
import { AutoClassifier } from '../../permissions/permission-modes/auto/auto-classifier.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { Attachment } from '../types.js';

function humanTurn(): Message {
  return {
    type: 'user',
    message: { role: 'user', content: 'hi' },
  } as unknown as Message;
}

function toolResultTurn(): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'result',
        },
      ],
    },
    sourceToolAssistantUUID: 'assistant-1',
  } as unknown as Message;
}

function unlinkedToolResultTurn(): Message {
  const message = toolResultTurn();
  if (message.type === 'user') {
    delete message.sourceToolAssistantUUID;
  }
  return message;
}

function attachmentMsg(attachment: Attachment): Message {
  return { type: 'attachment', attachment } as unknown as Message;
}

const autoModeMsg = () =>
  attachmentMsg(
    new AutoModeAttachment({ type: 'auto_mode', reminderType: 'full' }),
  );
const autoModeExitMsg = () =>
  attachmentMsg(new AutoModeExitAttachment({ type: 'auto_mode_exit' }));

describe('getAutoModeAttachments', () => {
  it('returns nothing outside auto mode', () => {
    expect(getAutoModeAttachments('default', [])).toEqual([]);
    expect(getAutoModeAttachments('yolo', [])).toEqual([]);
    expect(getAutoModeAttachments(undefined, [])).toEqual([]);
  });

  it('attaches a full reminder on the first turn in auto mode', () => {
    expect(getAutoModeAttachments('auto', [])).toEqual([
      { type: 'auto_mode', reminderType: 'full' },
    ]);
  });

  it('stays silent until the turn gap has passed', () => {
    const messages = [autoModeMsg(), humanTurn(), humanTurn()];
    expect(getAutoModeAttachments('auto', messages)).toEqual([]);
  });

  it('does not count tool results as human turns', () => {
    const messages: Message[] = [autoModeMsg()];
    for (let i = 0; i < 10; i++) messages.push(toolResultTurn());
    expect(getAutoModeAttachments('auto', messages)).toEqual([]);
  });

  it('attaches a sparse reminder once the turn gap has passed', () => {
    const messages: Message[] = [autoModeMsg()];
    for (
      let i = 0;
      i < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS;
      i++
    ) {
      messages.push(humanTurn());
    }
    // Second attachment of this stint → sparse.
    expect(getAutoModeAttachments('auto', messages)).toEqual([
      { type: 'auto_mode', reminderType: 'sparse' },
    ]);
  });

  it('restarts the full/sparse cycle after leaving and re-entering', () => {
    const messages: Message[] = [
      autoModeMsg(),
      autoModeMsg(),
      autoModeExitMsg(),
    ];
    for (
      let i = 0;
      i < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS;
      i++
    ) {
      messages.push(humanTurn());
    }
    // The exit boundary hides the earlier attachments, so this is #1 again.
    expect(getAutoModeAttachments('auto', messages)).toEqual([
      { type: 'auto_mode', reminderType: 'full' },
    ]);
  });
});

describe('getAutoModeExitAttachment', () => {
  let classifier: AutoClassifier;

  beforeEach(() => {
    classifier = new AutoClassifier();
  });

  it('returns nothing when auto mode was never left', () => {
    expect(getAutoModeExitAttachment(classifier, 'session-1', 'default')).toEqual([]);
  });

  it('emits once after auto mode was left', () => {
    classifier.setNeedsExitAttachment('session-1', true);
    expect(getAutoModeExitAttachment(classifier, 'session-1', 'default')).toEqual([
      { type: 'auto_mode_exit' },
    ]);
    expect(getAutoModeExitAttachment(classifier, 'session-1', 'default')).toEqual([]);
  });

  it('discards the notice when auto mode was re-entered first', () => {
    classifier.setNeedsExitAttachment('session-1', true);
    expect(getAutoModeExitAttachment(classifier, 'session-1', 'auto')).toEqual([]);
  });

  // The reason the flag hangs off the session rather than the module: in a
  // process running two sessions, one leaving Auto must not announce an exit
  // in the other's transcript.
  it('keeps the notice inside the session that left auto mode', () => {
    const other = new AutoClassifier();
    classifier.setNeedsExitAttachment('session-1', true);
    expect(getAutoModeExitAttachment(other, 'session-2', 'default')).toEqual([]);
    expect(getAutoModeExitAttachment(classifier, 'session-1', 'default')).toEqual([
      { type: 'auto_mode_exit' },
    ]);
  });

  it('emits nothing when the host never threaded a config', () => {
    expect(getAutoModeExitAttachment(undefined, 'session-1', 'default')).toEqual([]);
  });
});

describe('getUltraEffortAttachments', () => {
  const ultraEnter = (reminderType: 'full' | 'sparse' = 'full') =>
    attachmentMsg(
      new UltraEffortEnterAttachment({
        type: 'ultra_effort_enter',
        reminderType,
      }),
    );
  const ultraExit = () =>
    attachmentMsg(new UltraEffortExitAttachment({ type: 'ultra_effort_exit' }));

  it('emits a full reminder on the first active user turn', () => {
    expect(getUltraEffortAttachments(true, [])).toEqual([
      { type: 'ultra_effort_enter', reminderType: 'full' },
    ]);
  });

  it('emits a sparse reminder after ten ordinary user turns', () => {
    const messages: Message[] = [ultraEnter()];
    for (
      let i = 0;
      i < ULTRA_EFFORT_ATTACHMENT_CONFIG.TURNS_BETWEEN_MAINTENANCE;
      i++
    ) {
      messages.push(humanTurn());
    }
    expect(getUltraEffortAttachments(true, messages)).toEqual([
      { type: 'ultra_effort_enter', reminderType: 'sparse' },
    ]);
  });

  it('does not count tool-result or meta user messages', () => {
    const meta = { ...humanTurn(), isMeta: true } as Message;
    const messages: Message[] = [ultraEnter()];
    for (let i = 0; i < 10; i++) {
      messages.push(toolResultTurn(), unlinkedToolResultTurn(), meta);
    }
    expect(getUltraEffortAttachments(true, messages)).toEqual([]);
  });

  it('emits one exit after leaving and a full reminder after re-entering', () => {
    expect(getUltraEffortAttachments(false, [ultraEnter()])).toEqual([
      { type: 'ultra_effort_exit' },
    ]);
    expect(
      getUltraEffortAttachments(false, [ultraEnter(), ultraExit()]),
    ).toEqual([]);
    expect(
      getUltraEffortAttachments(true, [ultraEnter(), ultraExit()]),
    ).toEqual([{ type: 'ultra_effort_enter', reminderType: 'full' }]);
  });
});
