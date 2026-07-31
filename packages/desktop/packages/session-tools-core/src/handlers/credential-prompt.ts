/**
 * Credential Prompt Handler
 *
 * Prompts the user to enter credentials for a source via the secure input UI.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult, CredentialAuthRequest, CredentialInputMode } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { generateRequestId, detectCredentialMode, getEffectiveHeaderNames } from '../source-helpers.ts';

export interface CredentialPromptArgs {
  sourceSlug: string;
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  /** Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"]) */
  headerNames?: string[];
  passwordRequired?: boolean;
}

/**
 * Handle the source_credential_prompt tool call.
 *
 * 1. Validate mode and parameters
 * 2. Load source config for name
 * 3. Build auth request with all provided options
 * 4. Trigger auth request (will cause forceAbort)
 */
export async function handleCredentialPrompt(
  ctx: SessionToolContext,
  args: CredentialPromptArgs
): Promise<ToolResult> {
  const { sourceSlug, mode, labels, description, hint, headerNames, passwordRequired } = args;

  // Load source config
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // Detect effective mode (auto-upgrades to multi-header if source has headerNames)
  const effectiveMode = detectCredentialMode(source, mode, headerNames);
  const effectiveHeaderNames = getEffectiveHeaderNames(source, headerNames);

  // Validate that passwordRequired only applies to basic auth
  if (passwordRequired !== undefined && effectiveMode !== 'basic') {
    return errorResponse(
      `passwordRequired parameter only applies to basic auth mode. You specified mode="${mode}" with passwordRequired=${passwordRequired}.`
    );
  }

  // Build auth request
  const authRequest: CredentialAuthRequest = {
    type: 'credential',
    requestId: generateRequestId('cred'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    mode: effectiveMode,
    labels,
    description,
    hint,
    headerName: source.api?.headerName,
    headerNames: effectiveHeaderNames,
    // Pass source URL so password managers can match stored credentials
    sourceUrl: source.api?.baseUrl || source.mcp?.url,
    passwordRequired,
  };

  // Trigger auth request (will cause forceAbort)
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Authentication requested for '${source.name}'. Waiting for user input.`
  );
}
