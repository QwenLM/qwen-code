/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WORKFLOW_TOOL_NAME } from '../../tools/tool-names.js';
import type { AttachmentExternalContext } from '../types.js';
import {
  containsStandaloneUltracode,
  findStandaloneUltracodeRanges,
  getWorkflowKeywordReminderAttachments,
} from './workflow-generators.js';

function externalContext(enabled: boolean): AttachmentExternalContext {
  return {
    toolRegistry: {
      hasToolEnabled: (name: string) =>
        name === WORKFLOW_TOOL_NAME ? enabled : false,
    },
  };
}

describe('getWorkflowKeywordReminderAttachments', () => {
  it('emits a dedicated attachment for a standalone UltraCode keyword', () => {
    expect(
      getWorkflowKeywordReminderAttachments(
        'Use UltraCode to audit this repository.',
        externalContext(true),
      ),
    ).toEqual([{ type: 'workflow_keyword_request' }]);
  });

  it('does not emit for slash commands, ignored regions, or path-like forms', () => {
    for (const input of [
      '/ultracode audit',
      'Please inspect `ultracode` usage in docs.',
      'The word "ultracode" is just quoted.',
      "The word 'ultracode' is just quoted.",
      'Ignore (ultracode) in parenthetical examples.',
      'Ignore {ultracode} in object examples.',
      'Ignore [ultracode] in array examples.',
      '<tag ultracode>',
      'foo/ultracode',
      'foo\\ultracode',
      'foo-ultracode',
      'ultracode/path',
      'ultracode-question',
      'ultracode?',
      'ultracode.enabled',
      'superultracode',
    ]) {
      expect(
        getWorkflowKeywordReminderAttachments(input, externalContext(true)),
      ).toEqual([]);
    }
  });

  it('does not emit when the Workflow tool is disabled', () => {
    expect(
      getWorkflowKeywordReminderAttachments(
        'Use ultracode to audit this repository.',
        externalContext(false),
      ),
    ).toEqual([]);
  });

  it('does not treat generic Workflow wording as the UltraCode keyword', () => {
    for (const input of [
      'Use multi-agent orchestration for this task.',
      'Use workflows to audit these packages.',
    ]) {
      expect(
        getWorkflowKeywordReminderAttachments(input, externalContext(true)),
      ).toEqual([]);
    }
  });

  it('does not emit for ordinary prompts', () => {
    expect(
      getWorkflowKeywordReminderAttachments(
        'Please inspect the repository.',
        externalContext(true),
      ),
    ).toEqual([]);
  });
});

describe('containsStandaloneUltracode', () => {
  it.each([
    'ultracode',
    'ULTRACODE review this',
    'please ultracode this',
    '用ultracode帮我',
    "don't skip ultracode",
    "don't ultracode'",
    ' ultracode after leading space',
    'ultracode.',
    '1 < ultracode > 0',
  ])('matches %j', (input) => {
    expect(containsStandaloneUltracode(input)).toBe(true);
  });

  it.each([
    '/ultracode',
    '`ultracode`',
    '"ultracode"',
    "'ultracode'",
    '(nested (ultracode))',
    '{ nested: [ultracode] }',
    '<tag ultracode>',
    '</tag ultracode>',
    'foo-ultracode',
    'ultracode/path',
    'ultracode.enabled',
  ])('rejects %j', (input) => {
    expect(containsStandaloneUltracode(input)).toBe(false);
  });

  it('returns Unicode code-point offsets for TUI highlighting', () => {
    expect(findStandaloneUltracodeRanges('😀 ultracode now')).toEqual([
      { start: 2, end: 11 },
    ]);
  });
});
