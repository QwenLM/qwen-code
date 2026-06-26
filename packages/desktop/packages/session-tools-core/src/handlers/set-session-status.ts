import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SetSessionStatusArgs {
  sessionId?: string;
  status: string;
}

export async function handleSetSessionStatus(
  ctx: SessionToolContext,
  args: SetSessionStatusArgs
): Promise<ToolResult> {
  if (!ctx.setSessionStatus) {
    return errorResponse('set_session_status is not available in this context.');
  }

  try {
    let status = args.status;

    // Resolve display name → ID, reject unknown statuses
    if (ctx.resolveStatus) {
      const { resolved, available } = ctx.resolveStatus(status);
      if (!resolved) {
        return errorResponse(
          `Unknown status: "${status}". Available status IDs: ${available.join(', ')}`
        );
      }
      status = resolved;
    }

    await ctx.setSessionStatus(args.sessionId, status);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(`Status set to "${status}" on ${target}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set status: ${message}`);
  }
}
