import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SetSessionLabelsArgs {
  sessionId?: string;
  labels: string[];
}

export async function handleSetSessionLabels(
  ctx: SessionToolContext,
  args: SetSessionLabelsArgs
): Promise<ToolResult> {
  if (!ctx.setSessionLabels) {
    return errorResponse('set_session_labels is not available in this context.');
  }

  try {
    let labels = args.labels;

    // Resolve display names → IDs, reject unknown labels
    if (ctx.resolveLabels) {
      const { resolved, unknown, available, reasons } = ctx.resolveLabels(labels);
      if (unknown.length > 0) {
        const lines = unknown.map((entry) => {
          const reason = reasons?.[entry] ?? 'unknown label';
          return `  - "${entry}" — ${reason}`;
        });
        return errorResponse(
          `Labels rejected:\n${lines.join('\n')}\n\n` +
          `Available label IDs: ${available.join(', ')}.\n` +
          `Use "id::value" only for labels configured with a valueType (number, date, or string).`
        );
      }
      labels = resolved;
    }

    await ctx.setSessionLabels(args.sessionId, labels);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(
      labels.length === 0
        ? `Labels cleared on ${target}.`
        : `Labels set on ${target}: ${labels.join(', ')}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set labels: ${message}`);
  }
}
