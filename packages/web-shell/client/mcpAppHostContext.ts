import { createContext, useContext } from 'react';
import type {
  DaemonSession,
  DaemonMcpAppToolCall,
  DaemonMcpAppToolResult,
} from '@qwen-code/sdk/daemon';

export const McpAppHostContext = createContext<string | undefined>(undefined);

export type McpAppToolCallRequest = DaemonMcpAppToolCall;

export const McpAppSessionContext = createContext<string | undefined>(
  undefined,
);

export interface McpAppMessageRequest {
  serverName: string;
  resourceUri: string;
  /** Set only for the bundled Generated UI server, as core marks it. */
  requiredFeature?: 'generated-ui';
  text: string;
  signal: AbortSignal;
}

/**
 * Result metadata naming a review that ended without the session accepting
 * the message: `cancelled` by the user or the host, `expired` while awaiting
 * review, or `failed` when it was refused before or at admission.
 */
export const MCP_APP_MESSAGE_REVIEW_META = 'qwen-code/message-review';

export interface McpAppMessageResult {
  isError?: boolean;
  _meta?: {
    [MCP_APP_MESSAGE_REVIEW_META]?: 'cancelled' | 'expired' | 'failed';
  };
  [key: string]: unknown;
}

export interface McpAppMessages {
  sessionId: string;
  requestMessage(request: McpAppMessageRequest): Promise<McpAppMessageResult>;
}

export const McpAppMessagesContext = createContext<McpAppMessages | undefined>(
  undefined,
);

export const McpAppToolsContext = createContext<
  | {
      sessionId: string;
      callTool: (
        request: McpAppToolCallRequest,
        signal: AbortSignal,
      ) => Promise<DaemonMcpAppToolResult>;
    }
  | undefined
>(undefined);

export interface McpAppGeneratedUi {
  sessionId: string;
  status: NonNullable<DaemonSession['generatedUi']>;
}

export const McpAppGeneratedUiContext = createContext<
  McpAppGeneratedUi | undefined
>(undefined);

export interface McpAppGeneratedUiOwnerSource {
  scopeId: string;
  sessionId: string;
  clientId: string;
  workspaceCwd: string;
  eventEpoch?: string;
  captureOwner(): { isCurrent(): boolean };
}

export interface McpAppGeneratedUiInvalidation {
  scopeId: string;
  sessionId?: string;
  reason:
    | 'policy'
    | 'epoch'
    | 'runtime-stopped'
    | 'cleared'
    | 'deleted'
    | 'rewound'
    | 'auth-failed'
    | 'scope-changed';
}

export interface McpAppGeneratedUiOwner {
  scopeId: string;
  workspaceCwd?: string;
  source?: McpAppGeneratedUiOwnerSource;
  subscribeInvalidation(
    listener: (event: McpAppGeneratedUiInvalidation) => void,
  ): () => void;
  invalidate(event: McpAppGeneratedUiInvalidation): void;
  captureSessionDeletion(
    workspaceCwd: string | undefined,
  ): (sessionIds: readonly string[]) => void;
}

export const McpAppGeneratedUiOwnerContext = createContext<
  McpAppGeneratedUiOwner | undefined
>(undefined);

export const McpAppVisibilityContext = createContext(true);

const BUNDLED_GENERATED_UI_RESOURCE =
  'ui://qwen-code-generated-ui/view-v1.html';

/**
 * Whether core marked this App as the bundled Generated UI server's. Unlike
 * {@link isBuiltInGeneratedUi}, the resource URI alone does not count: any
 * server can claim it, so presentation that hides the App's origin keys on
 * this instead.
 */
export function isBundledGeneratedUi(display?: {
  requiredFeature?: 'generated-ui';
}): boolean {
  return display?.requiredFeature === 'generated-ui';
}

// Admission errs toward the feature gate, so a claimed URI also counts.
export function isBuiltInGeneratedUi(display?: {
  resourceUri: string;
  requiredFeature?: 'generated-ui';
}): boolean {
  return (
    display?.requiredFeature === 'generated-ui' ||
    display?.resourceUri === BUNDLED_GENERATED_UI_RESOURCE
  );
}

export function useMcpAppAdmission(
  display?: Parameters<typeof isBuiltInGeneratedUi>[0],
): boolean {
  const sessionId = useContext(McpAppSessionContext);
  const capability = useContext(McpAppGeneratedUiContext);
  const builtIn = isBuiltInGeneratedUi(display);
  return (
    !builtIn ||
    ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE !==
      'transcript' &&
      !!sessionId &&
      capability?.sessionId === sessionId &&
      capability.status.version === 1 &&
      capability.status.enabled === true)
  );
}
