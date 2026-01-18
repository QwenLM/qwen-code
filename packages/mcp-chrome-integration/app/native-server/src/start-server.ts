#!/usr/bin/env node

/**
 * Standalone HTTP Server Starter
 * Starts HTTP server independently for MCP Server (stdio) connections
 */

import serverInstance from './server';
// import { setMcpServerInstance } from './mcp/mcp-server';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 12306;

async function start(): Promise<void> {
  try {
    console.log('[Standalone Server] Starting HTTP server...');

    await serverInstance.start(PORT);

    // Set MCP server instance so mcp-server-stdio.ts can use it
    // const mcpServer = serverInstance.getMcpServerInstance();
    // if (mcpServer) {
    //   setMcpServerInstance(mcpServer);
    //   console.log(
    //     '[Standalone Server] ✅ MCP server instance shared with stdio client',
    //   );
    // }

    console.log(`[Standalone Server] ✅ HTTP server started on port ${PORT}`);
    console.log(
      `[Standalone Server] MCP endpoint: http://127.0.0.1:${PORT}/mcp`,
    );
    console.log(
      `[Standalone Server] Ping endpoint: http://127.0.0.1:${PORT}/ping`,
    );
    console.log('');
    console.log('Press Ctrl+C to stop');
  } catch (error) {
    console.error('[Standalone Server] ❌ Failed to start:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Standalone Server] Shutting down...');
  try {
    await serverInstance.stop();
    console.log('[Standalone Server] ✅ Server stopped');
    process.exit(0);
  } catch (error) {
    console.error('[Standalone Server] Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n[Standalone Server] Received SIGTERM, shutting down...');
  try {
    await serverInstance.stop();
    process.exit(0);
  } catch (error) {
    console.error('[Standalone Server] Error during shutdown:', error);
    process.exit(1);
  }
});

start();
