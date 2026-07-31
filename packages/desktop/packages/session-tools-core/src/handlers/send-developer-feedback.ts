/**
 * Send Developer Feedback Handler
 *
 * Persists freeform markdown feedback from the agent to the development team.
 * Uses an injected submitFeedback callback to avoid depending on fs paths directly.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult, DeveloperFeedback } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendDeveloperFeedbackArgs {
  message: string;
}

/**
 * Handle the send_developer_feedback tool call.
 *
 * Validates the message, generates a unique ID, and delegates to the
 * context-provided submitFeedback callback for persistence.
 */
export async function handleSendDeveloperFeedback(
  ctx: SessionToolContext,
  args: SendDeveloperFeedbackArgs
): Promise<ToolResult> {
  if (!ctx.submitFeedback) {
    return errorResponse('Developer feedback is not available in this environment.');
  }

  const message = args.message?.trim();
  if (!message) {
    return errorResponse('Feedback message cannot be empty.');
  }

  try {
    const now = Date.now();
    const shortId = Math.random().toString(36).slice(2, 8);

    const feedback: DeveloperFeedback = {
      id: `fb_${now}_${shortId}`,
      timestamp: new Date(now).toISOString(),
      sessionId: ctx.sessionId,
      message,
    };

    ctx.submitFeedback(feedback);
    return successResponse('Feedback sent to the development team. Thanks for sharing!');
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send feedback: ${msg}`);
  }
}
