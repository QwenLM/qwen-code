/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import type { Config } from '../config/config.js';
import { getAgentContext } from '../utils/agentContext.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { Question } from './ask-user-types.js';
import {
  createQuestionUniquenessDiagnostic,
  findQuestionUniquenessError,
  projectQuestions,
  UNIQUENESS_ERROR,
} from './ask-user.js';
import {
  ASK_USER_ASYNC_DISPLAY_NAME,
  ASK_USER_ASYNC_TOOL_NAME,
} from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import { getAskUserAsyncPlanNote } from './definitions/tool-prompts/index.js';

export interface AskUserAsyncParams {
  questions: Question[];
}

export type AskUserAsyncPublished = {
  status: 'published';
  questions: Question[];
};

export const ASK_USER_ASYNC_PUBLISHED_LLM_CONTENT =
  'Questions published. No user answer has been received. Replies will arrive as new user messages.';
export const ASK_USER_ASYNC_PUBLISHED_DISPLAY = 'Questions published.';
export const MAIN_SESSION_ONLY_ERROR = 'is only available in the main session.';

class AskUserAsyncInvocation extends BaseToolInvocation<
  AskUserAsyncParams,
  ToolResult
> {
  getDescription(): string {
    return `Publishing questions: ${this.params.questions.map((q) => q.question).join(', ')}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (getAgentContext() !== undefined) {
      const message = `${ASK_USER_ASYNC_TOOL_NAME} ${MAIN_SESSION_ONLY_ERROR}`;
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
    const published: AskUserAsyncPublished = {
      status: 'published',
      questions: this.params.questions,
    };
    return {
      llmContent: ASK_USER_ASYNC_PUBLISHED_LLM_CONTENT,
      returnDisplay: ASK_USER_ASYNC_PUBLISHED_DISPLAY,
      data: published,
      toolUseResult: published,
    };
  }
}

export class AskUserAsyncTool extends BaseDeclarativeTool<
  AskUserAsyncParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = ASK_USER_ASYNC_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      AskUserAsyncTool.Name,
      ASK_USER_ASYNC_DISPLAY_NAME,
      CORE_TOOL_SET.AskUserQuestionAsync.description!,
      Kind.Communicate,
      CORE_TOOL_SET.AskUserQuestionAsync.parametersJsonSchema,
    );
  }

  override getSchema(modelId?: string): FunctionDeclaration {
    const schema = super.getSchema(modelId);
    if (!this.config.isAsyncUserInteractionEnabled()) {
      return schema;
    }
    return {
      ...schema,
      description: `${schema.description}${getAskUserAsyncPlanNote()}`,
    };
  }

  protected override validateToolParamValues(
    params: AskUserAsyncParams,
  ): string | null {
    const uniquenessError = findQuestionUniquenessError(params.questions);
    if (uniquenessError) {
      return uniquenessError;
    }
    params.questions = projectQuestions(params.questions);
    return null;
  }

  protected override createCustomParameterValidationDiagnostic(
    params: AskUserAsyncParams,
    validationError: string,
  ) {
    if (validationError === UNIQUENESS_ERROR) {
      return createQuestionUniquenessDiagnostic(params.questions);
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

  // A publishing host must render questions and route replies as user messages.
  override requiresUserInteraction(): boolean {
    return true;
  }

  protected createInvocation(
    params: AskUserAsyncParams,
    toolName: string,
    toolDisplayName: string,
  ): AskUserAsyncInvocation {
    return new AskUserAsyncInvocation(params, toolName, toolDisplayName);
  }
}
