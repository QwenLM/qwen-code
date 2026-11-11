/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type ToolResult,
  Kind,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type {
  Question,
  QuestionAnnotation,
  QuestionAnswer,
} from './ask-user-types.js';
import { NOTES_ONLY_ANSWER } from './ask-user-types.js';
import { ASK_USER_TOOL_NAME, ASK_USER_DISPLAY_NAME } from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { createToolParameterDiagnosticData } from './tool-parameter-diagnostics.js';

export interface AskUserParams {
  questions: Question[];
  answers?: Record<string, QuestionAnswer>;
  annotations?: Record<string, QuestionAnnotation>;
  metadata?: { source?: string };
}

const NO_OPTION_SELECTED = '(no option selected)';
const UNIQUENESS_ERROR =
  'Question texts must be unique, option labels must be unique within each question';

function duplicateParameterPath(params: AskUserParams): string {
  const questionTexts = params.questions.map((question) => question.question);
  if (new Set(questionTexts).size !== questionTexts.length) {
    return 'params.questions[].question';
  }

  for (const question of params.questions) {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      return 'params.questions[].options[].label';
    }
  }

  return 'params.questions';
}

function normalizeAnswerValues(params: AskUserParams): void {
  const { answers } = params;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return;
  }

  for (const [question, answer] of Object.entries(answers)) {
    if (
      Array.isArray(answer) &&
      answer.every((value) => typeof value === 'string')
    ) {
      answers[question] = answer.join(', ');
    }
  }
}

function projectKnownFields(params: AskUserParams): void {
  params.questions = params.questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      ...(option.preview === undefined ? {} : { preview: option.preview }),
    })),
    multiSelect: question.multiSelect ?? false,
  }));

  if (params.annotations) {
    params.annotations = Object.fromEntries(
      Object.entries(params.annotations).map(([question, annotation]) => [
        question,
        {
          ...(annotation.preview === undefined
            ? {}
            : { preview: annotation.preview }),
          ...(annotation.notes === undefined ? {} : { notes: annotation.notes }),
        },
      ]),
    );
  }

  if (params.metadata) {
    params.metadata = {
      ...(params.metadata.source === undefined
        ? {}
        : { source: params.metadata.source }),
    };
  }
}

function normalizedAnswers(
  answers: Record<string, QuestionAnswer> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers ?? {}).map(([question, answer]) => [
      question,
      Array.isArray(answer) ? answer.join(', ') : answer,
    ]),
  );
}

export class AskUserTool extends BaseDeclarativeTool<
  AskUserParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = ASK_USER_TOOL_NAME;

  constructor() {
    super(
      AskUserTool.Name,
      ASK_USER_DISPLAY_NAME,
      CORE_TOOL_SET.AskUserQuestion.description!,
      Kind.Communicate,
      CORE_TOOL_SET.AskUserQuestion.parametersJsonSchema,
    );
  }

  override validateToolParams(params: AskUserParams): string | null {
    // Native accepts all-string arrays from permission hosts, then exposes a
    // consistently string-valued record to the rest of the tool lifecycle.
    normalizeAnswerValues(params);
    return super.validateToolParams(params);
  }

  protected override validateToolParamValues(
    params: AskUserParams,
  ): string | null {
    const questionTexts = params.questions.map((question) => question.question);
    if (new Set(questionTexts).size !== questionTexts.length) {
      return UNIQUENESS_ERROR;
    }

    for (const question of params.questions) {
      const labels = question.options.map((option) => option.label);
      if (new Set(labels).size !== labels.length) {
        return UNIQUENESS_ERROR;
      }
    }

    projectKnownFields(params);
    return null;
  }

  protected override createCustomParameterValidationDiagnostic(
    params: AskUserParams,
    validationError: string,
  ) {
    if (validationError === UNIQUENESS_ERROR) {
      return createToolParameterDiagnosticData('custom_semantic', {
        validation_source: 'custom',
        parameter_path: duplicateParameterPath(params),
        constraint_category: 'uniqueness',
        quality: 'precise',
        validation_phase: 'build',
      });
    }
    return super.createCustomParameterValidationDiagnostic(
      params,
      validationError,
    );
  }

  override get isReadOnly(): boolean {
    return true;
  }

  override isConcurrencySafe(): boolean {
    return true;
  }

  override get maxResultSizeChars(): number {
    return 100_000;
  }

  override toClassifierInput(input: AskUserParams): unknown {
    return input.questions
      .map((question) => {
        const header = question.header ? ` [header: ${question.header}]` : '';
        const multiSelect = question.multiSelect ? ' [multiSelect]' : '';
        const options = question.options
          .map((option, index) => {
            const parts = [`(${index + 1}) "${option.label}"`];
            if (option.description) parts.push(`— ${option.description}`);
            if (option.preview) parts.push(`[preview: ${option.preview}]`);
            return parts.join(' ');
          })
          .join(' ');
        return `"${question.question}"${header}${multiSelect} options: ${options}`;
      })
      .join(' | ');
  }

  protected createInvocation(
    params: AskUserParams,
    toolName: string,
    toolDisplayName: string,
  ): AskUserInvocation {
    return new AskUserInvocation(params, toolName, toolDisplayName);
  }

  override async validateBuildAndExecute(
    params: AskUserParams,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const result = await super.validateBuildAndExecute(params, abortSignal);
    if (
      result.error &&
      result.error.type === ToolErrorType.INVALID_TOOL_PARAMS
    ) {
      return {
        ...result,
        returnDisplay: '',
      };
    }
    return result;
  }

  // === Permission Pipeline methods ===


  override requiresUserInteraction(): boolean {
    return true;
  }
}

export class AskUserInvocation extends BaseToolInvocation<
  AskUserParams,
  ToolResult
> {
  getDescription(): string {
    return `Asking user: ${this.params.questions.map((q) => q.question).join(', ')}`;
  }

  /** Reads answers injected by the permission pipeline and returns them. */
  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { questions, annotations } = this.params;
    const answers = normalizedAnswers(this.params.answers);

    const data = {
      questions,
      answers,
      ...(annotations && { annotations }),
    };

    const answerEntries: Array<[string, string]> = [];
    const answersText = questions
      .map(({ question: questionText }) => {
        const answer = answers[questionText];
        const annotation = annotations?.[questionText];
        const hasAnswer = Boolean(answer && answer !== NOTES_ONLY_ANSWER);
        if (!hasAnswer && !annotation?.notes) {
          return null;
        }

        const displayAnswer = hasAnswer ? answer : NO_OPTION_SELECTED;
        answerEntries.push([questionText, displayAnswer]);

        const parts = [
          `"${questionText}"=${hasAnswer ? `"${displayAnswer}"` : displayAnswer}`,
        ];
        if (annotation?.preview) {
          parts.push(`selected preview:\n${annotation.preview}`);
        }
        if (annotation?.notes) {
          parts.push(`notes: ${annotation.notes}`);
        }
        return parts.join(' ');
      })
      .filter((entry): entry is string => entry !== null)
      .join(', ');

    if (!answersText) {
      return {
        llmContent: 'The user did not answer the questions.',
        returnDisplay: 'User submitted without answering questions.',
        data,
        toolUseResult: data,
      };
    }

    return {
      llmContent: `Your questions have been answered: ${answersText}. You can now continue with these answers in mind.`,
      returnDisplay: this.formatReturnDisplay(answerEntries),
      data,
      toolUseResult: data,
    };
  }

  /** Format answer entries into a human-readable display string. */
  private formatReturnDisplay(answerEntries: Array<[string, string]>): string {
    if (answerEntries.length === 0) {
      return 'User submitted without answering questions.';
    }
    const blocks = answerEntries.map(([questionText, answer]) => {
      const question = this.params.questions.find(
        (q) => q.question === questionText,
      );
      const category = question?.header ?? questionText;
      const prefix = `  ${category} → `;
      const indent = ' '.repeat(prefix.length);
      const lines = answer.split('\n');
      const answerLine = prefix + lines.join('\n' + indent);
      return `  Q: ${questionText}\n${answerLine}`;
    });
    return `**User answered:**\n${blocks.join('\n\n')}`;
  }
}

/**
 * Returns true if the tool name and status correspond to a completed 'Ask User' tool call.
 *
 * @deprecated Import from `packages/cli/src/ui/utils/toolConfirmationUtils` instead.
 * This export is retained for backward compatibility with external consumers.
 */
export function isCompletedAskUserTool(name: string, status: string): boolean {
  return (
    name === ASK_USER_DISPLAY_NAME &&
    ['Success', 'Error', 'Canceled'].includes(status)
  );
}
