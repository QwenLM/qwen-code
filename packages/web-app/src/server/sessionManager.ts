/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionRunner } from './websocket/sessionRunner.js';

const sessionRunners = new Map<string, SessionRunner>();

export async function createSession(
  cwd: string = process.cwd(),
): Promise<SessionRunner> {
  const runner = await SessionRunner.createNew(cwd);
  const sessionId = runner.getSessionId();
  sessionRunners.set(sessionId, runner);
  return runner;
}

export function getOrCreateSession(
  sessionId: string,
  cwd: string = process.cwd(),
): SessionRunner {
  let runner = sessionRunners.get(sessionId);
  if (!runner) {
    runner = new SessionRunner(sessionId, cwd);
    sessionRunners.set(sessionId, runner);
  }
  return runner;
}

export function getSession(sessionId: string): SessionRunner | undefined {
  return sessionRunners.get(sessionId);
}

export function removeSession(sessionId: string): void {
  const runner = sessionRunners.get(sessionId);
  if (runner) {
    void runner.shutdown();
    sessionRunners.delete(sessionId);
  }
}

export function getActiveSessions(): string[] {
  return Array.from(sessionRunners.keys());
}
