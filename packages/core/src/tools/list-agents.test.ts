/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';

const getOwnPeerIdentity = vi.fn();
const listMessageablePeers = vi.fn();
vi.mock('../ipc/peer-send.js', () => ({
  getOwnPeerIdentity: (...args: unknown[]) => getOwnPeerIdentity(...args),
}));
vi.mock('../ipc/peer-directory.js', async () => {
  const actual = await vi.importActual<
    typeof import('../ipc/peer-directory.js')
  >('../ipc/peer-directory.js');
  return {
    ...actual,
    listMessageablePeers: (...args: unknown[]) => listMessageablePeers(...args),
  };
});

import { ListAgentsTool } from './list-agents.js';
import { resolvePeerTarget } from '../ipc/peer-directory.js';

function peerRow(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    name: 'docs-cd',
    ref: 'abc123',
    cwd: '/w/docs',
    pid: 200,
    ipcPath: '/tmp/s1.sock',
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('ListAgentsTool', () => {
  let registry: BackgroundTaskRegistry;
  let tool: ListAgentsTool;

  beforeEach(() => {
    getOwnPeerIdentity.mockReset();
    listMessageablePeers.mockReset();
    // Cross-session messaging off unless a test turns it on.
    getOwnPeerIdentity.mockResolvedValue(null);
    listMessageablePeers.mockResolvedValue([]);
    registry = new BackgroundTaskRegistry();
    tool = new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
      getTeamManager: () => null,
    } as unknown as Config);
  });

  it('reports an empty roster', async () => {
    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(tool.name).toBe('list_agents');
    expect(result.llmContent).toBe(
      'No ordinary background subagents are available in this session. ' +
        'Named Agent Team teammates are not listed here; their results are ' +
        'delivered automatically through team messaging, so do not use ' +
        'list_agents to wait for a teammate.',
    );
  });

  it('states the Agent Team boundary in the tool description', () => {
    expect(tool.description).toContain(
      'Named Agent Team teammates are NOT listed here',
    );
    expect(tool.description).toContain(
      'deliver their final reports automatically',
    );
    expect(tool.description).toContain(
      'do not use list_agents (or poll task_list) to wait for a teammate',
    );
  });

  it('lists only background agents with stable continuation fields', async () => {
    registry.register({
      agentId: 'agent-running',
      subagentType: 'explore',
      description: 'Inspect runtime',
      isBackgrounded: true,
      status: 'running',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-running.jsonl',
    });
    registry.register({
      agentId: 'agent-foreground',
      description: 'Inline work',
      isBackgrounded: false,
      status: 'running',
      startTime: 2,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-foreground.jsonl',
    });
    registry.register({
      agentId: 'agent-blocked',
      description: 'Unsafe restore',
      isBackgrounded: true,
      status: 'completed',
      startTime: 3,
      endTime: 4,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-blocked.jsonl',
      resumeBlockedReason: 'Transcript does not match.',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.llmContent))).toEqual({
      agents: [
        {
          task_id: 'agent-running',
          subagent_type: 'explore',
          description: 'Inspect runtime',
          status: 'running',
          can_message: true,
        },
        {
          task_id: 'agent-blocked',
          description: 'Unsafe restore',
          status: 'completed',
          can_message: false,
          resume_blocked_reason: 'Transcript does not match.',
        },
      ],
    });
  });
});

describe('ListAgentsTool — peer sessions', () => {
  const SELF = {
    ipcPath: '/tmp/self.sock',
    name: 'self-00',
    sessionId: 'self',
    ref: 'se1f00',
  };

  function toolWith(
    registry = new BackgroundTaskRegistry(),
    teammates: string[] = [],
  ) {
    return new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
      getTeamManager: () =>
        teammates.length === 0
          ? null
          : {
              getTeamFile: () => ({
                leadAgentId: 'lead-1',
                members: teammates.map((name) => ({ name })),
              }),
            },
    } as unknown as Config);
  }

  async function run(tool = toolWith()) {
    return tool.validateBuildAndExecute({}, new AbortController().signal);
  }

  beforeEach(() => {
    getOwnPeerIdentity.mockReset();
    listMessageablePeers.mockReset();
    getOwnPeerIdentity.mockResolvedValue(SELF);
    listMessageablePeers.mockResolvedValue([]);
  });

  it('does not look for peers when this session has no inbox', async () => {
    getOwnPeerIdentity.mockResolvedValue(null);
    const result = await run();
    expect(listMessageablePeers).not.toHaveBeenCalled();
    expect(result.llmContent).not.toContain('reachable');
  });

  it('says so when messaging is on but no other session is reachable', async () => {
    const result = await run();
    expect(result.llmContent).toContain('no other Qwen Code session');
    expect(result.llmContent).toContain('Named Agent Team teammates');
    // The description promises the session's own name; the empty case
    // must keep that promise too.
    expect(result.llmContent).toContain('This session is named "self-00"');
  });

  it('appends the ref when a teammate shadows the bare name', async () => {
    // send_message tries teammates first with a sanitized lookup, so a
    // peer whose name sanitizes to a teammate's is unreachable bare.
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: 'Docs-CD', ref: 'aaa111' }),
      peerRow({ sessionId: 's2', name: 'other-ef', ref: 'bbb222' }),
    ]);
    const parsed = JSON.parse(
      String((await run(toolWith(undefined, ['docs-cd']))).llmContent),
    );
    expect(parsed.sessions.map((s: { to: string }) => s.to)).toEqual([
      'Docs-CD [aaa111]',
      'other-ef',
    ]);
  });

  it('lists a peer with a bare name as its address, and names itself', async () => {
    listMessageablePeers.mockResolvedValue([peerRow()]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed).toEqual({
      agents: [],
      self: { name: 'self-00', ref: 'se1f00' },
      sessions: [
        {
          to: 'docs-cd',
          name: 'docs-cd',
          ref: 'abc123',
          cwd: '/w/docs',
          started_at: new Date(1_700_000_000_000).toISOString(),
        },
      ],
    });
  });

  it('appends the ref only when two sessions share a name', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', ref: 'aaa111' }),
      peerRow({ sessionId: 's2', ref: 'bbb222', cwd: '/w/other' }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions.map((s: { to: string }) => s.to)).toEqual([
      'docs-cd [aaa111]',
      'docs-cd [bbb222]',
    ]);
  });

  it('appends the ref when a bracketed name is shadowed by a teammate', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: 'notes [draft]', ref: 'aaa111' }),
    ]);
    const parsed = JSON.parse(
      String((await run(toolWith(undefined, ['notes-draft']))).llmContent),
    );
    expect(parsed.sessions[0].to).toBe('notes [draft] [aaa111]');
  });

  it('keeps printed addresses distinct when a literal name mimics one', async () => {
    const peers = [
      peerRow({ sessionId: 's1', name: 'docs-cd', ref: 'aaa111' }),
      peerRow({
        sessionId: 's2',
        name: 'docs-cd [aaa111]',
        ref: 'bbb222',
        ipcPath: '/tmp/s2.sock',
      }),
    ];
    listMessageablePeers.mockResolvedValue(peers);
    const parsed = JSON.parse(
      String((await run(toolWith(undefined, ['docs-cd']))).llmContent),
    );
    const addresses = parsed.sessions.map(
      (session: { to: string }) => session.to,
    );
    expect(new Set(addresses).size).toBe(2);
    expect(addresses).toEqual(['[aaa111]', 'docs-cd [aaa111] [bbb222]']);
    for (const [index, address] of addresses.entries()) {
      expect(resolvePeerTarget(peers, address)).toEqual({
        kind: 'one',
        peer: peers[index],
      });
    }
  });

  it('appends the ref for leader handles intercepted by team routing', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: 'leader', ref: 'aaa111' }),
      peerRow({
        sessionId: 's2',
        name: 'lead-1',
        ref: 'bbb222',
        ipcPath: '/tmp/s2.sock',
      }),
    ]);
    const parsed = JSON.parse(
      String((await run(toolWith(undefined, ['worker']))).llmContent),
    );
    expect(
      parsed.sessions.map((session: { to: string }) => session.to),
    ).toEqual(['leader [aaa111]', 'lead-1 [bbb222]']);
  });

  it('omits started_at when the registry timestamp is outside Date range', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', startedAt: 9e15 }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions[0]).not.toHaveProperty('started_at');
  });

  it('excludes this session from its own listing', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ name: 'self-00', ipcPath: '/tmp/self.sock' }),
      peerRow({ sessionId: 's2', ref: 'bbb222' }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].name).toBe('docs-cd');
  });

  it('excludes a differently named twin of this session', async () => {
    // `qwen --resume <id>` from another directory: same session id under
    // a second process. sendToPeer refuses it as self, so advertising it
    // would hand the model a dead address.
    listMessageablePeers.mockResolvedValue([
      peerRow({
        sessionId: 'self',
        ref: 'se1f00',
        name: 'self-old',
        cwd: '/w/old',
        ipcPath: '/tmp/old.sock',
      }),
      peerRow({ sessionId: 's2', ref: 'bbb222' }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].name).toBe('docs-cd');
  });

  it("keeps a peer that merely shares this session's name", async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ name: 'self-00', ipcPath: '/tmp/self.sock' }),
      peerRow({
        sessionId: 's2',
        ref: 'bbb222',
        name: 'self-00',
        cwd: '/w/twin',
        ipcPath: '/tmp/s2.sock',
      }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        name: 'self-00',
        ref: 'bbb222',
        cwd: '/w/twin',
      }),
    ]);
  });

  it('never advertises the broadcast keyword as a peer address', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: '*', ref: 'aaa111' }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].to).not.toBe('*');
    expect(parsed.sessions[0].to).toContain('aaa111');
  });

  it('intercepts the leader handle only while a team is active', async () => {
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: 'leader', ref: 'aaa111' }),
    ]);
    const noTeam = JSON.parse(String((await run()).llmContent));
    expect(noTeam.sessions[0].to).toBe('leader');
    const withTeam = JSON.parse(
      String((await run(toolWith(undefined, ['alice']))).llmContent),
    );
    expect(withTeam.sessions[0].to).toBe('leader [aaa111]');
  });

  it('omits a peer that no address in the grammar can single out', async () => {
    // Same name and the same ref: every candidate is ambiguous for both.
    listMessageablePeers.mockResolvedValue([
      peerRow({ sessionId: 's1', name: 'docs-cd', ref: 'aaa111' }),
      peerRow({ sessionId: 's2', name: 'docs-cd', ref: 'aaa111', cwd: '/w/2' }),
      peerRow({ sessionId: 's3', name: 'other-ef', ref: 'bbb222' }),
    ]);
    const parsed = JSON.parse(String((await run()).llmContent));
    expect(parsed.sessions.map((s: { to: string }) => s.to)).toEqual([
      'other-ef',
    ]);
  });

  it('counts both kinds in the display line', async () => {
    const registry = new BackgroundTaskRegistry();
    registry.register({
      agentId: 'a1',
      description: 'do a thing',
      status: 'running',
      isBackgrounded: true,
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/a1.jsonl',
    });
    listMessageablePeers.mockResolvedValue([peerRow()]);
    const result = await run(toolWith(registry));
    expect(result.returnDisplay).toBe(
      'Listed 1 background agent and 1 other session.',
    );
  });

  it('omits the sessions key entirely when there are none', async () => {
    const registry = new BackgroundTaskRegistry();
    registry.register({
      agentId: 'a1',
      description: 'do a thing',
      status: 'running',
      isBackgrounded: true,
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/a1.jsonl',
    });
    const parsed = JSON.parse(
      String((await run(toolWith(registry))).llmContent),
    );
    expect(parsed.sessions).toBeUndefined();
    expect(parsed.self).toEqual({ name: 'self-00', ref: 'se1f00' });
    expect(parsed.agents).toHaveLength(1);
  });
});
