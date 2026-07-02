/**
 * Webhook server for receiving external event triggers.
 *
 * Lightweight HTTP/HTTPS server that receives webhooks and triggers
 * scheduled tasks based on configured triggers.
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';

export interface WebhookTriggerConfig {
  path: string;
  method: 'POST' | 'GET' | 'PUT';
  auth?: {
    type: 'bearer' | 'hmac';
    secret?: string;
  };
  taskId: string;
}

export interface WebhookServerOptions {
  port: number;
  host?: string;
  triggers: WebhookTriggerConfig[];
  onTrigger: (taskId: string, payload: unknown) => Promise<void>;
  tls?: {
    cert: string; // path to cert file
    key: string; // path to key file
  };
}

export class WebhookServer {
  private server: Server | HttpsServer | null = null;
  private options: WebhookServerOptions;

  constructor(options: WebhookServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Webhook server is already running');
    }

    return new Promise((resolve, reject) => {
      const host = this.options.host || '127.0.0.1';
      const protocol = this.options.tls ? 'https' : 'http';

      if (this.options.tls) {
        // HTTPS mode
        let cert: Buffer;
        let key: Buffer;
        try {
          cert = fs.readFileSync(this.options.tls.cert);
          key = fs.readFileSync(this.options.tls.key);
        } catch (err) {
          reject(
            new Error(
              `Failed to read TLS certificates: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }

        this.server = createHttpsServer(
          { cert, key },
          this.handleRequest.bind(this),
        );
      } else {
        // HTTP mode (default)
        this.server = createServer(this.handleRequest.bind(this));
      }

      this.server.listen(this.options.port, host, () => {
        process.stderr.write(
          `[WebhookServer] Listening on ${protocol}://${host}:${this.options.port} with ${this.options.triggers.length} trigger(s)\n`,
        );
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        process.stderr.write('[WebhookServer] Stopped\n');
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method || 'GET';

    // Find matching trigger
    const trigger = this.options.triggers.find(
      (t) => t.path === url.pathname && t.method === method,
    );

    if (!trigger) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Read body BEFORE auth so HMAC can sign the actual payload
    let body = '';
    const MAX_BODY = 1024 * 1024; // 1MB
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }
    }

    // Authenticate if configured
    if (trigger.auth) {
      const authResult = this.authenticate(req, trigger.auth, body);
      if (!authResult) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    let payload: unknown;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Trigger the task
    try {
      await this.options.onTrigger(trigger.taskId, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'triggered', taskId: trigger.taskId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Failed to trigger task',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private authenticate(
    req: IncomingMessage,
    auth: { type: 'bearer' | 'hmac'; secret?: string },
    body: string,
  ): boolean {
    if (!auth.secret) {
      return true;
    }

    const authHeader = req.headers.authorization || '';

    if (auth.type === 'bearer') {
      const expected = `Bearer ${auth.secret}`;
      if (authHeader.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    }

    if (auth.type === 'hmac') {
      const signatureHeader = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(signatureHeader)
        ? signatureHeader[0]
        : signatureHeader || '';
      if (!signature.startsWith('sha256=')) {
        return false;
      }

      const providedSig = signature.slice(7);
      const expectedSig = createHmac('sha256', auth.secret)
        .update(body)
        .digest('hex');

      try {
        return timingSafeEqual(
          Buffer.from(providedSig),
          Buffer.from(expectedSig),
        );
      } catch {
        return false;
      }
    }

    return false;
  }
}
