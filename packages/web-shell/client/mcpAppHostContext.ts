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

export function useMcpAppAdmission(display?: {
  resourceUri: string;
  requiredFeature?: 'generated-ui';
}): boolean {
  const sessionId = useContext(McpAppSessionContext);
  const capability = useContext(McpAppGeneratedUiContext);
  const builtIn =
    display?.requiredFeature === 'generated-ui' ||
    display?.resourceUri === 'ui://qwen-code-generated-ui/view-v1.html';
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
