import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookServer } from './webhook-server.js';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';

describe('WebhookServer', () => {
  let server: WebhookServer;
  let port: number;
  const onTrigger = vi.fn();

  beforeEach(() => {
    onTrigger.mockReset();
    // Find a free port
    port = 18000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop();
    }
  });

  function createServer(
    opts: { auth?: { type: 'bearer' | 'hmac'; secret?: string } } = {},
  ) {
    server = new WebhookServer({
      port,
      host: '127.0.0.1',
      triggers: [
        {
          path: '/webhook',
          method: 'POST',
          auth: opts.auth,
          taskId: 'test-task-1',
        },
      ],
      onTrigger,
    });
    return server.start();
  }

  function post(
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body: data }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // -----------------------------------------------------------------------
  // No-auth baseline
  // -----------------------------------------------------------------------

  describe('no auth', () => {
    it('triggers task on valid POST', async () => {
      await createServer();
      const res = await post('/webhook', JSON.stringify({ event: 'push' }));
      expect(res.status).toBe(200);
      expect(onTrigger).toHaveBeenCalledWith('test-task-1', { event: 'push' });
    });

    it('returns 404 for unknown path', async () => {
      await createServer();
      const res = await post('/unknown', '{}');
      expect(res.status).toBe(404);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid JSON', async () => {
      await createServer();
      const res = await post('/webhook', 'not-json');
      expect(res.status).toBe(400);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Bearer auth
  // -----------------------------------------------------------------------

  describe('bearer auth', () => {
    it('accepts correct bearer token', async () => {
      await createServer({ auth: { type: 'bearer', secret: 'my-secret' } });
      const res = await post('/webhook', '{}', {
        Authorization: 'Bearer my-secret',
      });
      expect(res.status).toBe(200);
      expect(onTrigger).toHaveBeenCalled();
    });

    it('rejects wrong bearer token', async () => {
      await createServer({ auth: { type: 'bearer', secret: 'my-secret' } });
      const res = await post('/webhook', '{}', {
        Authorization: 'Bearer wrong',
      });
      expect(res.status).toBe(401);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('rejects missing bearer token', async () => {
      await createServer({ auth: { type: 'bearer', secret: 'my-secret' } });
      const res = await post('/webhook', '{}');
      expect(res.status).toBe(401);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // HMAC auth
  // -----------------------------------------------------------------------

  describe('HMAC auth', () => {
    it('accepts correct HMAC signature', async () => {
      await createServer({ auth: { type: 'hmac', secret: 'hmac-secret' } });
      const body = JSON.stringify({ event: 'push' });
      const sig = createHmac('sha256', 'hmac-secret')
        .update(body)
        .digest('hex');
      const res = await post('/webhook', body, {
        'x-hub-signature-256': `sha256=${sig}`,
      });
      expect(res.status).toBe(200);
      expect(onTrigger).toHaveBeenCalled();
    });

    it('rejects wrong HMAC signature', async () => {
      await createServer({ auth: { type: 'hmac', secret: 'hmac-secret' } });
      const res = await post('/webhook', '{}', {
        'x-hub-signature-256': 'sha256=deadbeef',
      });
      expect(res.status).toBe(401);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('rejects missing HMAC signature', async () => {
      await createServer({ auth: { type: 'hmac', secret: 'hmac-secret' } });
      const res = await post('/webhook', '{}');
      expect(res.status).toBe(401);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('rejects HMAC without sha256= prefix', async () => {
      await createServer({ auth: { type: 'hmac', secret: 'hmac-secret' } });
      const res = await post('/webhook', '{}', {
        'x-hub-signature-256': 'deadbeef',
      });
      expect(res.status).toBe(401);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Body size limit
  // -----------------------------------------------------------------------

  describe('body size limit', () => {
    it('rejects payload exceeding 1MB with 413', async () => {
      await createServer();
      const bigBody = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1 byte
      const res = await post('/webhook', bigBody);
      expect(res.status).toBe(413);
      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('accepts payload under 1MB', async () => {
      await createServer();
      const okBody = JSON.stringify({ data: 'x'.repeat(1000) });
      const res = await post('/webhook', okBody);
      expect(res.status).toBe(200);
      expect(onTrigger).toHaveBeenCalled();
    });
  });
});
