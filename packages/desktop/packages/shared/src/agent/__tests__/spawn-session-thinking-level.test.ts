/**
 * Verifies that `spawn_session` forwards `thinkingLevel` through the
 * `SpawnSessionRequest` object so `SessionManager.onSpawnSession` can
 * pass it along to `createSession()`.
 *
 * Pairs with the corresponding fix in SessionManager.createSession that
 * reads `options?.thinkingLevel` as the first-precedence source (before
 * workspace default and global default). Without that fix, this field
 * on the request would be silently dropped.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    const result: SpawnSessionResult = {
      sessionId: 'spawned-id',
      name: 'spawned',
      status: 'started',
    };
    return result;
  };
  return { agent, captured };
}

describe('spawn_session thinkingLevel forwarding', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('forwards an explicit thinkingLevel to onSpawnSession', async () => {
    await agent.invokeSpawn({ prompt: 'hi', thinkingLevel: 'high' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.thinkingLevel).toBe('high');
  });

  it('forwards each valid thinking level unchanged', async () => {
    const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const level of levels) {
      const { agent: a, captured: c } = setup();
      await a.invokeSpawn({ prompt: 'hi', thinkingLevel: level });
      expect(c[0]?.thinkingLevel).toBe(level);
    }
  });

  it('passes through undefined when thinkingLevel is omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.thinkingLevel).toBeUndefined();
  });

  it('does not drop thinkingLevel when other optional fields are also set', async () => {
    await agent.invokeSpawn({
      prompt: 'hi',
      thinkingLevel: 'xhigh',
      permissionMode: 'ask',
      model: 'qwen3-coder-plus',
      labels: ['test'],
    });
    expect(captured[0]?.thinkingLevel).toBe('xhigh');
    expect(captured[0]?.permissionMode).toBe('ask');
    expect(captured[0]?.model).toBe('qwen3-coder-plus');
    expect(captured[0]?.labels).toEqual(['test']);
  });
});
