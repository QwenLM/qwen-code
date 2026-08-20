/**
 * Regression test for #575
 *
 * spawn_session must expand `~`, `${HOME}`, and relative paths in
 * `workingDirectory` before handing the request to `onSpawnSession`.
 * Otherwise `child_process.spawn({ cwd })` receives a literal tilde-path
 * and the SDK fails with a misleading "cli.js not found" error.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

// Expose the protected preExecuteSpawnSession for direct invocation.
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

describe('preExecuteSpawnSession workingDirectory normalization', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('expands `~` to the home directory', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '~' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.workingDirectory).toBe(homedir());
  });

  it('expands `~/foo` to an absolute path under home', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '~/Documents/CraftAgents' });
    expect(captured[0]?.workingDirectory).toBe(join(homedir(), 'Documents/CraftAgents'));
  });

  it('expands `${HOME}/foo`', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '${HOME}/projects' });
    expect(captured[0]?.workingDirectory).toBe(join(homedir(), 'projects'));
  });

  it('expands `$HOME/foo`', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '$HOME/projects' });
    expect(captured[0]?.workingDirectory).toBe(join(homedir(), 'projects'));
  });

  it('leaves absolute paths unchanged (aside from normalization)', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '/tmp/abs/path' });
    expect(captured[0]?.workingDirectory).toBe('/tmp/abs/path');
  });

  it('resolves relative paths against cwd', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: 'relative/dir' });
    expect(captured[0]?.workingDirectory).toBe(resolve(process.cwd(), 'relative/dir'));
  });

  it('passes through undefined when workingDirectory is omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });

  it('treats empty string as undefined', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });
});
