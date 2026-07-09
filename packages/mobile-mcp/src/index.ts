#!/usr/bin/env node
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, getAgentVersion } from './server';
import { error } from './logger';
import express from 'express';
import { program } from 'commander';

const startSseServer = async (host: string, port: number) => {
  const app = express();
  const server = createMcpServer();

  const authToken = process.env.MOBILEMCP_AUTH;
  if (!authToken) {
    error(
      'WARNING: MOBILEMCP_AUTH is not set. The SSE server will accept unauthenticated connections. Set MOBILEMCP_AUTH to require Bearer token authentication.',
    );
  }

  if (authToken) {
    app.use((req, res, next) => {
      if (req.headers.authorization !== `Bearer ${authToken}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      next();
    });
  }

  // Block cross-origin requests — MCP clients are not browsers
  app.use((req, res, next) => {
    if (req.headers.origin) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.status(403).end();
      return;
    }

    next();
  });

  let transport: SSEServerTransport | null = null;

  app.post('/mcp', (req, res) => {
    if (transport) {
      transport.handlePostMessage(req, res);
    }
  });

  app.get('/mcp', (req, res) => {
    if (transport) {
      res
        .status(409)
        .json({
          error:
            'Another client is already connected. Disconnect the existing client first.',
        });
      return;
    }

    transport = new SSEServerTransport('/mcp', res);

    transport.onclose = () => {
      transport = null;
    };

    server.connect(transport);
  });

  app.listen(port, host, () => {
    error(
      `mobile-mcp ${getAgentVersion()} sse server listening on http://${host}:${port}/mcp`,
    );
  });
};

const startStdioServer = async () => {
  try {
    const transport = new StdioServerTransport();

    const server = createMcpServer();
    await server.connect(transport);

    // Exit cleanly on termination signals so node flushes pending work
    // (including NODE_V8_COVERAGE output). Node's default SIGINT/SIGTERM
    // handling terminates the process without writing the coverage file,
    // which makes the `test:mcp` report come back all zeros.
    const shutdown = () => {
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    error('mobile-mcp server running on stdio');
  } catch (err: any) {
    console.error('Fatal error in main():', err);
    error('Fatal error in main(): ' + JSON.stringify(err.stack));
    process.exit(1);
  }
};

const main = async () => {
  program
    .version(getAgentVersion())
    .option('--listen <listen>', 'Start SSE server on [host:]port')
    .option('--stdio', 'Start stdio server (default)')
    .parse(process.argv);

  const options = program.opts();

  if (options.listen) {
    const listen = (options.listen as string).trim();
    const lastColon = listen.lastIndexOf(':');
    let host = 'localhost';
    let rawPort: string;

    if (lastColon > 0) {
      host = listen.substring(0, lastColon);
      rawPort = listen.substring(lastColon + 1);
    } else {
      rawPort = listen;
    }

    const port = Number.parseInt(rawPort, 10);
    if (
      !host ||
      !rawPort ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      error(
        `Invalid --listen value "${listen}". Expected [host:]port with port 1-65535.`,
      );
      process.exit(1);
    }

    await startSseServer(host, port);
  } else {
    await startStdioServer();
  }
};

main().then();
