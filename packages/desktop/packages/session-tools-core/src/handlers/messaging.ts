/**
 * Messaging session tools — list bindings and unbind channels.
 *
 * NOTE: Binding is done via pairing codes (chat-side or UI-side),
 * not via arbitrary channelId from the agent. This prevents the agent
 * from binding sessions to channels it shouldn't have access to.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// ---------------------------------------------------------------------------
// list_messaging_channels
// ---------------------------------------------------------------------------

export interface ListMessagingChannelsArgs {
  sessionId?: string;
}

export async function handleListMessagingChannels(
  ctx: SessionToolContext,
  args: ListMessagingChannelsArgs,
): Promise<ToolResult> {
  if (!ctx.getMessagingBindings) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const sessionId = args.sessionId ?? ctx.sessionId;
    const bindings = ctx.getMessagingBindings(sessionId);

    if (bindings.length === 0) {
      return successResponse(`No messaging channels bound to session ${sessionId}.`);
    }

    const lines = bindings.map((b) =>
      `- ${b.platform}: ${b.channelName || b.channelId} (${b.enabled ? 'active' : 'disabled'})`,
    );

    return successResponse(
      `Messaging bindings for session ${sessionId}:\n${lines.join('\n')}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list messaging channels: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// unbind_messaging_channel
// ---------------------------------------------------------------------------

export interface UnbindMessagingChannelArgs {
  platform?: 'telegram' | 'whatsapp';
}

export async function handleUnbindMessagingChannel(
  ctx: SessionToolContext,
  args: UnbindMessagingChannelArgs,
): Promise<ToolResult> {
  if (!ctx.unbindMessagingChannel) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const removed = ctx.unbindMessagingChannel(ctx.sessionId, args.platform);
    if (removed > 0) {
      const platformLabel = args.platform ?? 'all platforms';
      return successResponse(`Unbound ${removed} messaging channel(s) for ${platformLabel}.`);
    }
    return successResponse('No messaging channels were bound to this session.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to unbind messaging channel: ${message}`);
  }
}
