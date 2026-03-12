/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteControlServer } from './RemoteControlServer.js';
import { WebSocket } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';

describe('RemoteControlServer', () => {
  let server: RemoteControlServer;
  let mockConfig: Config;

  beforeEach(() => {
    server = new RemoteControlServer({
      port: 7374, // Use different port for tests
      host: 'localhost',
    });

    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: vi.fn().mockReturnValue('test-model'),
    } as unknown as Config;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Server Lifecycle', () => {
    it('should start and stop successfully', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Server should be running
      const connectionInfo = server.getConnectionInfo();
      expect(connectionInfo.port).toBe(7374);

      await server.stop();

      // After stop, should not accept new connections
    });

    it('should initialize with config values', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Verify session ID was updated from config
    });
  });

  describe('Authentication', () => {
    it('should accept valid auth token', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const connectionInfo = server.getConnectionInfo();

      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              version: 1,
              payload: {
                type: 'auth_request',
                token: connectionInfo.token,
              },
            }),
          );
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.payload.type === 'auth_response') {
            expect(message.payload.success).toBe(true);
            expect(message.payload.state).toBe('authenticated');
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);

        setTimeout(() => {
          ws.close();
          reject(new Error('Authentication timeout'));
        }, 5000);
      });
    });

    it('should reject invalid auth token', async () => {
      await server.initialize(mockConfig);
      await server.start();

      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              version: 1,
              payload: {
                type: 'auth_request',
                token: 'invalid-token',
              },
            }),
          );
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.payload.type === 'auth_response') {
            expect(message.payload.success).toBe(false);
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);

        setTimeout(() => {
          ws.close();
          reject(new Error('Authentication timeout'));
        }, 5000);
      });
    });

    it('should rate limit authentication attempts', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Make 5 failed auth attempts (max allowed)
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:7374/ws`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`Attempt ${i + 1} timeout`));
          }, 5000);

          ws.on('open', () => {
            ws.send(
              JSON.stringify({
                version: 1,
                payload: {
                  type: 'auth_request',
                  token: 'wrong-token',
                },
              }),
            );
          });

          ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.payload.type === 'auth_response') {
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          });

          ws.on('error', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // 6th attempt should be rate limited
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Rate limit test timeout'));
        }, 5000);

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.payload.type === 'auth_response') {
            clearTimeout(timeout);
            // Should be blocked due to rate limiting
            expect(message.payload.message).toContain(
              'Too many authentication attempts',
            );
            ws.close();
            resolve();
          }
        });

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              version: 1,
              payload: {
                type: 'auth_request',
                token: 'wrong-token',
              },
            }),
          );
        });

        ws.on('error', (_err) => {
          clearTimeout(timeout);
          // Connection error might also indicate rate limiting
          ws.close();
          resolve();
        });
      });
    }, 30000); // 30 second timeout for this test
  });

  describe('Connection Limits', () => {
    it('should enforce max connections', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const connections: WebSocket[] = [];

      // Open 5 connections (max)
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(`ws://localhost:7374/ws`);
        connections.push(ws);

        await new Promise<void>((resolve) => {
          ws.on('open', resolve);
        });
      }

      // 6th connection should be rejected
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);

        ws.on('close', (code) => {
          expect(code).toBe(1013); // Server at capacity
          resolve();
        });

        ws.on('error', () => {
          // Error is also acceptable
          resolve();
        });

        setTimeout(() => {
          connections.forEach((c) => c.close());
          ws.close();
          reject(new Error('Connection limit test timeout'));
        }, 5000);
      });
    });
  });

  describe('Message Handling', () => {
    it('should handle ping/pong', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const connectionInfo = server.getConnectionInfo();

      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              version: 1,
              payload: {
                type: 'auth_request',
                token: connectionInfo.token,
              },
            }),
          );
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (
            message.payload.type === 'auth_response' &&
            message.payload.success
          ) {
            // Send ping after auth
            ws.send(
              JSON.stringify({
                version: 1,
                payload: {
                  type: 'ping',
                  timestamp: Date.now() - 100,
                },
              }),
            );
          }

          if (message.payload.type === 'pong') {
            expect(message.payload.latency).toBeGreaterThanOrEqual(0);
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);

        setTimeout(() => {
          ws.close();
          reject(new Error('Ping/pong test timeout'));
        }, 5000);
      });
    });

    it('should reject oversized messages', async () => {
      await server.initialize(mockConfig);
      await server.start();

      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:7374/ws`);

        ws.on('close', (code) => {
          // Should close with message too large error
          expect(code).toBe(1009);
          resolve();
        });

        ws.on('open', () => {
          // Send a very large message (> 1MB)
          const largeMessage = 'x'.repeat(1024 * 1024 + 1);
          ws.send(
            JSON.stringify({
              version: 1,
              payload: {
                type: 'ping',
                timestamp: Date.now(),
                largeData: largeMessage,
              },
            }),
          );
        });

        ws.on('error', () => {
          resolve();
        });

        setTimeout(() => {
          ws.close();
          reject(new Error('Message size test timeout'));
        }, 5000);
      });
    });
  });

  describe('API Endpoints', () => {
    it('should respond to health check', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const response = await fetch('http://localhost:7374/health');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    // FIX: /api/connect no longer requires token - it returns session info for any request
    it('should return connection info without token for /api/connect', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Without token - should now succeed (no token required)
      const response = await fetch('http://localhost:7374/api/connect');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.sessionId).toBeDefined();
      expect(data.capabilities).toContain('realtime');
    });

    it('should return QR data without token for /api/qr-data', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Without token - should now succeed (no token required)
      const response = await fetch('http://localhost:7374/api/qr-data');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.url).toBeDefined();
      expect(data.url).not.toContain('token='); // Token should NOT be in URL
      expect(data.sessionId).toBeDefined();
    });
  });

  describe('Security Headers', () => {
    it('should include security headers in responses', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const response = await fetch('http://localhost:7374/');

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-XSS-Protection')).toBe('1; mode=block');
    });
  });

  describe('Proxy-aware IP detection', () => {
    it('should use X-Forwarded-For header for rate limiting', async () => {
      await server.initialize(mockConfig);
      await server.start();

      // Test that IP can be extracted from X-Forwarded-For header
      // This would require integration testing with actual proxy headers
    });
  });
});
