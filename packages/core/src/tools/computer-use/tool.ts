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
import { ComputerUseClient } from './client.js';
import type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { runBootstrap } from './bootstrap.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import { homedir } from 'node:os';

type ComputerUseParams = Record<string, unknown>;

/**
 * The package spec used for install-state checks. Must stay in sync with
 * the default in bootstrap.ts defaultDeps().
 */
const PACKAGE_SPEC =
  process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';

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
    const approved = await isPackageSpecApproved(homedir(), PACKAGE_SPEC);
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
            approvedPackageSpec: PACKAGE_SPEC,
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

    const text = mcpResult.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');

    if (mcpResult.isError) {
      return {
        llmContent: text || `Tool '${this.upstreamName}' returned isError=true`,
        returnDisplay: text || 'Error',
        error: { message: text || 'tool returned error' },
      };
    }

    return {
      llmContent: text,
      returnDisplay: text,
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

  protected createInvocation(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    return new ComputerUseInvocation(this.upstreamName, params);
  }
}
