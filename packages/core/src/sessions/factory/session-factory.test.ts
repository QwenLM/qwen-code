/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSession } from './session-factory.js';

describe('buildSession', () => {
  it('builds a Session from a stamp', () => {
    const session = buildSession({
      sessionId: 's1',
      projectDir: '/project',
      messages: [
        { uuid: 'u1', role: 'user', promptId: 'p1', payload: { content: 'hello' } },
        { uuid: 'a1', role: 'assistant', promptId: 'p1', payload: { content: 'hi' } },
      ],
    });

    expect(session.getSessionId()).toBe('s1');
    expect(session.getProjectDir()).toBe('/project');
    expect(session.getMessages()).toHaveLength(2);
    expect(session.getTurns()).toHaveLength(1);
    expect(session.getTurns()[0].getPromptId()).toBe('p1');
  });

  it('builds turns directly when stamp provides them', () => {
    const session = buildSession({
      sessionId: 's1',
      turns: [
        {
          promptId: 'p1',
          messages: [
            { uuid: 'u1', role: 'user', payload: { content: 'hello' } },
          ],
        },
      ],
    });

    expect(session.getTurns()).toHaveLength(1);
    expect(session.getMessages()).toHaveLength(1);
  });

  it('generates an id when omitted', () => {
    const session = buildSession({});
    expect(session.getSessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
