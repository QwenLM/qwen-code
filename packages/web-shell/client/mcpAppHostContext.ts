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
