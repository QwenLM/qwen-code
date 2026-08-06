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
import { COMPUTER_USE_SCHEMAS } from './schemas.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { runBootstrap } from './bootstrap.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import { approvalKey, resolveMaxImageDimension } from './constants.js';
import { type Config } from '../../config/config.js';
import { homedir } from 'node:os';

type ComputerUseParams = Record<string, unknown>;

const INSTALL_REASON =
  'This downloads the pinned Qwen CUA driver into ~/.qwen/computer-use/ the first time (the macOS bundle is signed + notarized). ' +
  'Computer Use can click, type, and read your desktop apps in the background. ' +
  "On macOS you'll be guided through Accessibility / Screen Recording permissions next.";

const READ_ONLY_PAGE_ACTIONS = new Set(['get_text', 'query_dom']);

export function isHighRiskCall(
  upstreamName: string,
  params: Record<string, unknown>,
): boolean {
  if (upstreamName === 'clipboard_read') {
    return params['include_text'] === true;
  }
  if (upstreamName === 'check_permissions') {
    return params['prompt'] === true;
  }
  if (upstreamName === 'page') {
    return !READ_ONLY_PAGE_ACTIONS.has(params['action'] as string);
  }
  // screenshot_out_file turns these read-only snapshots into a file write at
  // a model-chosen ~-expanded path — same family the driver classifies as
  // file_transfer_and_output, so gate it like other mutating calls.
  if (
    (upstreamName === 'get_window_state' ||
      upstreamName === 'get_desktop_state') &&
    typeof params['screenshot_out_file'] === 'string' &&
    params['screenshot_out_file'].length > 0
  ) {
    return true;
  }
  const schema = COMPUTER_USE_SCHEMAS[upstreamName as ComputerUseToolName];
  return schema?.annotations.readOnlyHint !== true;
}

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
   * effectively granted blanket permission for all computer_use__*
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
      approvalKey(),
    );

    const onConfirm = async (
      outcome: ToolConfirmationOutcome,
      _payload?: ToolConfirmationPayload,
    ) => {
      // Any non-Cancel outcome means the user approved THIS call. Write install
      // state (idempotent) so runBootstrap() can skip its env-var fallback
      // prompt. PermissionManager handles per-tool "always allow" via
      // permissionRules — install state is no longer a blanket grant.
      if (outcome !== ToolConfirmationOutcome.Cancel) {
        await saveInstallState(homedir(), {
          approvedPackageSpec: approvalKey(),
          approvedAtIso: new Date().toISOString(),
        });
      }
    };

    // Mutating or sensitive calls surface as 'mcp' so AUTO_EDIT does not
    // silently approve them and PLAN mode's read-only boundary blocks them.
    if (isHighRiskCall(this.upstreamName, this.params)) {
      // NOTE: args are deliberately NOT folded into `title` — no mcp
      // confirmation surface (TUI / non-interactive / ACP) renders the mcp
      // title, so it would be dead text. The args reach the user via the
      // tool-header line (getDescription()). The gate's job is forcing the
      // confirmation (mcp type → not AUTO_EDIT-auto-approved). (review round 3)
      return {
        type: 'mcp',
        title: installApproved
          ? `Allow high-risk Computer Use (${this.upstreamName})`
          : `Allow high-risk Computer Use (${this.upstreamName}) — first use also downloads the driver`,
        serverName: 'qwen-cua-driver',
        toolName: this.upstreamName,
        toolDisplayName: `computer_use__${this.upstreamName}`,
        permissionRules,
        onConfirm,
      };
    }

    // Non-high-risk: 'info'. The install variant is a SUPERSET — always show
    // Args (the first call can be a mutating action the user must see), then
    // append INSTALL_REASON when install isn't yet approved. (review round 1)
    const argsJson = safeJsonStringify(this.params);
    const prompt = installApproved
      ? `Tool: computer_use__${this.upstreamName}\n\nArgs: ${argsJson}\n\nThis will act on your desktop via the Computer Use binary.`
      : `Tool: computer_use__${this.upstreamName}\n\nArgs: ${argsJson}\n\n${INSTALL_REASON}`;

    return {
      type: 'info',
      title: `Allow Computer Use (${this.upstreamName})`,
      prompt,
      permissionRules,
      onConfirm,
    };
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const client = ComputerUseClient.shared();

    // Push the configured screenshot longest-edge cap (setting + env override)
    // onto the shared client BEFORE start: it is applied via set_config once the
    // driver connects (and re-applied on reconnect). undefined → leave the
    // driver default. Cheap + idempotent to set on every call.
    client.setMaxImageDimension(
      resolveMaxImageDimension(this.config?.getComputerUseMaxImageDimension()),
    );
    client.setIdleTimeoutMs(this.config?.getComputerUseIdleTimeoutMs());

    // Reaching execute() means the scheduler approved this call. A saved rule or
    // auto-approval mode can bypass onConfirm, so pass install consent whenever a
    // Config-backed scheduler is present. Headless contexts keep bootstrap's
    // explicit environment-controlled fallback.
    const autoApproveInstall = !!this.config;
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
    // parts so the model can actually "see" screenshots from get_window_state.
    // We also forward cua-driver's `structuredContent`: several tools put the
    // load-bearing data ONLY there, not in the human-readable `content` text —
    // e.g. list_windows' content is just "Found N window(s)" while the real
    // window_id / bounds / is_on_screen live in structuredContent.windows.
    // Dropping it left the model guessing window_ids and failing every
    // screenshot/click on the wrong window.
    // NOTE: mcp-tool.ts has an analogous private transformation (transformMcpContentToParts /
    // transformImageAudioBlock); those helpers are not exported so we replicate
    // the pattern here. A future PR should extract a shared utility.
    const llmContent = buildLlmContent(
      mcpResult.content,
      this.upstreamName,
      mcpResult.structuredContent,
    );
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
    schema as { properties?: Record<string, { type?: string | string[] }> }
  ).properties;
  if (!properties) return params;
  const result: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(result)) {
    let fieldType = properties[key]?.type;
    // Nullable fields regenerate as ['number', 'null'] — unwrap to the
    // concrete type so the comparisons below still match.
    if (Array.isArray(fieldType)) {
      fieldType = fieldType.find((t) => t !== 'null');
    }
    // Direction 1: string value, schema wants integer/number → parse
    if (
      (fieldType === 'integer' || fieldType === 'number') &&
      typeof value === 'string'
    ) {
      const trimmed = value.trim();
      // Only coerce if the string is a clean numeric — don't swallow garbage.
      const matchesType =
        fieldType === 'integer'
          ? /^-?\d+$/.test(trimmed)
          : /^-?\d+(\.\d+)?$/.test(trimmed);
      if (matchesType) {
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
  structuredContent?: unknown,
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

  // Forward structuredContent (real window_ids, bounds, on-screen flags, etc.)
  // that the terse `content` text omits. Strip `tree_markdown` first — that
  // field is get_window_state's AX tree, already rendered into the `content`
  // text above, so re-emitting it here would roughly double the token cost.
  const structuredText = stringifyStructured(structuredContent);
  if (structuredText) {
    parts.push({ text: `Structured result: ${structuredText}` });
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

/**
 * Serialize a tool result's `structuredContent` for the model, dropping the
 * `tree_markdown` field (get_window_state's AX tree, already present in the
 * `content` text — re-emitting it would roughly double the token cost).
 * Returns undefined when there is nothing useful to forward.
 */
export function stringifyStructured(structured: unknown): string | undefined {
  if (!structured || typeof structured !== 'object') return undefined;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(structured as Record<string, unknown>)) {
    if (k === 'tree_markdown') continue;
    rest[k] = v;
  }
  if (Object.keys(rest).length === 0) return undefined;
  return safeJsonStringify(rest);
}
