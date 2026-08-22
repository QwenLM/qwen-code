/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Config } from '../config/config.js';
import type { MCPServerConfig } from '../config/config.js';
import { buildMcpServerInstructionsReminder } from './environmentContext.js';

// Why this exists.
//
// `getInitialChatHistory` gates three of its four reminder parts and leaves
// `buildMcpServerInstructionsReminder` ungated, which reads as an oversight:
// the skills and deferred-tools reminders are both suppressed for subagents
// precisely because announcing something the agent cannot use wastes a turn.
//
// The MCP part needs no gate, and this pins the reason so the asymmetry is not
// "fixed" into a behaviour change. Server instructions live on the
// `McpClientManager` that each `ToolRegistry` constructs for itself, and they
// are populated only by discovery. A subagent's registry is built with
// `skipDiscovery: true`, and `copyDiscoveredToolsFrom` copies TOOLS from the
// parent — not instructions. So the map is empty and the reminder is already
// null, without a flag.
//
// The failure this guards against is a future change that shares the parent's
// manager, or copies instructions along with the tools: the reminder would
// start riding into every subagent's first message silently, since nothing
// else asserts it does not.
describe('MCP server instructions and subagent registries', () => {
  const configs: Config[] = [];

  afterEach(async () => {
    while (configs.length) {
      await configs.pop()?.shutdown();
    }
  });

  function makeConfig(mcpServers: Record<string, MCPServerConfig>): Config {
    const config = new Config({
      sessionId: `mcp-subagent-${configs.length}`,
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: false,
      model: 'test-model',
      mcpServers,
    } as ConstructorParameters<typeof Config>[0]);
    configs.push(config);
    return config;
  }

  it('leaves a skipDiscovery registry with no server instructions', async () => {
    const config = makeConfig({ 'server-a': { command: 'a' } });
    await config.initialize({
      skipGeminiInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipFileCheckpointing: true,
    });

    // The shape `AgentTool` builds for every subagent launch.
    const subagentRegistry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });

    expect(subagentRegistry.getMcpServerInstructions().size).toBe(0);
    expect(buildMcpServerInstructionsReminder(subagentRegistry)).toBeNull();
  });

  it('does not carry instructions across a tool copy from the parent', async () => {
    // `rebuildToolRegistryOnOverride` copies the parent's discovered tools into
    // the fresh registry. If a future change copied instructions with them,
    // the reminder would reappear — this is the assertion that would fail.
    const config = makeConfig({ 'server-a': { command: 'a' } });
    await config.initialize({
      skipGeminiInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipFileCheckpointing: true,
    });

    // The parent must actually HOLD instructions, or this asserts nothing:
    // discovery is skipped in tests, so an un-stubbed parent reports an empty
    // map and the copy below would be trivially empty either way. (Measured:
    // without this stub a mutation that propagates instructions still passes.)
    const parent = config.getToolRegistry();
    vi.spyOn(parent, 'getMcpServerInstructions').mockReturnValue(
      new Map([['server-a', 'Prefer concise replies.']]),
    );
    expect(parent.getMcpServerInstructions().size).toBe(1);

    const subagentRegistry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });
    subagentRegistry.copyDiscoveredToolsFrom(parent);

    expect(subagentRegistry.getMcpServerInstructions().size).toBe(0);
    expect(buildMcpServerInstructionsReminder(subagentRegistry)).toBeNull();
  });
});
