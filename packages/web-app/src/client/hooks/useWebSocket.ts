/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Message,
  PermissionRequest,
  WSMessage,
} from '../../shared/types.js';

interface SessionInfo {
  version?: string;
  model?: string;
  contextWindow?: number;
}

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
}

interface UseWebSocketOptions {
  onMessage: (message: Message) => void;
  onHistory: (messages: Message[]) => void;
  onSessionInfo?: (info: SessionInfo) => void;
  onUsageUpdate?: (usage: UsageInfo) => void;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  isStreaming: boolean;
  permissionRequest: PermissionRequest | null;
  sessionInfo: SessionInfo | null;
  usage: UsageInfo | null;
  send: (message: WSMessage) => void;
  respondToPermission: (optionId: string) => void;
}

export function useWebSocket(
  sessionId: string | null,
  options: UseWebSocketOptions,
): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permissionRequest, setPermissionRequest] =
    useState<PermissionRequest | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const { onMessage, onHistory, onSessionInfo, onUsageUpdate } = options;

  // Connect to WebSocket
  useEffect(() => {
    if (!sessionId) {
      return;
    }

    // Reset usage when switching sessions
    setUsage(null);
    setSessionInfo(null);

    const connect = () => {
      // Determine WebSocket URL
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws`;

      console.log('Connecting to WebSocket:', wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);

        // Join session
        ws.send(JSON.stringify({ type: 'join_session', sessionId }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('WebSocket message:', data.type);

          switch (data.type) {
            case 'history':
              onHistory(data.messages || []);
              break;

            case 'user_message':
            case 'assistant_message':
            case 'tool_call':
            case 'thinking':
              onMessage({
                uuid: data.uuid,
                parentUuid: data.parentUuid,
                sessionId: data.sessionId,
                timestamp: data.timestamp,
                type: data.type.replace('_message', ''),
                message: data.message,
                toolCall: data.toolCall,
              });
              break;

            case 'stream_start':
              setIsStreaming(true);
              break;

            case 'stream_end':
              setIsStreaming(false);
              break;

            case 'session_info': {
              const info: SessionInfo = {
                version: data.version,
                model: data.model,
                contextWindow: data.contextWindow,
              };
              setSessionInfo(info);
              onSessionInfo?.(info);
              break;
            }

            case 'usage_update': {
              const usageData: UsageInfo = {
                inputTokens: data.inputTokens ?? 0,
                outputTokens: data.outputTokens ?? 0,
                totalTokens: data.totalTokens ?? 0,
                contextWindow: data.contextWindow ?? 200000,
              };
              setUsage(usageData);
              onUsageUpdate?.(usageData);
              break;
            }

            case 'permission_request':
              setPermissionRequest({
                id: data.id,
                operation: data.operation,
                args: data.args || {},
                description: data.description,
                options: Array.isArray(data.options) ? data.options : undefined,
                toolCall: data.toolCall,
              });
              break;

            case 'joined':
              console.log('Joined session:', data.sessionId);
              break;

            case 'error':
              console.error('WebSocket error:', data.message);
              // Reset streaming state on error
              setIsStreaming(false);
              break;

            default:
              console.warn('Unhandled WebSocket message type:', data.type);
              break;
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        setIsStreaming(false);
        wsRef.current = null;

        // Attempt to reconnect after delay
        if (!event.wasClean) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect...');
            connect();
          }, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsStreaming(false);
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, onMessage, onHistory, onSessionInfo, onUsageUpdate]);

  // Send message
  const send = useCallback((message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, cannot send message');
    }
  }, []);

  // Respond to permission request
  const respondToPermission = useCallback(
    (optionId: string) => {
      send({
        type: 'permission_response',
        optionId,
        requestId: permissionRequest?.id,
      });
      setPermissionRequest(null);
    },
    [send, permissionRequest],
  );

  return {
    isConnected,
    isStreaming,
    permissionRequest,
    sessionInfo,
    usage,
    send,
    respondToPermission,
  };
}
