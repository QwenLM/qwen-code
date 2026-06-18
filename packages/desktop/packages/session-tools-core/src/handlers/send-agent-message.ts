import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendAgentMessageArgs {
  sessionId: string;
  message: string;
  attachments?: Array<{ path: string; name?: string }>;
}

export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  // Prevent self-send (would create a recursive loop)
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // Build sender envelope so the target session knows who sent the message
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const wrappedMessage = [
      `[Message from session "${ctx.sessionId}" (${senderName})]`,
      `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
      '',
      '---',
      '',
      args.message,
    ].join('\n');

    await ctx.sendAgentMessage(args.sessionId, wrappedMessage, args.attachments);

    return successResponse(
      `Message sent to session ${args.sessionId}. The session will process it independently.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}
