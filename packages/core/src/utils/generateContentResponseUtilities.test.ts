/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getResponseTextFromParts,
  getFunctionCalls,
  getFunctionCallsFromParts,
  getFunctionCallsAsJson,
  getFunctionCallsFromPartsAsJson,
  getStructuredResponse,
  getStructuredResponseFromParts,
  getToolResponseDisplayText,
  TOOL_SUCCEEDED_OUTPUT,
} from './generateContentResponseUtilities.js';
import type { GenerateContentResponse, Part } from '@google/genai';
import { FinishReason } from '@google/genai';
import { fnCall } from '../test-utils/model-fixtures.js';

const mockTextPart = (text: string): Part => ({ text });
const callPart = (func: { name: string; args: Record<string, unknown> }) =>
  fnCall(func.name, func.args);

const func = { name: 'testFunc', args: { a: 1 } };
const func1 = { name: 'testFunc1', args: { a: 1 } };
const func2 = { name: 'testFunc2', args: { b: 2 } };

const minimalMockResponse = (
  candidates: GenerateContentResponse['candidates'],
): GenerateContentResponse => ({
  candidates,
  promptFeedback: { safetyRatings: [] },
  text: undefined,
  data: undefined,
  functionCalls: undefined,
  executableCode: undefined,
  codeExecutionResult: undefined,
});

const mockResponse = (parts: Part[]): GenerateContentResponse =>
  minimalMockResponse([
    {
      content: { parts, role: 'model' },
      index: 0,
      finishReason: FinishReason.STOP,
      safetyRatings: [],
    },
  ]);

describe('generateContentResponseUtilities', () => {
  describe('getResponseTextFromParts', () => {
    it('should return undefined for no parts', () => {
      expect(getResponseTextFromParts([])).toBeUndefined();
    });
    it('should extract text from a single text part', () => {
      expect(getResponseTextFromParts([mockTextPart('Hello')])).toBe('Hello');
    });
    it('should concatenate text from multiple text parts', () => {
      expect(
        getResponseTextFromParts([
          mockTextPart('Hello '),
          mockTextPart('World'),
        ]),
      ).toBe('Hello World');
    });
    it('should ignore function call parts', () => {
      expect(
        getResponseTextFromParts([
          mockTextPart('Hello '),
          fnCall('testFunc', {}),
          mockTextPart('World'),
        ]),
      ).toBe('Hello World');
    });
    it('should return undefined if only function call parts exist', () => {
      expect(
        getResponseTextFromParts([
          fnCall('testFunc', {}),
          fnCall('anotherFunc', {}),
        ]),
      ).toBeUndefined();
    });
  });

  describe('getFunctionCalls', () => {
    it('should return undefined for no candidates', () => {
      expect(getFunctionCalls(minimalMockResponse(undefined))).toBeUndefined();
    });
    it('should return undefined for empty candidates array', () => {
      expect(getFunctionCalls(minimalMockResponse([]))).toBeUndefined();
    });
  });

  // The response form and the parts form share these cases.
  describe.each([
    [
      'getFunctionCalls',
      (parts: Part[]) => getFunctionCalls(mockResponse(parts)),
    ],
    ['getFunctionCallsFromParts', getFunctionCallsFromParts],
  ])('%s', (_name, extract) => {
    it('should return undefined for no parts', () => {
      expect(extract([])).toBeUndefined();
    });
    it('should extract a single function call', () => {
      expect(extract([callPart(func)])).toEqual([func]);
    });
    it('should extract multiple function calls', () => {
      expect(extract([callPart(func1), callPart(func2)])).toEqual([
        func1,
        func2,
      ]);
    });
    it('should ignore text parts', () => {
      expect(
        extract([
          mockTextPart('Some text'),
          callPart(func),
          mockTextPart('More text'),
        ]),
      ).toEqual([func]);
    });
    it('should return undefined if only text parts exist', () => {
      expect(
        extract([mockTextPart('Some text'), mockTextPart('More text')]),
      ).toBeUndefined();
    });
  });

  const twoCallsAroundText = () => [
    callPart(func1),
    mockTextPart('text in between'),
    callPart(func2),
  ];

  describe('getFunctionCallsAsJson', () => {
    it('should return JSON string of function calls', () => {
      expect(getFunctionCallsAsJson(mockResponse(twoCallsAroundText()))).toBe(
        JSON.stringify([func1, func2], null, 2),
      );
    });
    it('should return undefined if no function calls', () => {
      const response = mockResponse([mockTextPart('Hello')]);
      expect(getFunctionCallsAsJson(response)).toBeUndefined();
    });
  });

  describe('getFunctionCallsFromPartsAsJson', () => {
    it('should return JSON string of function calls from parts', () => {
      expect(getFunctionCallsFromPartsAsJson(twoCallsAroundText())).toBe(
        JSON.stringify([func1, func2], null, 2),
      );
    });
    it('should return undefined if no function calls in parts', () => {
      const parts = [mockTextPart('Hello')];
      expect(getFunctionCallsFromPartsAsJson(parts)).toBeUndefined();
    });
  });

  // Same cases for both forms; the parts form's titles end in " in parts".
  describe.each([
    [
      'getStructuredResponse',
      '',
      (parts: Part[]) => getStructuredResponse(mockResponse(parts)),
    ],
    [
      'getStructuredResponseFromParts',
      ' in parts',
      getStructuredResponseFromParts,
    ],
  ])('%s', (_name, inParts, structured) => {
    it(`should return only text if only text exists${inParts}`, () => {
      expect(structured([mockTextPart('Hello World')])).toBe('Hello World');
    });
    it(`should return only function call JSON if only function calls exist${inParts}`, () => {
      const payloadFunc = { name: 'testFunc', args: { data: 'payload' } };
      expect(structured([callPart(payloadFunc)])).toBe(
        JSON.stringify([payloadFunc], null, 2),
      );
    });
    it(`should return text and function call JSON if both exist${inParts}`, () => {
      const text = 'Consider this data:';
      const dataFunc = { name: 'processData', args: { item: 42 } };
      const expectedJson = JSON.stringify([dataFunc], null, 2);
      expect(structured([mockTextPart(text), callPart(dataFunc)])).toBe(
        `${text}\n${expectedJson}`,
      );
    });
    it(`should return undefined if neither text nor function calls exist${inParts}`, () => {
      expect(structured([])).toBeUndefined();
    });
  });

  describe('getToolResponseDisplayText', () => {
    const frPart = (output: unknown, nested?: Part[]): Part => ({
      functionResponse: {
        id: 'call-1',
        name: 'read_file',
        response: output === undefined ? {} : { output },
        ...(nested ? { parts: nested } : {}),
      },
    });

    it('returns undefined for undefined / empty parts', () => {
      expect(getToolResponseDisplayText(undefined)).toBeUndefined();
      expect(getToolResponseDisplayText([])).toBeUndefined();
    });

    it('returns the full functionResponse output text', () => {
      const parts = [frPart('line1\nline2\nline3')];
      expect(getToolResponseDisplayText(parts)).toBe('line1\nline2\nline3');
    });

    it('skips the non-informative "Tool execution succeeded." placeholder', () => {
      expect(
        getToolResponseDisplayText([frPart(TOOL_SUCCEEDED_OUTPUT)]),
      ).toBeUndefined();
    });

    it('emits <media: mime> placeholders for nested inline/file data', () => {
      const parts = [
        frPart(TOOL_SUCCEEDED_OUTPUT, [
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          { fileData: { mimeType: 'application/pdf', fileUri: 'file:///x' } },
        ]),
      ];
      expect(getToolResponseDisplayText(parts)).toBe(
        '<media: image/png>\n<media: application/pdf>',
      );
    });

    it('sanitizes control chars and angle brackets in media placeholders', () => {
      const parts = [
        frPart(TOOL_SUCCEEDED_OUTPUT, [
          { inlineData: { mimeType: 'image/png\x1b[31m<b>', data: 'AAAA' } },
          { fileData: { fileUri: 'file:///x\x07<script>' } },
        ]),
      ];
      // Control bytes and `<`/`>` are stripped so the placeholder stays
      // well-formed and can't inject terminal codes or forge markup.
      expect(getToolResponseDisplayText(parts)).toBe(
        '<media: image/png[31mb>\n<media: file:///xscript>',
      );
    });

    it('concatenates output and nested media, keeping nested text', () => {
      const parts = [
        frPart('main output', [
          { text: 'nested note' },
          { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
        ]),
      ];
      expect(getToolResponseDisplayText(parts)).toBe(
        'main output\nnested note\n<media: image/jpeg>',
      );
    });

    it('keeps text from a plain (non-functionResponse) part', () => {
      expect(getToolResponseDisplayText([{ text: 'plain text' }])).toBe(
        'plain text',
      );
    });

    it('returns undefined when nothing is extractable', () => {
      expect(getToolResponseDisplayText([frPart(undefined)])).toBeUndefined();
    });
  });
});
