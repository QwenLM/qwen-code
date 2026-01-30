/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';
import type { WSMessage } from '../../shared/types.js';
import { SessionRunner } from './sessionRunner.js';

interface ClientState {
  sessionId: string | null;
}

// Global map of session runners
const sessionRunners = new Map<string, SessionRunner>();

/**
 * Get or create a session runner for the given session ID
 */
function getOrCreateRunner(sessionId: string, config: Config | null): SessionRunner {
  let runner = sessionRunners.get(sessionId);
  if (!runner) {
    runner = new SessionRunner(sessionId, config);
    sessionRunners.set(sessionId, runner);
  }
  return runner;
}

/**
 * Setup WebSocket server
 */
export function setupWebSocket(wss: WebSocketServer, config: Config | null) {
  const clientStates = new WeakMap<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    console.log('WebSocket client connected');

    clientStates.set(ws, { sessionId: null });

    ws.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        const state = clientStates.get(ws);

        if (!state) return;

        switch (message.type) {
          case 'join_session':
            await handleJoinSession(ws, state, message, config);
            break;

          case 'leave_session':
            handleLeaveSession(ws, state);
            break;

          case 'user_message':
            await handleUserMessage(ws, state, message, config);
            break;

          case 'cancel':
            handleCancel(state);
            break;

          case 'permission_response':
            handlePermissionResponse(state, message);
            break;

          default:
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Unknown message type: ${message.type}`,
              }),
            );
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      const state = clientStates.get(ws);
      if (state?.sessionId) {
        const runner = sessionRunners.get(state.sessionId);
        if (runner) {
          runner.removeClient(ws);
          // Clean up runner if no clients left
          if (runner.clientCount === 0) {
            sessionRunners.delete(state.sessionId);
          }
        }
      }
      clientStates.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}

/**
 * Handle join session request
 */
async function handleJoinSession(
  ws: WebSocket,
  state: ClientState,
  message: WSMessage,
  config: Config | null,
) {
  const sessionId = message.sessionId as string;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
    return;
  }

  // Leave previous session if any
  if (state.sessionId) {
    const prevRunner = sessionRunners.get(state.sessionId);
    if (prevRunner) {
      prevRunner.removeClient(ws);
    }
  }

  state.sessionId = sessionId;

  // Get or create runner and add client
  const runner = getOrCreateRunner(sessionId, config);
  runner.addClient(ws);

  // Load and send history
  try {
    const history = await runner.getHistory();
    ws.send(JSON.stringify({ type: 'history', messages: history }));
  } catch (error) {
    console.error('Error loading session history:', error);
    ws.send(JSON.stringify({ type: 'history', messages: [] }));
  }

  ws.send(
    JSON.stringify({
      type: 'joined',
      sessionId,
      message: `Joined session ${sessionId}`,
    }),
  );
}

/**
 * Handle leave session request
 */
function handleLeaveSession(ws: WebSocket, state: ClientState) {
  if (state.sessionId) {
    const runner = sessionRunners.get(state.sessionId);
    if (runner) {
      runner.removeClient(ws);
      if (runner.clientCount === 0) {
        sessionRunners.delete(state.sessionId);
      }
    }
    state.sessionId = null;
  }
}

/**
 * Handle user message
 */
async function handleUserMessage(
  ws: WebSocket,
  state: ClientState,
  message: WSMessage,
  config: Config | null,
) {
  if (!state.sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' }));
    return;
  }

  const content = message.content as string;
  if (!content || !content.trim()) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Message content required' }),
    );
    return;
  }

  const runner = getOrCreateRunner(state.sessionId, config);
  await runner.handleUserMessage(content.trim());
}

/**
 * Handle cancel request
 */
function handleCancel(state: ClientState) {
  if (state.sessionId) {
    const runner = sessionRunners.get(state.sessionId);
    if (runner) {
      runner.cancel();
    }
  }
}

/**
 * Handle permission response
 */
function handlePermissionResponse(state: ClientState, message: WSMessage) {
  if (state.sessionId) {
    const runner = sessionRunners.get(state.sessionId);
    if (runner) {
      runner.handlePermissionResponse({
        allow: message.allow as boolean,
        scope: message.scope as string,
        requestId: message.requestId as string | undefined,
      });
    }
  }
}
