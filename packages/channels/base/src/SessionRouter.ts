import type { SessionScope, SessionTarget } from './types.js';
import type { AcpBridge } from './AcpBridge.js';

export class SessionRouter {
  private toSession: Map<string, string> = new Map(); // routing key → session ID
  private toTarget: Map<string, SessionTarget> = new Map(); // session ID → target

  private bridge: AcpBridge;
  private cwd: string;
  private scope: SessionScope;

  constructor(bridge: AcpBridge, cwd: string, scope: SessionScope = 'user') {
    this.bridge = bridge;
    this.cwd = cwd;
    this.scope = scope;
  }

  private routingKey(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): string {
    switch (this.scope) {
      case 'thread':
        return `${channelName}:${threadId || chatId}`;
      case 'single':
        return `${channelName}:__single__`;
      case 'user':
      default:
        return `${channelName}:${senderId}`;
    }
  }

  async resolve(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): Promise<string> {
    const key = this.routingKey(channelName, senderId, chatId, threadId);
    const existing = this.toSession.get(key);
    if (existing) {
      return existing;
    }

    const sessionId = await this.bridge.newSession(this.cwd);
    this.toSession.set(key, sessionId);
    this.toTarget.set(sessionId, { channelName, senderId, chatId, threadId });
    return sessionId;
  }

  getTarget(sessionId: string): SessionTarget | undefined {
    return this.toTarget.get(sessionId);
  }

  hasSession(channelName: string, senderId: string): boolean {
    return this.toSession.has(`${channelName}:${senderId}`);
  }

  removeSession(channelName: string, senderId: string): boolean {
    const key = `${channelName}:${senderId}`;
    const sessionId = this.toSession.get(key);
    if (!sessionId) return false;
    this.toSession.delete(key);
    this.toTarget.delete(sessionId);
    return true;
  }
}
