import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

export let mcpServer: Server | null = null;

export const getMcpServer = () => {
  if (mcpServer) {
    return mcpServer;
  }
  mcpServer = new Server(
    {
      name: 'ChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(mcpServer);
  return mcpServer;
};
