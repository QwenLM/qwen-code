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
