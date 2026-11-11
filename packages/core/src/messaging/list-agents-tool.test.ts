/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_FEATURE_PREFIX } from '../config/brand.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { LIST_AGENTS_TOOL_NAME } from '../tools/tool-names.js';
import { CROSS_SESSION_FEATURE_NAME } from './cross-session-feature.js';
import { ListAgentsTool } from './list-agents-tool.js';
import { peerHandle, type PeerEntry } from './peer-listing.js';

const listAllPeersMock = vi.hoisted(() => vi.fn());
vi.mock('./peer-listing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./peer-listing.js')>();
  return { ...actual, listAllPeers: listAllPeersMock };
});

const FEATURE_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_FEATURE_NAME}`;

function makeConfig(tasks: unknown[] = []): Config {
  return {
    taskRegistry: { all: () => tasks },
  } as unknown as Config;
}

function peerEntry(name: string, socketPath: string): PeerEntry {
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    baseName: name,
    displayName: name,
    handle: peerHandle(socketPath),
    ref: 'abc123',
    session: {
      pid: 7,
      procStart: 0,
      startedAt: Date.now() - 30_000,
      cwd: '/tmp/other',
      messagingSocketPath: socketPath,
      peerProtocol: 1,
      kind: 'interactive',
      status: 'idle',
    },
  };
}

async function run(config: Config) {
  const tool = new ListAgentsTool(config);
  return tool.build({} as never).executeWithContext!({
    signal: new AbortController().signal,
    callId: 'call-1',
  } as ToolUseContext);
}

describe('ListAgents', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[FEATURE_ENV];
    process.env[FEATURE_ENV] = '1';
    listAllPeersMock.mockReset();
    listAllPeersMock.mockResolvedValue([]);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[FEATURE_ENV];
    else process.env[FEATURE_ENV] = previous;
  });

  it('is named ListAgents', () => {
    expect(new ListAgentsTool(makeConfig()).name).toBe(LIST_AGENTS_TOOL_NAME);
  });

  it('reports an empty listing when nothing is reachable', async () => {
    const result = await run(makeConfig());
    expect(result.llmContent).toContain('none reachable');
  });

  it('lists reachable peers', async () => {
    listAllPeersMock.mockResolvedValue([peerEntry('api', '/tmp/a.sock')]);
    const result = await run(makeConfig());
    expect(result.llmContent).toContain('api');
    expect(result.toolUseResult).toMatchObject({ peerCount: 1 });
  });

  it('lists running in-process agents', async () => {
    const result = await run(
      makeConfig([
        { type: 'local_agent', status: 'running', agentName: 'Reviewer' },
        { type: 'local_agent', status: 'completed', agentName: 'Finished' },
      ]),
    );
    expect(result.llmContent).toContain('Reviewer');
    expect(result.llmContent).not.toContain('Finished');
  });

  it('ignores task types that SendMessage cannot address', async () => {
    const result = await run(
      makeConfig([{ type: 'bash', status: 'running', agentName: 'Shell' }]),
    );
    expect(result.llmContent).not.toContain('Shell');
  });

  it('tolerates a session with no task registry', async () => {
    const result = await run({} as Config);
    expect(result.llmContent).toBeTruthy();
  });
});
