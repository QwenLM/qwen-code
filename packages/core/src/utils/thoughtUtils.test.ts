/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { GenerateContentResponse, Part } from '@google/genai';
import {
  createOpenAIReasoningThoughtPart,
  getThoughtSummary,
  isResponsesReasoningSignature,
  parseThought,
} from './thoughtUtils.js';

function responseWithParts(parts: Part[]): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
      },
    ],
  } as GenerateContentResponse;
}

describe('parseThought', () => {
  it.each([
    {
      name: 'a standard thought with subject and description',
      rawText: '**Subject:** This is the description.',
      expected: {
        subject: 'Subject:',
        description: 'This is the description.',
      },
    },
    {
      name: 'leading and trailing whitespace in the raw string',
      rawText: '  **Subject** description with spaces   ',
      expected: { subject: 'Subject', description: 'description with spaces' },
    },
    {
      name: 'whitespace surrounding the subject content',
      rawText: '** Subject  **',
      expected: { subject: 'Subject', description: '' },
    },
    {
      name: 'a thought with only a subject',
      rawText: '**Only Subject**',
      expected: { subject: 'Only Subject', description: '' },
    },
    {
      name: 'a thought with only a description (no subject)',
      rawText: 'This is just a description.',
      expected: { subject: '', description: 'This is just a description.' },
    },
    {
      name: 'an empty string input',
      rawText: '',
      expected: { subject: '', description: '' },
    },
    {
      name: 'newlines within the subject and description',
      rawText:
        '**Multi-line\nSubject**\nHere is a description\nspread across lines.',
      expected: {
        subject: 'Multi-line\nSubject',
        description: 'Here is a description\nspread across lines.',
      },
    },
    {
      name: 'only the first subject if multiple are present',
      rawText: '**First** some text **Second**',
      expected: { subject: 'First', description: 'some text **Second**' },
    },
    {
      name: 'text before and after the subject',
      rawText: 'Prefix text **Subject** Suffix text.',
      expected: {
        subject: 'Subject',
        description: 'Prefix text  Suffix text.',
      },
    },
    {
      name: 'an unclosed subject tag',
      rawText: 'Text with **an unclosed subject',
      expected: { subject: '', description: 'Text with **an unclosed subject' },
    },
    {
      name: 'an empty subject tag',
      rawText: 'A thought with **** in the middle.',
      expected: { subject: '', description: 'A thought with  in the middle.' },
    },
  ])('should correctly parse $name', ({ rawText, expected }) => {
    expect(parseThought(rawText)).toEqual(expected);
  });
});

describe('getThoughtSummary', () => {
  it('should preserve OpenAI reasoning thought parts as raw descriptions', () => {
    const response = responseWithParts([
      createOpenAIReasoningThoughtPart('**Analyzing the request**'),
    ]);

    expect(getThoughtSummary(response)).toEqual({
      subject: '',
      description: '**Analyzing the request**',
    });
  });

  it('should parse unmarked thought parts as structured thoughts', () => {
    const response = responseWithParts([
      { thought: true, text: '**Only Subject**' },
    ]);

    expect(getThoughtSummary(response)).toEqual({
      subject: 'Only Subject',
      description: '',
    });
  });

  it('should return null when there are no thought parts', () => {
    const response = responseWithParts([{ text: 'final answer' }]);

    expect(getThoughtSummary(response)).toBeNull();
  });

  it('should return null when thought parts contain no text', () => {
    const response = responseWithParts([{ thought: true, text: '' }]);

    expect(getThoughtSummary(response)).toBeNull();
  });
});

describe('isResponsesReasoningSignature', () => {
  const replayPayload = JSON.stringify({
    id: 'rs_68c6c0c9ff5c8191a29b2e78c1a40c83',
    encrypted_content: 'gAAAAABvcmVhc29uaW5nLXJlcGxheS1wYXlsb2Fk',
  });

  it('recognizes a Responses reasoning replay payload', () => {
    expect(isResponsesReasoningSignature(replayPayload)).toBe(true);
  });

  it('recognizes a payload with leading whitespace', () => {
    // The `startsWith('{')` pre-check must tolerate leading whitespace the
    // same way `JSON.parse` itself does, so a payload preceded by a newline
    // or spaces is still recognized (and dropped off a foreign wire) rather
    // than forwarded unchanged.
    expect(isResponsesReasoningSignature(`\n  ${replayPayload}`)).toBe(true);
  });

  it('rejects a non-string id', () => {
    const nonStringId = JSON.stringify({
      id: 123,
      encrypted_content: 'gAAAAABvcmVhc29uaW5nLXJlcGxheS1wYXlsb2Fk',
    });
    expect(isResponsesReasoningSignature(nonStringId)).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    // The SDK types thoughtSignature as string, but the value crosses untyped
    // boundaries — persisted-history restore performs no Part shape validation —
    // so treat a non-string as a native opaque token rather than throwing.
    expect(isResponsesReasoningSignature(undefined)).toBe(false);
    expect(isResponsesReasoningSignature(null)).toBe(false);
    expect(isResponsesReasoningSignature(1)).toBe(false);
    expect(isResponsesReasoningSignature(true)).toBe(false);
    expect(isResponsesReasoningSignature({})).toBe(false);
  });

  it('rejects a non-object parsed payload', () => {
    expect(isResponsesReasoningSignature('"just a string"')).toBe(false);
    expect(isResponsesReasoningSignature('123')).toBe(false);
  });

  it('rejects an object missing the replay shape', () => {
    expect(isResponsesReasoningSignature('{}')).toBe(false);
    expect(isResponsesReasoningSignature(JSON.stringify({ id: 'rs_1' }))).toBe(
      false,
    );
    expect(
      isResponsesReasoningSignature(JSON.stringify({ encrypted_content: 'x' })),
    ).toBe(false);
  });
});
