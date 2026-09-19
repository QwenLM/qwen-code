/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import { runWithToolCallSource } from '../code-mode/tool-call-runtime.js';
import { SESSION_CONTEXT_TOOL_NAMES } from '../services/session-notes-state.js';
import { SessionContextTool } from './session-context.js';
import { ToolNames } from './tool-names.js';
import { isCodeModeToolCallAllowed } from './code-mode.js';

function fixture() {
  const response = { observed: {} };
  const notes = {
    sessionId: 'session',
    captureResponse: () => response,
    assertAvailable: vi.fn(),
    write: vi.fn().mockResolvedValue({
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'input',
    }),
    read: vi.fn().mockResolvedValue(undefined),
    requestReset: vi.fn(),
  };
  const chat = { getSessionNotesService: () => notes };
  const client = { getChat: vi.fn(() => chat) };
  const config = {
    llmClient: client,
    getLlmClient: () => client,
    getSessionId: vi.fn(() => 'session'),
  } as unknown as Config;
  return { config, client, notes, response };
}

describe('session context tools', () => {
  it('captures the response at invocation time and returns a durable write revision', async () => {
    const { config, notes, response } = fixture();
    const tool = new SessionContextTool(config, ToolNames.SESSION_NOTES);
    const signal = new AbortController().signal;
    const result = await tool
      .build({ action: 'write', text: 'checkpoint' })
      .execute(signal);
    expect(notes.write).toHaveBeenCalledWith('checkpoint', response, signal);
    expect(JSON.parse(result.llmContent as string)).toEqual({
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'input',
    });
    expect(result.error).toBeUndefined();
  });

  it.each(['derived config', 'subagent', 'teammate', 'nested exec'])(
    'rejects parent notes access from %s',
    async (context) => {
      const { config, notes } = fixture();
      const scopedConfig =
        context === 'derived config'
          ? (Object.create(config) as Config)
          : config;
      const execute = () =>
        new SessionContextTool(scopedConfig, ToolNames.SESSION_NOTES)
          .build({ action: 'write', text: 'checkpoint' })
          .execute(new AbortController().signal);
      const result =
        context === 'subagent'
          ? await runWithAgentContext('child', execute)
          : context === 'teammate'
            ? await runWithTeammateIdentity(
                {
                  agentId: 'scribe@team',
                  agentName: 'scribe',
                  teamName: 'team',
                  isTeamLead: false,
                },
                execute,
              )
            : context === 'nested exec'
              ? await runWithToolCallSource({ kind: 'code_mode' }, execute)
              : await execute();
      expect(result.error?.message).toContain('owning main chat');
      expect(notes.write).not.toHaveBeenCalled();
    },
  );

  it('rejects an invocation after session rotation', async () => {
    const { config, notes } = fixture();
    const invocation = new SessionContextTool(
      config,
      ToolNames.NEW_CONTEXT,
    ).build({ notes_revision: 'note' });
    vi.mocked(config.getSessionId).mockReturnValue('new-session');
    expect(
      (await invocation.execute(new AbortController().signal)).error,
    ).toBeDefined();
    expect(notes.requestReset).not.toHaveBeenCalled();
  });

  it('does not accept arbitrary paths or malformed operations and exposes only direct code-mode calls', () => {
    const { config } = fixture();
    const notes = new SessionContextTool(config, ToolNames.SESSION_NOTES);
    expect(() => notes.build({ action: 'write' })).toThrow();
    expect(() =>
      notes.build({ action: 'read', path: '/other-session' } as never),
    ).toThrow();
    expect(() =>
      new SessionContextTool(config, ToolNames.SESSION_HISTORY).build({
        action: 'list',
        limit: 100,
      }),
    ).toThrow();
    for (const name of SESSION_CONTEXT_TOOL_NAMES) {
      expect(isCodeModeToolCallAllowed(name, 'model')).toBe(true);
      expect(isCodeModeToolCallAllowed(name, 'code_mode')).toBe(false);
    }
  });
});
