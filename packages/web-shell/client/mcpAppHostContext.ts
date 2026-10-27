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
  text: string;
  signal: AbortSignal;
}

export interface McpAppMessages {
  sessionId: string;
  requestMessage(request: McpAppMessageRequest): Promise<{ isError?: boolean }>;
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

export function isBuiltInGeneratedUi(display?: {
  resourceUri: string;
  requiredFeature?: 'generated-ui';
}): boolean {
  return (
    display?.requiredFeature === 'generated-ui' ||
    display?.resourceUri === 'ui://qwen-code-generated-ui/view-v1.html'
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
