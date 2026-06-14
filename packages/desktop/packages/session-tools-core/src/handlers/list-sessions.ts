import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface ListSessionsArgs {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

export async function handleListSessions(
  ctx: SessionToolContext,
  args: ListSessionsArgs
): Promise<ToolResult> {
  if (!ctx.listSessions) {
    return errorResponse('list_sessions is not available in this context.');
  }

  try {
    const result = ctx.listSessions({
      status: args.status,
      label: args.label,
      search: args.search,
      sortBy: args.sortBy,
      limit: args.limit,
      offset: args.offset,
    });
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list sessions: ${message}`);
  }
}
