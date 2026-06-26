/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'http';

/**
 * Hook output type for HTTP hook responses
 */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: 'ask' | 'block' | 'deny' | 'approve' | 'allow';
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

/**
 * Mock HTTP Server for testing HTTP hooks
 * Provides endpoints that simulate various hook response scenarios
 */
export class MockHttpServer {
  private server: Server | null = null;
  private port: number = 0;
  private readonly responses: Map<
    string,
    HookOutput | ((input: Record<string, unknown>) => HookOutput)
  > = new Map();
  private readonly requestLogs: Array<{
    url: string;
    body: Record<string, unknown>;
    timestamp: number;
  }> = [];

  /**
   * Start the mock server on a random available port
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop the mock server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the server's base URL
   */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Set response for a specific path
   */
  setResponse(
    path: string,
    response: HookOutput | ((input: Record<string, unknown>) => HookOutput),
  ): void {
    this.responses.set(path, response);
  }

  /**
   * Get all received request logs
   */
  getRequestLogs(): Array<{
    url: string;
    body: Record<string, unknown>;
    timestamp: number;
  }> {
    return [...this.requestLogs];
  }

  /**
   * Clear request logs
   */
  clearRequestLogs(): void {
    this.requestLogs.length = 0;
  }

  /**
   * Handle incoming HTTP request
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const parsedBody = JSON.parse(body || '{}');

      // Log the request
      this.requestLogs.push({
        url: req.url || '/',
        body: parsedBody,
        timestamp: Date.now(),
      });

      // Find matching response
      const response = this.responses.get(req.url || '/');

      if (response) {
        const output =
          typeof response === 'function' ? response(parsedBody) : response;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
      } else {
        // Default response: allow with continue
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ continue: true }));
      }
    });

    req.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  }
}

/**
 * Pre-defined response scenarios for HTTP hook testing
 */
export const HttpHookResponses = {
  /** Allow execution */
  allow: { decision: 'allow', continue: true } as HookOutput,

  /** Block execution */
  block: {
    decision: 'block',
    reason: 'Blocked by HTTP hook',
    continue: false,
  } as HookOutput,

  /** Ask for permission */
  ask: { decision: 'ask', reason: 'User confirmation required' } as HookOutput,

  /** Deny execution */
  deny: { decision: 'deny', reason: 'Denied by HTTP hook' } as HookOutput,

  /** Return additional context */
  withContext: (context: string): HookOutput => ({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  }),

  /** Return system message */
  withSystemMessage: (message: string): HookOutput => ({
    continue: true,
    systemMessage: message,
  }),

  /** PreToolUse allow with permission decision */
  preToolUseAllow: {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Tool execution approved by HTTP hook',
    },
  } as HookOutput,

  /** PreToolUse deny with permission decision */
  preToolUseDeny: {
    continue: false,
    decision: 'deny',
    reason: 'Tool execution denied by HTTP hook',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Security policy violation',
    },
  } as HookOutput,

  /** PreToolUse ask for confirmation */
  preToolUseAsk: {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Requires user confirmation',
    },
  } as HookOutput,

  /** UserPromptSubmit with additional context */
  userPromptSubmitContext: (context: string): HookOutput => ({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }),

  /** PostToolUse with additional context */
  postToolUseContext: (context: string): HookOutput => ({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }),

  /** Stop hook with stop reason */
  stopWithReason: (reason: string): HookOutput => ({
    continue: true,
    stopReason: reason,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `Stop reason: ${reason}`,
    },
  }),
};
