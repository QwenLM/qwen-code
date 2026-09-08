/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Storage } from '../../config/storage.js';
import type { Config } from '../../config/config.js';
import { ToolNames } from '../../tools/tool-names.js';
import { resolveAgentPersona } from './persona.js';
import { updateWorkspaceAgents } from './store.js';
import { THREAD_TOOL_NAMES } from './capability.js';
import type { WorkspaceAgent } from './types.js';

const PROJECT_ROOT = '/agent-persona-test';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const ALICE_WITH_DEFINITION: WorkspaceAgent = {
  ...ALICE,
  agentType: 'general-purpose',
};

/**
 * The three things persona resolution asks a Config for. Faking exactly those
 * keeps the test about what the resolver decides rather than about how a
 * Config is built.
 */
function makeConfig(
  overrides: {
    loadSubagent?: ReturnType<typeof vi.fn>;
    convertToRuntimeConfig?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const loadSubagent =
    overrides.loadSubagent ??
    vi.fn().mockResolvedValue({ name: 'general-purpose', model: 'from-def' });
  const convertToRuntimeConfig =
    overrides.convertToRuntimeConfig ??
    vi.fn().mockResolvedValue({
      promptConfig: { systemPrompt: 'You are a careful reviewer.' },
      toolConfig: { tools: ['*'] },
    });
  return {
    config: {
      getProjectRoot: () => PROJECT_ROOT,
      getSubagentManager: () => ({ loadSubagent, convertToRuntimeConfig }),
    } as unknown as Config,
    loadSubagent,
    convertToRuntimeConfig,
  };
}

describe('resolveAgentPersona', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-persona-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const seed = (agents: WorkspaceAgent[]) =>
    updateWorkspaceAgents(PROJECT_ROOT, () => agents);

  it('resolves a roster entry into the persona its process runs as', async () => {
    await seed([ALICE]);
    const { config, loadSubagent } = makeConfig();

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.agent.name).toBe('alice');
    expect(result.systemPrompt).toContain(
      'an independent persistent workspace Agent',
    );
    expect(result.systemPrompt).not.toContain('subagent');
    expect(loadSubagent).not.toHaveBeenCalled();
  });

  it('refuses an id with no roster entry', async () => {
    // The agent was deleted while its session was starting. Booting a generic
    // assistant here would still post under this agent's name.
    await seed([ALICE_WITH_DEFINITION]);
    const { config } = makeConfig();

    const result = await resolveAgentPersona(config, 'ag_nobody');

    expect(result.status).toBe('unknown_agent');
  });

  it('refuses a disabled agent', async () => {
    await seed([{ ...ALICE, enabled: false }]);
    const { config } = makeConfig();

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('unavailable');
  });

  it('refuses when the definition will not load', async () => {
    // A misconfigured workspace fails closed in this direction too.
    await seed([ALICE_WITH_DEFINITION]);
    const { config } = makeConfig({
      loadSubagent: vi.fn().mockResolvedValue(undefined),
    });

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('unavailable');
  });

  it('refuses when converting the definition throws', async () => {
    await seed([ALICE_WITH_DEFINITION]);
    const { config } = makeConfig({
      convertToRuntimeConfig: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('unavailable');
  });

  it("lets the roster's model override the shared definition's", async () => {
    // The definition is shared across identities; the model is what a person
    // set for this one.
    await seed([{ ...ALICE_WITH_DEFINITION, model: 'from-roster' }]);
    const { config } = makeConfig();

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.model).toBe('from-roster');
  });

  it("appends this identity's own instructions after the definition", async () => {
    // After, so where the two disagree the identity wins.
    await seed([
      {
        ...ALICE_WITH_DEFINITION,
        instructions: 'Always check the changelog.',
      },
    ]);
    const { config } = makeConfig();

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.systemPrompt.indexOf('careful reviewer')).toBeLessThan(
      result.systemPrompt.indexOf('Always check the changelog.'),
    );
  });

  it('applies the read-only ceiling in the process that will run the tools', async () => {
    // A definition asking for everything still cannot get an editing tool: the
    // boundary is applied here, so a session cannot start wider and be
    // narrowed afterwards.
    await seed([ALICE_WITH_DEFINITION]);
    const { config } = makeConfig();

    const result = await resolveAgentPersona(config, ALICE.id);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.toolConfig.tools).toEqual(
      expect.arrayContaining([...THREAD_TOOL_NAMES]),
    );
    expect(result.toolConfig.tools).not.toContain(ToolNames.EDIT);
    expect(result.toolConfig.tools).not.toContain(ToolNames.SHELL);
    expect(result.toolConfig.disallowedTools).toEqual(
      expect.arrayContaining([ToolNames.EDIT, ToolNames.SHELL]),
    );
  });
});
