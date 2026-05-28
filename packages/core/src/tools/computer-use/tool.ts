/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
  type ToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
} from '../tools.js';
import type { PermissionDecision } from '../../permissions/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Part, PartListUnion } from '@google/genai';
import { ComputerUseClient } from './client.js';
import type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { runBootstrap } from './bootstrap.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import { resolveComputerUsePackageSpec } from './constants.js';
import { homedir } from 'node:os';

type ComputerUseParams = Record<string, unknown>;

const INSTALL_REASON =
  'This will install the open-computer-use binary (~50MB) via npx the first time. ' +
  'Computer Use can click, type, and read your desktop apps. ' +
  "On macOS you'll be guided through Accessibility / Screen Recording permissions next.";

class ComputerUseInvocation extends BaseToolInvocation<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    params: ComputerUseParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  /**
   * Returns 'ask' on first use so the scheduler surfaces the install
   * confirmation dialog BEFORE execute() is called. Returns 'allow' once the
   * install state file exists (subsequent invocations after first-time setup).
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const approved = await isPackageSpecApproved(
      homedir(),
      resolveComputerUsePackageSpec(),
    );
    return approved ? 'allow' : 'ask';
  }

  /**
   * Builds the install-approval confirmation dialog.
   *
   * onConfirm writes the install state file so that runBootstrap() inside
   * execute() sees isPackageSpecApproved === true and skips its own prompt.
   * On Cancel the install state is NOT written; execute() will use the
   * env-var fallback (QWEN_COMPUTER_USE_AUTO_APPROVE) which defaults to
   * refusing — producing a clear error message.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const permissionRules = [`computer_use__${this.upstreamName}`];

    const details: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Allow Computer Use (${this.upstreamName})`,
      prompt: `Tool: computer_use__${this.upstreamName}\n\n` + INSTALL_REASON,
      permissionRules,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // Any non-Cancel outcome means the user approved.
        // Write the install state so execute() / runBootstrap() can proceed
        // without re-prompting.
        if (outcome !== ToolConfirmationOutcome.Cancel) {
          await saveInstallState(homedir(), {
            approvedPackageSpec: resolveComputerUsePackageSpec(),
            approvedAtIso: new Date().toISOString(),
          });
        }
      },
    };
    return details;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const client = ComputerUseClient.shared();

    // If the user confirmed through the pre-execution dialog, the install state
    // was already written by onConfirm — runBootstrap will skip promptInstallApproval.
    // For headless / SDK contexts (no dialog), fall back to the env-var path
    // already built into bootstrap's default promptInstallApproval.
    await runBootstrap(client, { signal, updateOutput });

    let mcpResult: CallToolResult;
    try {
      mcpResult = await client.callTool(this.upstreamName, this.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Computer Use tool '${this.upstreamName}' failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }

    // Transform MCP content blocks into GenAI Parts, preserving image/audio
    // parts so the model can actually "see" screenshots from get_app_state.
    // NOTE: mcp-tool.ts has an analogous private transformation (transformMcpContentToParts /
    // transformImageAudioBlock); those helpers are not exported so we replicate
    // the pattern here. A future PR should extract a shared utility.
    const llmContent = buildLlmContent(mcpResult.content, this.upstreamName);
    const returnDisplay = buildDisplayText(mcpResult.content);

    if (mcpResult.isError) {
      const errorText =
        returnDisplay || `Tool '${this.upstreamName}' returned isError=true`;
      return {
        llmContent: llmContent || errorText,
        returnDisplay: errorText,
        error: { message: errorText },
      };
    }

    return {
      llmContent,
      returnDisplay,
    };
  }
}

export class ComputerUseTool extends BaseDeclarativeTool<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    schema: ComputerUseToolSchema,
  ) {
    const qwenName = `computer_use__${upstreamName}`;
    super(
      qwenName,
      qwenName, // displayName == name; no MCP branding in UI
      schema.description,
      Kind.Other,
      schema.parameterSchema,
      true, // isOutputMarkdown — many results are JSON-ish text or screenshots
      true, // canUpdateOutput — bootstrap streams progress
      true, // shouldDefer — surface only via ToolSearch
      false, // alwaysLoad
      `computer use desktop click type screenshot mouse keyboard scroll drag automation gui app native`,
    );
  }

  /**
   * Coerce numeric strings to actual numbers before schema validation.
   * Some models (e.g. qwen3.6) produce JSON like `{"element_index": "11"}`
   * even when the schema declares `type: "integer"`. Pre-coercing avoids
   * spurious validation failures without loosening the schema types.
   */
  override validateToolParams(params: ComputerUseParams): string | null {
    const coerced = coerceNumericStrings(
      params,
      this.parameterSchema as Record<string, unknown>,
    );
    return super.validateToolParams(coerced as ComputerUseParams);
  }

  override build(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    const coerced = coerceNumericStrings(
      params,
      this.parameterSchema as Record<string, unknown>,
    );
    return super.build(coerced as ComputerUseParams);
  }

  protected createInvocation(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    return new ComputerUseInvocation(this.upstreamName, params);
  }
}

/**
 * Walk schema properties and coerce string values to integers/numbers when the
 * schema declares `type: 'integer'` or `type: 'number'` and the value is a
 * clean numeric string. Garbage strings (e.g. "abc") are left untouched so
 * they still fail schema validation with a clear error.
 */
export function coerceNumericStrings(
  params: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (
    schema as { properties?: Record<string, { type?: string }> }
  ).properties;
  if (!properties) return params;
  const result: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(result)) {
    const fieldType = properties[key]?.type;
    if (
      (fieldType === 'integer' || fieldType === 'number') &&
      typeof value === 'string'
    ) {
      const trimmed = value.trim();
      // Only coerce if the string is a clean numeric — don't swallow garbage.
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const parsed =
          fieldType === 'integer' ? parseInt(trimmed, 10) : parseFloat(trimmed);
        if (Number.isFinite(parsed)) {
          result[key] = parsed;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Content transformation helpers
// ---------------------------------------------------------------------------

type RawContentBlock = CallToolResult['content'][number];

/**
 * Converts MCP content blocks to a GenAI PartListUnion.
 * - Text-only results → plain string (preserves existing caller expectations).
 * - Mixed or image/audio results → Part[] so the model can see screenshots.
 */
export function buildLlmContent(
  content: RawContentBlock[],
  toolName: string,
): PartListUnion {
  const parts: Part[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push({ text: block.text });
    } else if (
      (block.type === 'image' || block.type === 'audio') &&
      block.mimeType &&
      block.data
    ) {
      parts.push({
        text: `[Tool '${toolName}' provided the following ${block.type} data with mime-type: ${block.mimeType}]`,
      });
      parts.push({
        inlineData: {
          mimeType: block.mimeType,
          data: block.data,
        },
      });
    }
    // Other block types (resource, resource_link, etc.) are currently ignored
    // for computer-use; extend here if the MCP server introduces them.
  }

  // If every part is a text Part, collapse to a plain string so callers that
  // do string operations on llmContent (e.g. error-path concatenation) keep
  // working without changes.
  const hasNonText = parts.some((p) => p.inlineData !== undefined);
  if (!hasNonText) {
    return parts
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('\n');
  }

  return parts;
}

/**
 * Builds the human-readable display string (text only, no binary data).
 */
export function buildDisplayText(content: RawContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
