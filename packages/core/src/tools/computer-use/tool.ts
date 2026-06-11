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
import { ApprovalMode, type Config } from '../../config/config.js';
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
    private readonly config?: Config,
  ) {
    super(params);
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  /**
   * Always returns 'ask' so every desktop action surfaces through the
   * standard tool-permission dialog. The PermissionManager rule system
   * handles "always allow" per tool via ProceedAlwaysTool — that's the
   * single source of truth for repeat-approval behavior.
   *
   * Earlier this returned 'allow' once the install-state file existed,
   * which conflated install approval with per-action approval and
   * effectively granted blanket permission for all 9 computer_use__*
   * tools (including mutating actions like click / type_text / drag)
   * after the first install confirmation. See PR #4590 review for the
   * full discussion.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  /**
   * Builds the confirmation dialog. Two variants:
   *
   * 1. Install not yet approved → show install info (download size,
   *    permission flow to follow). onConfirm writes the install state
   *    so runBootstrap() inside execute() skips its env-var fallback
   *    prompt for headless contexts.
   *
   * 2. Install already approved → show per-action info (which tool +
   *    which args) so the user can decide whether THIS specific action
   *    is OK to perform.
   *
   * Both variants set permissionRules so the standard "Always allow"
   * outcomes (ProceedAlwaysTool / ProceedAlwaysUser / ProceedAlwaysProject)
   * add a rule via PermissionManager — subsequent calls of the SAME
   * tool then skip the dialog. Different tools each need their own
   * "always allow" choice; install approval no longer grants blanket
   * access.
   *
   * On Cancel: install state is NOT written; execute() / runBootstrap()
   * will use the env-var fallback (QWEN_COMPUTER_USE_AUTO_APPROVE),
   * which defaults to refusing — producing a clear error message.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const permissionRules = [`computer_use__${this.upstreamName}`];
    const installApproved = await isPackageSpecApproved(
      homedir(),
      resolveComputerUsePackageSpec(),
    );

    const prompt = installApproved
      ? `Tool: computer_use__${this.upstreamName}\n\nArgs: ${safeJsonStringify(this.params)}\n\nThis will act on your desktop via the Computer Use binary.`
      : `Tool: computer_use__${this.upstreamName}\n\n${INSTALL_REASON}`;

    const details: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Allow Computer Use (${this.upstreamName})`,
      prompt,
      permissionRules,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // Any non-Cancel outcome means the user approved THIS call.
        // Write install state (idempotent if already exists) so the
        // bootstrap state machine in runBootstrap() can skip its env-var
        // fallback prompt path. PermissionManager handles per-tool
        // "always allow" via the permissionRules above — install state
        // is no longer a blanket permission grant.
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
    // But several approval modes auto-approve the tool call and bypass that
    // dialog entirely (so onConfirm never runs and install state is never
    // written): YOLO (needsConfirmation() returns false), AUTO_EDIT
    // (isAutoEditApproved() auto-approves info-type tools — all computer_use__*
    // tools are info), and AUTO (classifier-approved calls). In those modes
    // pass autoApproveInstall so the bootstrap honors the already-granted call
    // approval instead of refusing with "install declined by user". DEFAULT
    // still shows the dialog; PLAN blocks. Headless / SDK contexts (no config)
    // fall back to the env-var path in bootstrap's default promptInstallApproval.
    const mode = this.config?.getApprovalMode();
    const autoApproveInstall =
      mode === ApprovalMode.YOLO ||
      mode === ApprovalMode.AUTO_EDIT ||
      mode === ApprovalMode.AUTO;
    await runBootstrap(client, { signal, updateOutput, autoApproveInstall });

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
    private readonly config?: Config,
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
   * Coerce parameter types before schema validation.
   * Models can send the wrong JS type for a field:
   *  - qwen3.6 sends `element_index: 2` (number) but upstream wants "2" (string)
   *  - Some models send `x: "500"` (string) but upstream wants 500 (number)
   * Pre-coercing avoids spurious validation failures without loosening schema types.
   */
  override validateToolParams(params: ComputerUseParams): string | null {
    const coerced = coerceTypes(
      params,
      this.parameterSchema as Record<string, unknown>,
    );
    return super.validateToolParams(coerced as ComputerUseParams);
  }

  override build(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    const coerced = coerceTypes(
      params,
      this.parameterSchema as Record<string, unknown>,
    );
    return super.build(coerced as ComputerUseParams);
  }

  protected createInvocation(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    return new ComputerUseInvocation(this.upstreamName, params, this.config);
  }
}

/**
 * Walk schema properties and coerce values to the type declared by the schema.
 *
 * Direction 1 (string → number): schema says integer/number, model sent a
 * numeric string (e.g. `x: "500"`). Garbage strings are left untouched so
 * they still fail schema validation with a clear error.
 *
 * Direction 2 (number → string): schema says string, model sent a number
 * (e.g. `element_index: 2` when upstream expects `"2"`). Coerce via String().
 */
export function coerceTypes(
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
    // Direction 1: string value, schema wants integer/number → parse
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
    // Direction 2: number value, schema wants string → stringify
    // (qwen3.6 sometimes sends element_index: 2 instead of "2")
    else if (fieldType === 'string' && typeof value === 'number') {
      result[key] = String(value);
    }
  }
  return result;
}

/**
 * @deprecated Use coerceTypes instead. Kept for backward compatibility.
 */
export const coerceNumericStrings = coerceTypes;

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
