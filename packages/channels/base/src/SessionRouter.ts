import type { SessionTarget } from './types.js';
import type { AcpBridge } from './AcpBridge.js';

export class SessionRouter {
  private toSession: Map<string, string> = new Map(); // routing key → session ID
  private toTarget: Map<string, SessionTarget> = new Map(); // session ID → target

  private bridge: AcpBridge;
  private cwd: string;

  constructor(bridge: AcpBridge, cwd: string) {
    this.bridge = bridge;
    this.cwd = cwd;
  }

  async resolve(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): Promise<string> {
    const key = `${channelName}:${senderId}`;
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
}
