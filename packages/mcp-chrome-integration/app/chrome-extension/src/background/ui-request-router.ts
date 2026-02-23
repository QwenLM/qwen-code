/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const UI_REQUEST_TYPES = new Set([
  'GET_STATUS',
  'CONNECT',
  'sendMessage',
  'cancelStreaming',
  'permissionResponse',
  'EXIT',
]);

export function isUiRequest(request) {
  return (
    !!request &&
    typeof request.type === 'string' &&
    UI_REQUEST_TYPES.has(request.type)
  );
}

export async function routeUiRequest(request, deps) {
  const { connect, getStatus, sendMessageWithResponse } = deps || {};

  switch (request.type) {
    case 'GET_STATUS': {
      const nativeStatus = (getStatus && getStatus()) || { connected: false };
      let acpStatus = { connected: false };
      if (nativeStatus.connected && sendMessageWithResponse) {
        try {
          const resp = await sendMessageWithResponse({
            type: 'acp_status',
            payload: {},
          });
          acpStatus = resp || acpStatus;
        } catch {
          acpStatus = { connected: false };
        }
      }
      const connected = !!nativeStatus.connected && !!acpStatus.connected;
      return {
        handled: true,
        response: {
          status: connected ? 'connected' : 'disconnected',
          connected,
          acpStatus,
          permissions: [],
        },
        action: null,
      };
    }
    case 'CONNECT': {
      let connected = false;
      if (connect) {
        connected = await connect();
      }
      if (!connected) {
        return {
          handled: true,
          response: {
            success: false,
            connected: false,
            status: 'disconnected',
          },
          action: null,
        };
      }
      if (sendMessageWithResponse) {
        await sendMessageWithResponse({
          type: 'acp_connect',
          payload: request.data || {},
        });
      }
      return {
        handled: true,
        response: {
          success: true,
          connected: true,
          status: 'connected',
        },
        action: null,
      };
    }
    case 'sendMessage':
      if (sendMessageWithResponse) {
        await sendMessageWithResponse({
          type: 'acp_prompt',
          payload: request.data || {},
        });
      }
      return { handled: true, response: { success: true }, action: null };
    case 'cancelStreaming':
      if (sendMessageWithResponse) {
        await sendMessageWithResponse({
          type: 'acp_cancel',
          payload: request.data || {},
        });
      }
      return {
        handled: true,
        response: { success: true, cancelled: true },
        action: null,
      };
    case 'permissionResponse':
      if (sendMessageWithResponse) {
        await sendMessageWithResponse({
          type: 'acp_permission_response',
          payload: request.data || {},
        });
      }
      return { handled: true, response: { success: true }, action: null };
    case 'EXIT':
      if (sendMessageWithResponse) {
        await sendMessageWithResponse({
          type: 'acp_stop',
          payload: request.data || {},
        });
      }
      return { handled: true, response: { success: true }, action: null };
    default:
      return { handled: false, response: null, action: null };
  }
}
