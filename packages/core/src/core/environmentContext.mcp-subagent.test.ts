/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Config } from '../config/config.js';
import type { MCPServerConfig } from '../config/config.js';
import { buildMcpServerInstructionsReminder } from './environmentContext.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { CallableTool } from '@google/genai';
import {
  rebuildToolRegistryOnOverride,
  hasRebuiltToolRegistry,
} from '../tools/agent/agent.js';

// Why this exists.
//
// `getInitialChatHistory` gates two of its three reminder parts and leaves
// `buildMcpServerInstructionsReminder` ungated, which reads as an oversight:
// the skills reminder is suppressed for subagents precisely because announcing
// something the agent cannot use wastes a turn.
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
    });
    configs.push(config);
    return config;
  }

  it('leaves a skipDiscovery registry with no server instructions', async () => {
    const config = makeConfig({ 'server-a': { command: 'a' } });
    await config.initialize({
      skipLlmInitialization: true,
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

  it('leaves a long-lived override unmarked when asked', async () => {
    // The marker means "a descendant may skip its own rebuild", and
    // `hasRebuiltToolRegistry` reads it through the PROTOTYPE CHAIN. On a
    // short-lived per-launch override that is the point; on a config an agent
    // keeps — `InProcessBackend`'s per-agent config — it hands that permission
    // to every wrapper built on it later.
    //
    // The one that matters is a dir-scoped workflow dispatch: its wrapper
    // rebinds only the dir getters, so the rebuild it would otherwise run is
    // the sole re-anchoring that lifts the subagent's tools above the wrapper.
    // Skipped, relative paths resolve against the parent's working directory
    // instead of the provisioned worktree.
    const config = makeConfig({ 'server-a': { command: 'a' } });
    await config.initialize({
      skipLlmInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipFileCheckpointing: true,
    });

    const longLived = Object.create(config) as typeof config;
    await rebuildToolRegistryOnOverride(longLived, config, {
      markRebuilt: false,
    });
    expect(hasRebuiltToolRegistry(longLived)).toBe(false);
    // …and a wrapper on it still owes its own rebuild.
    const dirScoped = Object.create(longLived) as typeof config;
    expect(hasRebuiltToolRegistry(dirScoped)).toBe(false);

    // The default is unchanged for the per-launch callers that want it.
    const perLaunch = Object.create(config) as typeof config;
    await rebuildToolRegistryOnOverride(perLaunch, config);
    expect(hasRebuiltToolRegistry(perLaunch)).toBe(true);
  });

  it('does not carry instructions across a tool copy from the parent', async () => {
    // Drives `rebuildToolRegistryOnOverride` itself — the function the spawn
    // path uses — rather than re-enacting its two steps. Re-enacting them
    // pins `copyDiscoveredToolsFrom`'s contract only, and a change that
    // propagated instructions inside the rebuild would survive.
    const config = makeConfig({ 'server-a': { command: 'a' } });
    await config.initialize({
      skipLlmInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipFileCheckpointing: true,
    });

    // The parent must actually HOLD instructions, or this asserts nothing:
    // discovery is skipped in tests, so an un-stubbed parent reports an empty
    // map and the copy below would be trivially empty either way. (Measured:
    // without this stub a mutation that propagates instructions still passes.)
    //
    // Stubbed on the MANAGER, not on the registry getter. Instructions live on
    // `McpClientManager`; the registry method only delegates. A subagent
    // registry that SHARED the parent's manager would read the real manager
    // and never touch a registry-level stub — measured: with the stub one
    // layer up, `this.mcpClientManager = source.mcpClientManager` in the copy
    // survives green, while in production that shares live connected clients.
    const parent = config.getToolRegistry();
    vi.spyOn(
      parent.getMcpClientManager(),
      'getServerInstructions',
    ).mockReturnValue(new Map([['server-a', 'Prefer concise replies.']]));
    expect(parent.getMcpServerInstructions().size).toBe(1);

    // …and the parent must hold a discovered TOOL, or the copy below iterates
    // an empty map and its body never runs. A change that propagated a copied
    // tool's server instructions — a shape closer to this method's tools-only
    // design than a whole-map copy — would then copy nothing and leave the
    // assertions green, blessing the regression this file exists to catch.
    parent.registerTool(
      new DiscoveredMCPTool(
        {} as CallableTool,
        'server-a',
        'do_thing',
        'A discovered tool from server-a.',
        { type: 'object', properties: {} },
      ),
    );

    const override = Object.create(config) as typeof config;
    await rebuildToolRegistryOnOverride(override, config);
    const subagentRegistry = override.getToolRegistry();

    // The rebuild really produced a different registry that took the copy.
    expect(subagentRegistry).not.toBe(parent);
    expect(subagentRegistry.getTool('mcp__server-a__do_thing')).toBeDefined();

    expect(subagentRegistry.getMcpServerInstructions().size).toBe(0);
    expect(buildMcpServerInstructionsReminder(subagentRegistry)).toBeNull();
    // The structural half: sharing the manager is the other way instructions
    // could arrive, and it would defeat any assertion phrased on contents
    // alone once the parent's manager holds real clients.
    expect(subagentRegistry.getMcpClientManager()).not.toBe(
      parent.getMcpClientManager(),
    );
  });
});
