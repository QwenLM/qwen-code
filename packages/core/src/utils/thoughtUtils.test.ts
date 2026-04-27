/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseThought, extractThinkTags } from './thoughtUtils.js';

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

describe('extractThinkTags', () => {
  it.each([
    {
      name: 'single think tag with thinking and response content',
      input: '<think>Let me analyze this...</think>The answer is 42',
      expected: {
        thinkingContent: 'Let me analyze this...',
        responseContent: 'The answer is 42',
        hasThinkTags: true,
      },
    },
    {
      name: 'think tag with multiline content',
      input: `<think>
First, I need to understand the problem.
Second, I'll analyze the code.
</think>Here's my solution:`,
      expected: {
        thinkingContent:
          'First, I need to understand the problem.\nSecond, I\'ll analyze the code.',
        responseContent: "Here's my solution:",
        hasThinkTags: true,
      },
    },
    {
      name: 'no think tags present',
      input: 'Just a regular response without any thinking tags',
      expected: {
        thinkingContent: '',
        responseContent: 'Just a regular response without any thinking tags',
        hasThinkTags: false,
      },
    },
    {
      name: 'opening tag without closing tag',
      input: '<think>I started thinking but never finished',
      expected: {
        thinkingContent: 'I started thinking but never finished',
        responseContent: '',
        hasThinkTags: true,
      },
    },
    {
      name: 'text before opening tag',
      input: 'Some prefix text <think>Thinking here</think>Response',
      expected: {
        thinkingContent: 'Thinking here',
        responseContent: 'Some prefix text Response',
        hasThinkTags: true,
      },
    },
    {
      name: 'only thinking content, no response',
      input: '<think>Complete thinking content only</think>',
      expected: {
        thinkingContent: 'Complete thinking content only',
        responseContent: '',
        hasThinkTags: true,
      },
    },
    {
      name: 'empty thinking content',
      input: '<think></think>Response after empty thinking',
      expected: {
        thinkingContent: '',
        responseContent: 'Response after empty thinking',
        hasThinkTags: true,
      },
    },
    {
      name: 'empty string input',
      input: '',
      expected: {
        thinkingContent: '',
        responseContent: '',
        hasThinkTags: false,
      },
    },
    {
      name: 'null input',
      input: null as any,
      expected: {
        thinkingContent: '',
        responseContent: '',
        hasThinkTags: false,
      },
    },
    {
      name: 'multiple think tags - only first pair processed',
      input: '<think>First thinking</think>Some text <think>Second thinking</think>More text',
      expected: {
        thinkingContent: 'First thinking',
        responseContent: 'Some text <think>Second thinking</think>More text',
        hasThinkTags: true,
      },
    },
    {
      name: 'thinking content with special characters',
      input:
        '<think>What about <html> & "quotes"?</think>Response with **special** chars',
      expected: {
        thinkingContent: 'What about <html> & "quotes"?',
        responseContent: 'Response with **special** chars',
        hasThinkTags: true,
      },
    },
    {
      name: 'whitespace around tags',
      input: '   <think>  Thinking with spaces </think>  Response with spaces  ',
      expected: {
        thinkingContent: 'Thinking with spaces',
        responseContent: 'Response with spaces',
        hasThinkTags: true,
      },
    },
  ])('should correctly extract $name', ({ input, expected }) => {
    expect(extractThinkTags(input)).toEqual(expected);
  });
});
