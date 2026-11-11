/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskUserTool } from './ask-user.js';
import type { Question } from './ask-user-types.js';
import { ToolErrorType } from './tool-error.js';
import { ASK_USER_TOOL_NAME } from './tool-names.js';

describe('AskUserTool', () => {
  let tool: AskUserTool;

  beforeEach(() => {
    tool = new AskUserTool();
  });

  it('should have correct metadata', () => {
    expect(tool.name).toBe(ASK_USER_TOOL_NAME);
    expect(tool.displayName).toBe('AskUserQuestion');
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isConcurrencySafe()).toBe(true);
    expect(tool.maxResultSizeChars).toBe(100_000);
    expect(
      tool.toClassifierInput({
        questions: [
          {
            question: 'First?',
            header: 'First',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
          },
          {
            question: 'Second?',
            header: 'Second',
            multiSelect: true,
            options: [
              { label: 'C', description: 'only the redacted report' },
              { label: 'D', description: 'D', preview: 'diff' },
            ],
          },
        ],
      }),
    ).toBe(
      '"First?" [header: First] options: (1) "A" — A (2) "B" — B | ' +
        '"Second?" [header: Second] [multiSelect] options: ' +
        '(1) "C" — only the redacted report (2) "D" — D [preview: diff]',
    );
  });

  describe('validateToolParams', () => {
    it('should return error if questions is missing', () => {
      // @ts-expect-error - Intentionally invalid params
      const result = tool.validateToolParams({});
      expect(result).toContain("must have required property 'questions'");
    });

    it('should return error if questions array is empty', () => {
      const result = tool.validateToolParams({ questions: [] });
      expect(result).toContain('must NOT have fewer than 1 items');
    });

    it('should return error if questions array exceeds max', () => {
      const questions = Array(5).fill({
        question: 'Test?',
        header: 'Test',
        options: [
          { label: 'A', description: 'A' },
          { label: 'B', description: 'B' },
        ],
        multiSelect: false,
      });
      const result = tool.validateToolParams({ questions });
      expect(result).toContain('must NOT have more than 4 items');
    });

    it('should return error if question field is missing', () => {
      const result = tool.validateToolParams({
        questions: [{ header: 'Test' } as unknown as Question],
      });
      expect(result).toContain("must have required property 'question'");
    });

    it('should return error if header field is missing', () => {
      const result = tool.validateToolParams({
        questions: [{ question: 'Test?' } as unknown as Question],
      });
      expect(result).toContain("must have required property 'header'");
    });

    it('should return error if options has fewer than 2 items', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
      });
      expect(result).toContain('must NOT have fewer than 2 items');
    });

    it('should return error if options has more than 4 items', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
              { label: 'C', description: 'C' },
              { label: 'D', description: 'D' },
              { label: 'E', description: 'E' },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(result).toContain('must NOT have more than 4 items');
    });

    it('should return null for valid params', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should accept newline-wrapped JSON string questions and write back an array', () => {
      const params = {
        questions:
          '\n' +
          JSON.stringify([
            {
              question: 'Which approach?',
              header: 'Approach',
              options: [
                { label: 'A', description: 'Option A' },
                { label: 'B', description: 'Option B' },
              ],
              multiSelect: false,
            },
          ]) +
          '\n',
      } as unknown as Parameters<AskUserTool['validateToolParams']>[0];

      const result = tool.validateToolParams(params);

      expect(result).toBeNull();
      expect(Array.isArray(params.questions)).toBe(true);
      expect(params.questions[0].question).toBe('Which approach?');
    });

    it('should accept pretty-print JSON array string questions and coerce nested scalar values through AJV', () => {
      const params = {
        questions: JSON.stringify(
          [
            {
              question: 'Which features?',
              header: 'Features',
              options: [
                { label: 'TypeScript', description: 'Add static typing' },
                { label: 'ESLint', description: 'Add linting' },
              ],
              multiSelect: 'true',
            },
          ],
          null,
          2,
        ),
      } as unknown as Parameters<AskUserTool['validateToolParams']>[0];

      const result = tool.validateToolParams(params);

      expect(result).toBeNull();
      expect(params.questions[0].multiSelect).toBe(true);
      expect(params.questions[0].options).toEqual([
        { label: 'TypeScript', description: 'Add static typing' },
        { label: 'ESLint', description: 'Add linting' },
      ]);
    });

    it('should reject a single JSON object string for questions', () => {
      const params = {
        questions: JSON.stringify({
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          multiSelect: false,
        }),
      } as unknown as Parameters<AskUserTool['validateToolParams']>[0];

      const result = tool.validateToolParams(params);

      expect(result).toContain('must be array');
    });

    it('should build an invocation with parsed stringified questions', () => {
      const params = {
        questions: JSON.stringify([
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ]),
      } as unknown as Parameters<AskUserTool['build']>[0];

      const invocation = tool.build(params);

      expect(Array.isArray(invocation.params.questions)).toBe(true);
      expect(invocation.params.questions[0].question).toBe('Which approach?');
    });

    it('should return error if options is missing', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            multiSelect: false,
          } as unknown as Question,
        ],
      });
      expect(result).toContain("must have required property 'options'");
    });

    it('should default multiSelect to false when it is missing', () => {
      const params: { questions: Question[] } = {
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      };

      const result = tool.validateToolParams(params);

      expect(result).toBeNull();
      expect(params.questions[0].multiSelect).toBe(false);
    });

    it('should return null for valid multiSelect params', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Which features?',
            header: 'Features',
            options: [
              { label: 'TypeScript', description: 'Add static typing' },
              { label: 'ESLint', description: 'Add linting' },
            ],
            multiSelect: true,
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should accept an empty option label because the schema only requires a string', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: '', description: 'Empty label' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should return error if option is missing description', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: 'A' } as { label: string; description: string },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(result).toContain("must have required property 'description'");
    });

    it('should reject duplicate question texts', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'First',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
          },
          {
            question: 'Pick one?',
            header: 'Second',
            options: [
              { label: 'C', description: 'C' },
              { label: 'D', description: 'D' },
            ],
          },
        ],
      });

      expect(result).toBe(
        'Question texts must be unique, option labels must be unique within each question',
      );
    });

    it('classifies duplicate questions without reporting question or option text', () => {
      const privateQuestion = 'Private deployment choice?';
      let thrown: unknown;
      try {
        tool.build({
          questions: [
            {
              question: privateQuestion,
              header: 'Private header',
              options: [
                { label: 'Private A', description: 'Private description A' },
                { label: 'Private B', description: 'Private description B' },
              ],
            },
            {
              question: privateQuestion,
              header: 'Another private header',
              options: [
                { label: 'Private C', description: 'Private description C' },
                { label: 'Private D', description: 'Private description D' },
              ],
            },
          ],
        });
      } catch (error) {
        thrown = error;
      }

      const data = (thrown as Error & { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        tool_error_stage: 'parameter_validation',
        tool_error_subtype: 'custom_semantic',
      });
      expect(JSON.parse(data['tool_error_details_json'] as string)).toEqual({
        schema_version: 1,
        validation_source: 'custom',
        parameter_path: 'params.questions[].question',
        constraint_category: 'uniqueness',
        quality: 'precise',
        validation_phase: 'build',
      });
      expect(JSON.stringify(data)).not.toContain('Private');
    });

    it('should reject duplicate option labels within one question', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: 'Same', description: 'First' },
              { label: 'Same', description: 'Second' },
            ],
          },
        ],
      });

      expect(result).toBe(
        'Question texts must be unique, option labels must be unique within each question',
      );
    });

    it('classifies duplicate option labels at the option label path', () => {
      const privateLabel = 'Private duplicate label';
      let thrown: unknown;
      try {
        tool.build({
          questions: [
            {
              question: 'Private question?',
              header: 'Private header',
              options: [
                { label: privateLabel, description: 'First private option' },
                { label: privateLabel, description: 'Second private option' },
              ],
            },
          ],
        });
      } catch (error) {
        thrown = error;
      }

      const data = (thrown as Error & { data: Record<string, unknown> }).data;
      expect(JSON.parse(data['tool_error_details_json'] as string)).toEqual({
        schema_version: 1,
        validation_source: 'custom',
        parameter_path: 'params.questions[].options[].label',
        constraint_category: 'uniqueness',
        quality: 'precise',
        validation_phase: 'build',
      });
      expect(JSON.stringify(data)).not.toContain(privateLabel);
    });

    it('should compare uniqueness using the original case-sensitive strings', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'First',
            options: [
              { label: 'Same', description: 'First' },
              { label: 'same', description: 'Second' },
            ],
          },
          {
            question: 'Pick one? ',
            header: 'Second',
            options: [
              { label: 'Same', description: 'First' },
              { label: 'Other', description: 'Second' },
            ],
          },
        ],
      });

      expect(result).toBeNull();
    });

    it('should normalize all-string answer arrays before schema validation', () => {
      const params = {
        questions: [
          {
            question: 'Which features?',
            header: 'Features',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: true,
          },
        ],
        answers: { 'Which features?': ['A', 'B'] },
      };

      const result = tool.validateToolParams(params);

      expect(result).toBeNull();
      expect(params.answers['Which features?']).toBe('A, B');
    });

    it('should strip unknown nested fields while retaining known fields', () => {
      const params = {
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            ignoredQuestionField: true,
            options: [
              {
                label: 'A',
                description: 'A',
                preview: 'preview A',
                ignoredOptionField: true,
              },
              { label: 'B', description: 'B' },
            ],
          },
        ],
        annotations: {
          'Pick one?': {
            preview: 'preview A',
            notes: 'note',
            ignoredAnnotationField: true,
          },
        },
        metadata: { source: 'test', ignoredMetadataField: true },
      } as unknown as Parameters<AskUserTool['validateToolParams']>[0];

      const result = tool.validateToolParams(params);

      expect(result).toBeNull();
      expect(params.questions).toEqual([
        {
          question: 'Pick one?',
          header: 'Choice',
          options: [
            { label: 'A', description: 'A', preview: 'preview A' },
            { label: 'B', description: 'B' },
          ],
          multiSelect: false,
        },
      ]);
      expect(params.annotations).toEqual({
        'Pick one?': { preview: 'preview A', notes: 'note' },
      });
      expect(params.metadata).toEqual({ source: 'test' });
    });
  });

  describe('validateBuildAndExecute', () => {
    it('should hide validation errors from returnDisplay', async () => {
      const params = {
        questions: [],
      };

      const result = await tool.validateBuildAndExecute(
        params,
        new AbortController().signal,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
      expect(result.returnDisplay).toBe('');
    });

    it('should NOT hide non-validation errors (if any were to occur)', async () => {
      const validateParamsSpy = vi
        .spyOn(tool, 'validateToolParams')
        .mockReturnValue(null);

      const params = {
        questions: [
          {
            question: 'Valid?',
            header: 'Valid',
            options: [
              { label: 'Yes', description: 'Confirm' },
              { label: 'No', description: 'Deny' },
            ],
            multiSelect: false,
          },
        ],
      };

      const mockInvocation = {
        execute: vi.fn().mockRejectedValue(new Error('Some execution error')),
        params,
        getDescription: vi.fn().mockReturnValue(''),
        toolLocations: vi.fn().mockReturnValue([]),
      };

      const buildSpy = vi.spyOn(tool, 'build').mockReturnValue(mockInvocation);

      const result = await tool.validateBuildAndExecute(
        params,
        new AbortController().signal,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(result.returnDisplay).toBe('Some execution error');

      buildSpy.mockRestore();
      validateParamsSpy.mockRestore();
    });

    it('should return structured toolUseResult for answer rendering', async () => {
      const question = {
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        multiSelect: false,
      };
      const params = {
        questions: [question],
        answers: {
          'Which approach?': 'A',
        },
      };

      const result = await tool.validateBuildAndExecute(
        params,
        new AbortController().signal,
      );

      expect(result.toolUseResult).toEqual({
        questions: [question],
        answers: {
          'Which approach?': 'A',
        },
      });
    });

    it('should serialize answers in question order and ignore extra keys', async () => {
      const result = await tool.validateBuildAndExecute(
        {
          questions: [
            {
              question: 'First?',
              header: 'First',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
            },
            {
              question: 'Second?',
              header: 'Second',
              options: [
                { label: 'C', description: 'C' },
                { label: 'D', description: 'D' },
              ],
            },
          ],
          answers: {
            'Second?': 'D',
            'Not asked?': 'ignored',
            'First?': 'A',
          },
        },
        new AbortController().signal,
      );

      expect(result.llmContent).toBe(
        'Your questions have been answered: "First?"="A", "Second?"="D". You can now continue with these answers in mind.',
      );
    });

    it('should preserve preview annotations and notes-only answers', async () => {
      const result = await tool.validateBuildAndExecute(
        {
          questions: [
            {
              question: 'Which layout?',
              header: 'Layout',
              options: [
                { label: 'A', description: 'A', preview: 'layout A' },
                { label: 'B', description: 'B', preview: 'layout B' },
              ],
            },
          ],
          answers: { 'Which layout?': '(notes only)' },
          annotations: {
            'Which layout?': {
              preview: 'layout A',
              notes: 'Use denser spacing',
            },
          },
        },
        new AbortController().signal,
      );

      expect(result.llmContent).toBe(
        'Your questions have been answered: "Which layout?"=(no option selected) selected preview:\nlayout A notes: Use denser spacing. You can now continue with these answers in mind.',
      );
    });

    it('should report a normal empty submission without calling it a dismissal', async () => {
      const result = await tool.validateBuildAndExecute(
        {
          questions: [
            {
              question: 'Pick one?',
              header: 'Choice',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
            },
          ],
        },
        new AbortController().signal,
      );

      expect(result.llmContent).toBe('The user did not answer the questions.');
      expect(result.returnDisplay).toBe(
        'User submitted without answering questions.',
      );
    });
  });
});
