/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  validateSessionSourceInput,
  type SessionSourceInput,
} from '../services/session-sources.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

class RecordSourceInvocation extends BaseToolInvocation<
  SessionSourceInput,
  ToolResult
> {
  constructor(
    params: SessionSourceInput,
    private readonly config: Config,
  ) {
    super(params);
  }
  getDescription(): string {
    return `Add reference: ${this.params.title}`;
  }
  async execute(): Promise<ToolResult> {
    try {
      const service = this.config.getSessionSourceService();
      if (!service) throw new Error('Session source service unavailable');
      if (this.params.locator.type === 'attachment')
        throw new Error('The tool accepts only workspace files and URLs');
      const { source } = await service.upsert(this.params);
      const message = `Reference added: ${source.id}`;
      return { llmContent: message, returnDisplay: message };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Source registration failed';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

export class RecordSourceTool extends BaseDeclarativeTool<
  SessionSourceInput,
  ToolResult
> {
  static readonly Name = ToolNames.RECORD_SOURCE;
  constructor(private readonly config: Config) {
    super(
      RecordSourceTool.Name,
      ToolDisplayNames.RECORD_SOURCE,
      'Adds a file or HTTP(S) link to this session reference list. Registration stores metadata only: it does not read or send resource contents, and does not prove the assistant used the reference. Use record_artifact for newly produced deliverables.',
      Kind.Other,
      {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'locator'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 1000 },
          locator: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'workspacePath'],
                properties: {
                  type: { type: 'string', const: 'workspace_file' },
                  workspacePath: { type: 'string', maxLength: 500 },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'url'],
                properties: {
                  type: { type: 'string', const: 'url' },
                  url: { type: 'string', maxLength: 2048 },
                },
              },
            ],
          },
        },
      },
      true,
      false,
      true,
      false,
      'source reference file link',
    );
  }
  protected override validateToolParamValues(
    params: SessionSourceInput,
  ): string | null {
    try {
      const input = validateSessionSourceInput(params);
      return input.locator.type === 'attachment'
        ? 'The tool accepts only workspace files and URLs'
        : null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid source';
    }
  }
  protected createInvocation(
    params: SessionSourceInput,
  ): ToolInvocation<SessionSourceInput, ToolResult> {
    return new RecordSourceInvocation(params, this.config);
  }
}
