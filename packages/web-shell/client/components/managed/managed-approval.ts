import { escapePreviewText } from '../../adapters/transcriptAdapter';
import type {
  ACPToolCall,
  Message,
  PermissionOptionKind,
  PermissionRequest,
} from '../../adapters/types';
import type { ManagedAgentPendingAction } from './managed-agent-provider';

// The service documents allow and deny as stable option IDs. Mapping them to
// the ordinary option kinds lets the shared approval card localize the labels.
const OPTION_KINDS: Readonly<Record<string, PermissionOptionKind>> = {
  allow: 'allow_once',
  deny: 'reject_once',
};

/**
 * Finds the transcript tool that a pending Action asks about. Managed tool
 * rows are keyed `${turnId}:${toolCallId}`, and the Action's functionCallId is
 * that tool call ID; without a resolved Turn only the call ID can match.
 */
export function findManagedApprovalTool(
  messages: readonly Message[],
  action: ManagedAgentPendingAction,
): ACPToolCall | undefined {
  const exact = action.turnId
    ? `${action.turnId}:${action.functionCallId}`
    : undefined;
  const suffix = `:${action.functionCallId}`;
  let found: ACPToolCall | undefined;
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      // Rows keyed by a Java itemId keep the call ID separately.
      const matches =
        tool.toolCallId !== undefined
          ? tool.toolCallId === action.functionCallId &&
            (!action.turnId || tool.callId.startsWith(`${action.turnId}:`))
          : exact
            ? tool.callId === exact
            : tool.callId.endsWith(suffix);
      if (matches) found = tool;
    }
  }
  return found;
}

/** Presents a pending Hosted approval through the shared approval card. */
export function toManagedPermissionRequest(
  action: ManagedAgentPendingAction,
  messages: readonly Message[],
): PermissionRequest {
  const tool = findManagedApprovalTool(messages, action);
  let rawInput = tool?.args;
  if (
    !rawInput &&
    action.toolName === 'exit_plan_mode' &&
    action.inputPreview &&
    !action.inputPreview.truncated
  ) {
    try {
      const preview: unknown = JSON.parse(action.inputPreview.text);
      if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
        const input = (preview as Record<string, unknown>)['input'];
        if (
          input &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          typeof (input as Record<string, unknown>)['plan'] === 'string'
        )
          rawInput = input as Record<string, unknown>;
      }
    } catch {
      /* An incomplete preview remains explicitly marked as such. */
    }
  }
  const toolCallId =
    tool?.callId ??
    (action.turnId ? `${action.turnId}:${action.functionCallId}` : undefined);
  return {
    id: action.actionId,
    sessionId: action.sessionId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName: action.toolName,
    ...(action.toolName === 'exit_plan_mode'
      ? { toolKind: 'switch_mode' as const }
      : {}),
    title: tool?.title ?? action.toolName,
    content: rawInput
      ? [
          {
            type: 'text',
            text: escapePreviewText(
              action.toolName === 'exit_plan_mode' &&
                typeof rawInput['plan'] === 'string'
                ? rawInput['plan']
                : JSON.stringify(rawInput, null, 2),
            ),
          },
        ]
      : action.inputPreview
        ? [{ type: 'text', text: escapePreviewText(action.inputPreview.text) }]
        : [],
    ...(rawInput
      ? { rawInput, contentIsInput: true }
      : action.inputPreview
        ? { contentIsInput: true }
        : {}),
    options: action.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(OPTION_KINDS[option.id] ? { kind: OPTION_KINDS[option.id] } : {}),
    })),
  };
}
