import { createContext } from 'react';
import type {
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
