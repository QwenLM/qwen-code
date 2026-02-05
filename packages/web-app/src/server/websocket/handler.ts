/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket, WebSocketServer } from 'ws';
import type { WSMessage } from '../../shared/types.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import {
  getOrCreateSession,
  getSession,
  removeSession,
} from '../sessionManager.js';

interface ClientState {
  sessionId: string | null;
}

export function setupWebSocket(wss: WebSocketServer) {
  const clientStates = new WeakMap<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    console.log('WebSocket client connected');
    clientStates.set(ws, { sessionId: null });

    ws.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        const state = clientStates.get(ws);
        if (!state) {
          return;
        }

        switch (message.type) {
          case 'join_session':
            await handleJoinSession(ws, state, message);
            break;
          case 'leave_session':
            handleLeaveSession(ws, state);
            break;
          case 'user_message':
            await handleUserMessage(ws, state, message);
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
        const runner = getSession(state.sessionId);
        if (runner) {
          runner.removeClient(ws);
          if (runner.clientCount === 0) {
            removeSession(state.sessionId);
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

async function handleJoinSession(
  ws: WebSocket,
  state: ClientState,
  message: WSMessage,
) {
  const sessionId = message.sessionId as string;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
    return;
  }

  if (state.sessionId) {
    const prevRunner = getSession(state.sessionId);
    if (prevRunner) {
      prevRunner.removeClient(ws);
    }
  }

  state.sessionId = sessionId;
  let runner = getSession(sessionId);
  if (!runner) {
    const sessionService = new SessionService(process.cwd());
    const exists = await sessionService.sessionExists(sessionId);
    if (!exists) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      state.sessionId = null;
      return;
    }
    runner = getOrCreateSession(sessionId);
  }
  runner.addClient(ws);

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

function handleLeaveSession(ws: WebSocket, state: ClientState) {
  if (!state.sessionId) {
    return;
  }

  const runner = getSession(state.sessionId);
  if (runner) {
    runner.removeClient(ws);
    if (runner.clientCount === 0) {
      removeSession(state.sessionId);
    }
  }

  state.sessionId = null;
}

async function handleUserMessage(
  ws: WebSocket,
  state: ClientState,
  message: WSMessage,
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

  const runner = getOrCreateSession(state.sessionId);
  await runner.handleUserMessage(content.trim());
}

function handleCancel(state: ClientState) {
  if (!state.sessionId) {
    return;
  }

  const runner = getSession(state.sessionId);
  runner?.cancel();
}

function handlePermissionResponse(state: ClientState, message: WSMessage) {
  if (!state.sessionId) {
    return;
  }

  const runner = getSession(state.sessionId);
  runner?.handlePermissionResponse({
    optionId: message.optionId as string,
    requestId: message.requestId as string | undefined,
  });
}
