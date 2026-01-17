import type { ServerResponse } from 'node:http';
import type { RealtimeEvent } from './types';

type WebSocketLike = {
  readyState?: number;
  send(data: string): void;
  close?: () => void;
};

const WEBSOCKET_OPEN_STATE = 1;

/**
 * AgentStreamManager manages SSE/WebSocket connections keyed by sessionId.
 *
 * 中文说明：此实现参考 other/cweb 中的 StreamManager，但适配 Fastify/Node HTTP，
 * 使用 ServerResponse 直接写入 SSE 数据，避免在 Node 环境中额外引入 Web Streams 依赖。
 */
export class AgentStreamManager {
  private readonly sseClients = new Map<string, Set<ServerResponse>>();
  private readonly webSocketClients = new Map<string, Set<WebSocketLike>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  addSseStream(sessionId: string, res: ServerResponse): void {
    if (!this.sseClients.has(sessionId)) {
      this.sseClients.set(sessionId, new Set());
    }
    this.sseClients.get(sessionId)!.add(res);
    this.ensureHeartbeatTimer();
  }

  removeSseStream(sessionId: string, res: ServerResponse): void {
    const clients = this.sseClients.get(sessionId);
    if (!clients) {
      return;
    }

    clients.delete(res);
    if (clients.size === 0) {
      this.sseClients.delete(sessionId);
    }

    this.stopHeartbeatTimerIfIdle();
  }

  addWebSocket(sessionId: string, socket: WebSocketLike): void {
    if (!this.webSocketClients.has(sessionId)) {
      this.webSocketClients.set(sessionId, new Set());
    }
    this.webSocketClients.get(sessionId)!.add(socket);
    this.ensureHeartbeatTimer();
  }

  removeWebSocket(sessionId: string, socket: WebSocketLike): void {
    const sockets = this.webSocketClients.get(sessionId);
    if (!sockets) {
      return;
    }

    sockets.delete(socket);
    if (sockets.size === 0) {
      this.webSocketClients.delete(sessionId);
    }

    this.stopHeartbeatTimerIfIdle();
  }

  publish(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    const ssePayload = `data: ${payload}\n\n`;

    // Heartbeat events are broadcast to all connections to keep them alive.
    if (event.type === 'heartbeat') {
      this.broadcastToAll(ssePayload, payload);
      return;
    }

    // For all other event types, require a sessionId for routing.
    const targetSessionId = this.extractSessionId(event);
    if (!targetSessionId) {
      // Drop events without sessionId to prevent cross-session leakage.

      console.warn('[AgentStreamManager] Dropping event without sessionId:', event.type);
      return;
    }

    // Session-scoped routing: only send to clients subscribed to this session.
    this.sendToSession(targetSessionId, ssePayload, payload);
  }

  /**
   * Extract sessionId from event based on event type.
   */
  private extractSessionId(event: RealtimeEvent): string | undefined {
    switch (event.type) {
      case 'message':
        return event.data?.sessionId;
      case 'status':
        return event.data?.sessionId;
      case 'connected':
        return event.data?.sessionId;
      case 'error':
        return event.data?.sessionId;
      case 'usage':
        return event.data?.sessionId;
      case 'heartbeat':
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * Send event to a specific session's clients only.
   */
  private sendToSession(sessionId: string, ssePayload: string, wsPayload: string): void {
    // SSE clients
    const sseClients = this.sseClients.get(sessionId);
    if (sseClients) {
      const deadClients: ServerResponse[] = [];
      for (const res of sseClients) {
        if (this.isResponseDead(res)) {
          deadClients.push(res);
          continue;
        }
        try {
          res.write(ssePayload);
        } catch {
          deadClients.push(res);
        }
      }
      for (const res of deadClients) {
        this.removeSseStream(sessionId, res);
      }
    }

    // WebSocket clients
    const wsSockets = this.webSocketClients.get(sessionId);
    if (wsSockets) {
      const deadSockets: WebSocketLike[] = [];
      for (const socket of wsSockets) {
        if (this.isSocketDead(socket)) {
          deadSockets.push(socket);
          continue;
        }
        try {
          socket.send(wsPayload);
        } catch {
          deadSockets.push(socket);
        }
      }
      for (const socket of deadSockets) {
        this.removeWebSocket(sessionId, socket);
      }
    }
  }

  /**
   * Broadcast event to all connected clients (used for heartbeat).
   */
  private broadcastToAll(ssePayload: string, wsPayload: string): void {
    const deadSse: Array<{ sessionId: string; res: ServerResponse }> = [];
    for (const [sessionId, clients] of this.sseClients.entries()) {
      for (const res of clients) {
        if (this.isResponseDead(res)) {
          deadSse.push({ sessionId, res });
          continue;
        }
        try {
          res.write(ssePayload);
        } catch {
          deadSse.push({ sessionId, res });
        }
      }
    }
    for (const { sessionId, res } of deadSse) {
      this.removeSseStream(sessionId, res);
    }

    const deadSockets: Array<{ sessionId: string; socket: WebSocketLike }> = [];
    for (const [sessionId, sockets] of this.webSocketClients.entries()) {
      for (const socket of sockets) {
        if (this.isSocketDead(socket)) {
          deadSockets.push({ sessionId, socket });
          continue;
        }
        try {
          socket.send(wsPayload);
        } catch {
          deadSockets.push({ sessionId, socket });
        }
      }
    }
    for (const { sessionId, socket } of deadSockets) {
      this.removeWebSocket(sessionId, socket);
    }
  }

  private isResponseDead(res: ServerResponse): boolean {
    return (res as any).writableEnded || (res as any).destroyed;
  }

  private isSocketDead(socket: WebSocketLike): boolean {
    return socket.readyState !== undefined && socket.readyState !== WEBSOCKET_OPEN_STATE;
  }

  closeAll(): void {
    for (const [sessionId, clients] of this.sseClients.entries()) {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // Ignore errors during shutdown.
        }
      }
      this.sseClients.delete(sessionId);
    }

    for (const [sessionId, sockets] of this.webSocketClients.entries()) {
      for (const socket of sockets) {
        try {
          socket.close?.();
        } catch {
          // Ignore errors during shutdown.
        }
      }
      this.webSocketClients.delete(sessionId);
    }

    this.stopHeartbeatTimer();
  }

  private ensureHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.sseClients.size === 0 && this.webSocketClients.size === 0) {
        this.stopHeartbeatTimer();
        return;
      }

      const event: RealtimeEvent = {
        type: 'heartbeat',
        data: { timestamp: new Date().toISOString() },
      };
      this.publish(event);
    }, 30_000);

    // Allow Node process to exit naturally even if heartbeat is active.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatTimerIfIdle(): void {
    if (this.sseClients.size === 0 && this.webSocketClients.size === 0) {
      this.stopHeartbeatTimer();
    }
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
