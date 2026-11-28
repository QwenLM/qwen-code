/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSession } from '../../../factory/session-factory.js';
import { buildMessage } from '../../../factory/message-factory.js';

describe('SessionImpl', () => {
  it('exposes identity and location fields', () => {
    const session = buildSession({
      sessionId: 's1',
      remoteId: 'remote-1',
      entrypoint: 'cli',
      version: '1.0.0',
      userType: 'external',
      projectDir: '/project',
      sessionPath: '/project/.qwen/s1.jsonl',
      cwd: '/project',
      gitBranch: 'main',
    });

    expect(session.getSessionId()).toBe('s1');
    expect(session.getRemoteId()).toBe('remote-1');
    expect(session.getEntrypoint()).toBe('cli');
    expect(session.getVersion()).toBe('1.0.0');
    expect(session.getUserType()).toBe('external');
    expect(session.getProjectDir()).toBe('/project');
    expect(session.getSessionPath()).toBe('/project/.qwen/s1.jsonl');
    expect(session.getCwd()).toBe('/project');
    expect(session.getGitBranch()).toBe('main');
  });

  it('groups added messages into turns', () => {
    const session = buildSession({ sessionId: 's1' });

    session.addMessage(buildMessage({
      uuid: 'u1',
      role: 'user',
      promptId: 'p1',
      payload: { content: 'first' },
    }));
    session.addMessage(buildMessage({
      uuid: 'a1',
      role: 'assistant',
      promptId: 'p1',
      payload: { content: 'ok' },
    }));
    session.addMessage(buildMessage({
      uuid: 'u2',
      role: 'user',
      promptId: 'p2',
      payload: { content: 'second' },
    }));

    expect(session.getMessages()).toHaveLength(3);
    expect(session.getTurns()).toHaveLength(2);
    expect(session.getMessageCount()).toBe(3);
    expect(session.getTurns()[0].getMessages()).toHaveLength(2);
    expect(session.getTurns()[1].getMessages()).toHaveLength(1);
  });

  it('exposes catalog metadata from the stamp', () => {
    const session = buildSession({
      sessionId: 's1',
      lastPrompt: 'hello',
      summary: 'a summary',
      directories: ['/a', '/b'],
    });

    expect(session.getLastPrompt()).toBe('hello');
    expect(session.getSummary()).toBe('a summary');
    expect(session.getWorkspaceDirectories()).toEqual(['/a', '/b']);
  });

  it('computes display name fallback chain', () => {
    const session = buildSession({ sessionId: 's1' });
    expect(session.getDisplayName()).toBe('Empty conversation');

    const titled = buildSession({ sessionId: 's2', summary: 'summary title' });
    expect(titled.getDisplayName()).toBe('summary title');
  });
});
