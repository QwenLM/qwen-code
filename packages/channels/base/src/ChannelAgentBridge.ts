import type { EventEmitter } from 'node:events';

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  kind: string;
  title: string;
  status: string;
  rawInput?: Record<string, unknown>;
}

export interface ChannelAgentBridge extends Pick<EventEmitter, 'on' | 'off'> {
  readonly availableCommands: AvailableCommand[];
  newSession(cwd: string): Promise<string>;
  loadSession(sessionId: string, cwd: string): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    options?: { imageBase64?: string; imageMimeType?: string },
  ): Promise<string>;
  cancelSession(sessionId: string): Promise<void>;
  shellCommand?(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
}
