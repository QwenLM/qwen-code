/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { refreshMemoryInstruction } from '../memory/refresh.js';
import { runManagedRememberByAgent } from '../memory/remember.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

interface ManageMemoryToolParams {
  action: 'remember' | 'forget';
  content: string;
}

const MANAGE_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['remember', 'forget'],
      description: 'remember creates or updates; forget removes',
    },
    content: {
      type: 'string',
      description: 'durable fact to remember/update, or memory to forget',
    },
  },
  required: ['action', 'content'],
  additionalProperties: false,
} as const;

class ManageMemoryToolInvocation extends BaseToolInvocation<
  ManageMemoryToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ManageMemoryToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.action === 'remember' ? 'Update' : 'Forget'} memory`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (this.config.getMemoryRecallMode() !== 'structured') {
      return denied(
        'manage_memory is unavailable while the legacy memory protocol is active.',
      );
    }

    const projectRoot = this.config.getProjectRoot();
    if (this.params.action === 'remember') {
      const result = await runManagedRememberByAgent({
        config: this.config,
        projectRoot,
        content: this.params.content,
        contextMode: 'clean',
        abortSignal: signal,
      });
      if (result.filesTouched.length > 0) {
        await refreshMemoryInstruction(this.config, {
          logContext: 'manage_memory remember',
        });
      }
      return response({
        action: this.params.action,
        updated: result.filesTouched.length,
        touchedScopes: result.touchedScopes,
      });
    }

    const result = await this.config
      .getMemoryManager()
      .forget(projectRoot, this.params.content, {
        config: this.config,
        abortSignal: signal,
      });
    if (result.removedEntries.length > 0) {
      await refreshMemoryInstruction(this.config, {
        logContext: 'manage_memory forget',
      });
    }
    return response({
      action: this.params.action,
      removed: result.removedEntries.length,
      touchedScopes: result.touchedScopes,
    });
  }
}

function response(value: Record<string, unknown>): ToolResult {
  const content = JSON.stringify(value);
  return { llmContent: content, returnDisplay: content };
}

function denied(message: string): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type: ToolErrorType.EXECUTION_DENIED },
  };
}

export class ManageMemoryTool extends BaseDeclarativeTool<
  ManageMemoryToolParams,
  ToolResult
> {
  constructor(private readonly config: Config) {
    super(
      ToolNames.MANAGE_MEMORY,
      ToolDisplayNames.MANAGE_MEMORY,
      'Use only when the user asks to remember, update, or forget something. Never save information merely learned while doing another task. remember creates or updates; forget removes.',
      Kind.Edit,
      MANAGE_MEMORY_SCHEMA,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: ManageMemoryToolParams,
  ): string | null {
    if (!params.content?.trim()) return 'content must not be empty.';
    return null;
  }

  protected createInvocation(
    params: ManageMemoryToolParams,
  ): ToolInvocation<ManageMemoryToolParams, ToolResult> {
    return new ManageMemoryToolInvocation(this.config, {
      ...params,
      content: params.content.trim(),
    });
  }
}
