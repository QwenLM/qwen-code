/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket } from 'ws';
import type { Config, GeminiClient } from '@qwen-code/qwen-code-core';
import type { Message } from '../../shared/types.js';
import { randomUUID } from 'crypto';

/**
 * SessionRunner manages AI interactions for a single session
 */
export class SessionRunner {
  private clients: Set<WebSocket> = new Set();
  private abortController: AbortController | null = null;
  private isRunning = false;

  constructor(
    private readonly sessionId: string,
    private readonly config: Config | null,
  ) {}

  /**
   * Add a WebSocket client to this session
   */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  /**
   * Remove a WebSocket client from this session
   */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /**
   * Check if the session is currently processing a request
   */
  get isBusy(): boolean {
    return this.isRunning;
  }

  /**
   * Get the number of connected clients
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Broadcast a message to all connected clients
   */
  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        // WebSocket.OPEN
        client.send(data);
      }
    }
  }

  /**
   * Initialize the AI client for this session
   */
  private async ensureInitialized(): Promise<GeminiClient | null> {
    if (!this.config) {
      return null;
    }

    try {
      const geminiClient = this.config.getGeminiClient();

      // Initialize chat if not already done
      if (!geminiClient.isInitialized()) {
        await geminiClient.resetChat();
      }

      return geminiClient;
    } catch (error) {
      console.error('Error initializing AI client:', error);
      return null;
    }
  }

  /**
   * Get session history
   */
  async getHistory(): Promise<Message[]> {
    if (!this.config) {
      return [];
    }

    try {
      const sessionService = this.config.getSessionService();
      const session = await sessionService.loadSession(this.sessionId);

      if (!session) {
        return [];
      }

      return session.conversation.messages
        .filter((msg) => msg.type !== 'system')
        .map((msg) => {
          // Extract text from message parts
          let textContent = '';
          if (msg.message?.parts) {
            for (const part of msg.message.parts) {
              if ('text' in part && typeof part.text === 'string') {
                textContent += part.text;
              }
            }
          }

          return {
            uuid: msg.uuid,
            parentUuid: msg.parentUuid,
            sessionId: session.conversation.sessionId,
            timestamp: msg.timestamp,
            type: msg.type as Message['type'],
            message: textContent
              ? {
                  role: msg.message?.role || msg.type,
                  parts: [{ text: textContent }],
                }
              : undefined,
            toolCall: msg.toolCallResult
              ? {
                  name: msg.toolCallResult.callId || 'unknown',
                  args: {},
                  status: msg.toolCallResult.error ? 'error' : 'success',
                  result: msg.toolCallResult.resultDisplay,
                }
              : undefined,
          };
        });
    } catch (error) {
      console.error('Error loading session history:', error);
      return [];
    }
  }

  /**
   * Handle a user message and generate AI response
   */
  async handleUserMessage(content: string): Promise<void> {
    if (!this.config) {
      this.broadcast({
        type: 'error',
        message: 'Configuration not available',
      });
      return;
    }

    if (this.isRunning) {
      this.broadcast({
        type: 'error',
        message: 'Session is busy processing another request',
      });
      return;
    }

    const geminiClient = await this.ensureInitialized();
    if (!geminiClient) {
      this.broadcast({
        type: 'error',
        message: 'Failed to initialize AI client',
      });
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    const userMessageUuid = randomUUID();
    const timestamp = new Date().toISOString();

    // Broadcast user message
    const userMessage: Message = {
      uuid: userMessageUuid,
      parentUuid: null,
      sessionId: this.sessionId,
      timestamp,
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: content }],
      },
    };
    this.broadcast({ ...userMessage, type: 'user_message' });
    this.broadcast({ type: 'stream_start' });

    try {
      const promptId = randomUUID();

      // Create the request content
      const request = [{ text: content }];

      // Get the stream of events
      const stream = geminiClient.sendMessageStream(
        request,
        this.abortController.signal,
        promptId,
      );

      const assistantMessageUuid = randomUUID();
      let currentContent = '';
      let lastMessageSentAt = 0;
      const THROTTLE_MS = 50; // Throttle content updates

      for await (const event of stream) {
        // Check if cancelled
        if (this.abortController?.signal.aborted) {
          break;
        }

        // Handle different event types
        const eventType = event.type as string;

        switch (eventType) {
          case 'content': {
            const value = (event as { type: string; value: string }).value;
            currentContent += value;
            const now = Date.now();
            // Throttle content updates to avoid flooding
            if (now - lastMessageSentAt > THROTTLE_MS) {
              this.broadcast({
                type: 'assistant_message',
                uuid: assistantMessageUuid,
                parentUuid: userMessageUuid,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
                streaming: true,
                message: {
                  role: 'assistant',
                  parts: [{ text: currentContent }],
                },
              });
              lastMessageSentAt = now;
            }
            break;
          }

          case 'thought': {
            const value = (event as { type: string; value: { description?: string } }).value;
            this.broadcast({
              type: 'thinking',
              uuid: randomUUID(),
              parentUuid: userMessageUuid,
              sessionId: this.sessionId,
              timestamp: new Date().toISOString(),
              message: {
                role: 'thinking',
                parts: [{ text: value.description || '' }],
              },
            });
            break;
          }

          case 'tool_call_request': {
            const value = (event as { type: string; value: { callId: string; name: string; args: Record<string, unknown> } }).value;
            this.broadcast({
              type: 'tool_call',
              uuid: value.callId,
              parentUuid: assistantMessageUuid,
              sessionId: this.sessionId,
              timestamp: new Date().toISOString(),
              toolCall: {
                name: value.name,
                args: value.args,
                status: 'running',
              },
            });
            break;
          }

          case 'tool_call_response': {
            const value = (event as { type: string; value: { callId: string; displayName?: string; name?: string; status?: string; result?: unknown; error?: string } }).value;
            this.broadcast({
              type: 'tool_call',
              uuid: value.callId,
              parentUuid: assistantMessageUuid,
              sessionId: this.sessionId,
              timestamp: new Date().toISOString(),
              toolCall: {
                name: value.displayName || value.name || 'unknown',
                args: {},
                status: value.status === 'error' ? 'error' : 'success',
                result: value.result,
                error: value.error,
              },
            });
            break;
          }

          case 'finished': {
            // Send final message with complete content
            if (currentContent) {
              this.broadcast({
                type: 'assistant_message',
                uuid: assistantMessageUuid,
                parentUuid: userMessageUuid,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
                streaming: false,
                message: {
                  role: 'assistant',
                  parts: [{ text: currentContent }],
                },
              });
            }
            break;
          }

          case 'error': {
            const value = (event as { type: string; value?: { error?: { message?: string } } }).value;
            this.broadcast({
              type: 'error',
              message: value?.error?.message || 'An error occurred',
            });
            break;
          }

          case 'user_cancelled': {
            this.broadcast({
              type: 'stream_end',
              cancelled: true,
            });
            break;
          }
        }
      }
    } catch (error) {
      console.error('Error in AI stream:', error);
      this.broadcast({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.broadcast({ type: 'stream_end' });
    }
  }

  /**
   * Cancel the current AI generation
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.broadcast({ type: 'stream_end', cancelled: true });
    }
  }

  /**
   * Handle permission response from client
   */
  handlePermissionResponse(message: {
    allow: boolean;
    scope: string;
    requestId?: string;
  }): void {
    // TODO: Implement permission handling
    // This would need to integrate with the CoreToolScheduler
    console.log('Permission response:', message);
  }
}
