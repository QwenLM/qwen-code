/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolAskUserQuestionConfirmationDetails,
  ToolConfirmationPayload,
  ToolResult,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('ASK_USER_QUESTION');

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionParams {
  questions: Question[];
  answers?: Record<string, string>;
  metadata?: {
    source?: string;
  };
}

const askUserQuestionToolDescription = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is this plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval.
`;

const askUserQuestionToolSchemaData: FunctionDeclaration = {
  name: 'ask_user_question',
  description: askUserQuestionToolDescription,
  parametersJsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      questions: {
        description: 'Questions to ask the user (1-4 questions)',
        minItems: 1,
        maxItems: 4,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: {
              description:
                'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
              type: 'string',
            },
            header: {
              description:
                'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
              type: 'string',
            },
            options: {
              description:
                "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
              minItems: 2,
              maxItems: 4,
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: {
                    description:
                      'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
                    type: 'string',
                  },
                  description: {
                    description:
                      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
                    type: 'string',
                  },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiSelect: {
              description:
                'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
              default: false,
              type: 'boolean',
            },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false,
        },
      },
      answers: {
        description: 'User answers collected by the permission component',
        type: 'object',
        propertyNames: {
          type: 'string',
        },
        additionalProperties: {
          type: 'string',
        },
      },
      metadata: {
        description:
          'Optional metadata for tracking and analytics purposes. Not displayed to user.',
        type: 'object',
        properties: {
          source: {
            description:
              'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
            type: 'string',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

class AskUserQuestionToolInvocation extends BaseToolInvocation<
  AskUserQuestionParams,
  ToolResult
> {
  private userAnswers: Record<string, string> = {};
  private wasAnswered = false;

  constructor(
    private readonly _config: Config,
    params: AskUserQuestionParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const questionCount = this.params.questions.length;
    return `Ask user ${questionCount} question${questionCount > 1 ? 's' : ''}`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolAskUserQuestionConfirmationDetails | false> {
    if (!this._config.isInteractive()) {
      // In non-interactive mode, we cannot collect user input
      return false;
    }

    const details: ToolAskUserQuestionConfirmationDetails = {
      type: 'ask_user_question',
      title: 'Please answer the following question(s):',
      questions: this.params.questions,
      metadata: this.params.metadata,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => {
        switch (outcome) {
          case ToolConfirmationOutcome.ProceedOnce:
          case ToolConfirmationOutcome.ProceedAlways:
            this.wasAnswered = true;
            this.userAnswers = payload?.answers ?? {};
            break;
          case ToolConfirmationOutcome.Cancel:
            this.wasAnswered = false;
            break;
          default:
            this.wasAnswered = true;
            this.userAnswers = payload?.answers ?? {};
            break;
        }
      },
    };

    return details;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    try {
      // In non-interactive mode, we cannot collect user input
      if (!this._config.isInteractive()) {
        const errorMessage =
          'Cannot ask user questions in non-interactive mode. Please run in interactive mode to use this tool.';
        return {
          llmContent: errorMessage,
          returnDisplay: errorMessage,
        };
      }

      if (!this.wasAnswered) {
        const cancellationMessage = 'User declined to answer the questions.';
        return {
          llmContent: cancellationMessage,
          returnDisplay: cancellationMessage,
        };
      }

      // Format the answers for LLM consumption
      const answersContent = Object.entries(this.userAnswers)
        .map(([key, value]) => {
          const questionIndex = parseInt(key, 10);
          const question = this.params.questions[questionIndex];
          return `**${question?.header || `Question ${questionIndex + 1}`}**: ${value}`;
        })
        .join('\n');

      const llmMessage = `User has provided the following answers:\n\n${answersContent}`;
      const displayMessage = `User has provided the following answers:\n\n${answersContent}`;

      return {
        llmContent: llmMessage,
        returnDisplay: displayMessage,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[AskUserQuestionTool] Error executing ask_user_question: ${errorMessage}`,
      );

      const errorLlmContent = `Failed to process user answers: ${errorMessage}`;

      return {
        llmContent: errorLlmContent,
        returnDisplay: `Error processing answers: ${errorMessage}`,
      };
    }
  }
}

export class AskUserQuestionTool extends BaseDeclarativeTool<
  AskUserQuestionParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.ASK_USER_QUESTION;

  constructor(private readonly config: Config) {
    super(
      AskUserQuestionTool.Name,
      ToolDisplayNames.ASK_USER_QUESTION,
      askUserQuestionToolDescription,
      Kind.Think,
      askUserQuestionToolSchemaData.parametersJsonSchema as Record<
        string,
        unknown
      >,
    );
  }

  override validateToolParams(params: AskUserQuestionParams): string | null {
    // Validate questions array
    if (!Array.isArray(params.questions)) {
      return 'Parameter "questions" must be an array.';
    }

    if (params.questions.length < 1 || params.questions.length > 4) {
      return 'Parameter "questions" must contain between 1 and 4 questions.';
    }

    // Validate individual questions
    for (let i = 0; i < params.questions.length; i++) {
      const question = params.questions[i];

      if (
        !question.question ||
        typeof question.question !== 'string' ||
        question.question.trim() === ''
      ) {
        return `Question ${i + 1}: "question" must be a non-empty string.`;
      }

      if (
        !question.header ||
        typeof question.header !== 'string' ||
        question.header.trim() === ''
      ) {
        return `Question ${i + 1}: "header" must be a non-empty string.`;
      }

      if (question.header.length > 12) {
        return `Question ${i + 1}: "header" must be 12 characters or less.`;
      }

      if (!Array.isArray(question.options)) {
        return `Question ${i + 1}: "options" must be an array.`;
      }

      if (question.options.length < 2 || question.options.length > 4) {
        return `Question ${i + 1}: "options" must contain between 2 and 4 options.`;
      }

      // Validate options
      for (let j = 0; j < question.options.length; j++) {
        const option = question.options[j];

        if (
          !option.label ||
          typeof option.label !== 'string' ||
          option.label.trim() === ''
        ) {
          return `Question ${i + 1}, Option ${j + 1}: "label" must be a non-empty string.`;
        }

        if (
          !option.description ||
          typeof option.description !== 'string' ||
          option.description.trim() === ''
        ) {
          return `Question ${i + 1}, Option ${j + 1}: "description" must be a non-empty string.`;
        }
      }

      if (typeof question.multiSelect !== 'boolean') {
        return `Question ${i + 1}: "multiSelect" must be a boolean.`;
      }
    }

    return null;
  }

  protected createInvocation(params: AskUserQuestionParams) {
    return new AskUserQuestionToolInvocation(this.config, params);
  }
}
