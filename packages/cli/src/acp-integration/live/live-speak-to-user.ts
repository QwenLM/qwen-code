/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type PermissionDecision,
  type ToolInvocation,
  type ToolResult,
} from '@qwen-code/qwen-code-core';

export const SPEAK_TO_USER_TOOL_NAME = 'speak_to_user' as const;
export const MAX_SPEAK_TO_USER_MESSAGE_CHARS = 32_000;

export interface SpeakToUserParams {
  message: string;
}

export type SpeakToUserExecutor = (message: string) => Promise<void | boolean>;

class SpeakToUserInvocation extends BaseToolInvocation<
  SpeakToUserParams,
  ToolResult
> {
  constructor(
    params: SpeakToUserParams,
    private readonly speak: SpeakToUserExecutor,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Speak an important Live update';
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve('allow');
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const delivered = await this.speak(this.params.message);
    signal.throwIfAborted();
    if (delivered === false) {
      return {
        llmContent:
          'Voice disconnected before this update could be spoken. Continue the task and include this update in the final text response. Do not retry speech until a new voice call is active.',
        returnDisplay: `Voice disconnected; update not spoken: ${this.params.message}`,
      };
    }
    return {
      llmContent: 'The voice update was sent.',
      returnDisplay: 'Spoke to user',
    };
  }
}

export class SpeakToUserTool extends BaseDeclarativeTool<
  SpeakToUserParams,
  ToolResult
> {
  constructor(private readonly speak: SpeakToUserExecutor) {
    super(
      SPEAK_TO_USER_TOOL_NAME,
      'SpeakToUser',
      'Speak an important voice chat update to the user. Use this sparingly ' +
        'and only during an active voice chat. Automatic backend Qwen Code ' +
        'text is silent context and is not automatically spoken. The message ' +
        'is spoken verbatim by the voice model, so write it for speech. Final ' +
        'assistant text is not automatically spoken; call this tool if the ' +
        'user should hear something.',
      Kind.Other,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SPEAK_TO_USER_MESSAGE_CHARS,
          },
        },
        required: ['message'],
      },
      true,
      false,
      false,
      true,
    );
  }

  protected createInvocation(
    params: SpeakToUserParams,
  ): ToolInvocation<SpeakToUserParams, ToolResult> {
    return new SpeakToUserInvocation(params, this.speak);
  }
}
