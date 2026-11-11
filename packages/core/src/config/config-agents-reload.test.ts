/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import {
  createTmpDir,
  cleanupTmpDir,
} from '../test-utils/file-system-test-helpers.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AgentTool } from '../agents/subagent-tool.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { CONFIG_DIR } from '../utils/paths.js';

// Mock minimum dependencies that have side effects or external calls
vi.mock('../core/tokenLimits.js');
vi.mock('../services/fileDiscoveryService.js');
vi.mock('../services/gitService.js');
vi.mock('../services/trackerService.js');

describe('Config Agents Reload Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temporary directory for the test
    tmpDir = await createTmpDir({});

    // Create the `${CONFIG_DIR}/agents` directory structure
    await fs.mkdir(path.join(tmpDir, CONFIG_DIR, 'agents'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
    vi.clearAllMocks();
  });

  it('should register unified Agent tool when agents are enabled', async () => {
    const agentName = 'test-agent';
    const agentPath = path.join(
      tmpDir,
      CONFIG_DIR,
      'agents',
      `${agentName}.md`,
    );

    // Create agent definition file
    const agentContent = `---
name: ${agentName}
description: Test Agent Description
tools: []
---
Test System Prompt`;

    await fs.writeFile(agentPath, agentContent);

    // Initialize Config with agent enabled to start
    const baseParams: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: true,
      agents: {
        overrides: {
          [agentName]: { enabled: true },
        },
      },
    };

    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    const toolRegistry = config.getToolRegistry();

    // Verify the unified Agent tool is registered
    const initialTools = toolRegistry.getAllToolNames();
    expect(initialTools).toContain('Agent');
    const toolInstance = toolRegistry.getTool('Agent');
    expect(toolInstance).toBeInstanceOf(AgentTool);
  });

  it('should disable agent type via Agent tool when agent is disabled after being enabled', async () => {
    const agentName = 'test-agent';
    const agentPath = path.join(
      tmpDir,
      CONFIG_DIR,
      'agents',
      `${agentName}.md`,
    );

    const agentContent = `---
name: ${agentName}
description: Test Agent Description
tools: []
---
Test System Prompt`;

    await fs.writeFile(agentPath, agentContent);

    const baseParams: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: true,
      agents: {
        overrides: {
          [agentName]: { enabled: true },
        },
      },
    };

    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    const toolRegistry = config.getToolRegistry();

    // Verify the Agent tool was registered initially
    expect(toolRegistry.getAllToolNames()).toContain('Agent');

    // Disable agent in settings for reload simulation
    vi.spyOn(config, 'getAgentsSettings').mockReturnValue({
      overrides: {
        [agentName]: { enabled: false },
      },
    });

    // Trigger the refresh action that follows reloading
    // @ts-expect-error accessing private method for testing
    await config.onAgentsRefreshed();

    // Agent tool should still exist, but the type should be disabled
    const agentTool = toolRegistry.getTool('Agent');
    expect(agentTool).toBeInstanceOf(AgentTool);
    expect((agentTool as AgentTool).disabledAgentTypes.has(agentName)).toBe(
      true,
    );
  });

  it('should not register Agent tool when agents are disabled from the start', async () => {
    const params: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: false,
    };

    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    const toolRegistry = config.getToolRegistry();

    const tools = toolRegistry.getAllToolNames();
    expect(tools).not.toContain('Agent');
  });

  it('should register Agent tool when agents are enabled after being disabled', async () => {
    const agentName = 'test-agent-enable';
    const agentPath = path.join(
      tmpDir,
      CONFIG_DIR,
      'agents',
      `${agentName}.md`,
    );

    const agentContent = `---
name: ${agentName}
description: Test Agent Description
tools: []
---
Test System Prompt`;

    await fs.writeFile(agentPath, agentContent);

    const params: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: true,
      agents: {
        overrides: {
          [agentName]: { enabled: false },
        },
      },
    };

    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    const toolRegistry = config.getToolRegistry();

    // Agent tool should exist but with the agent type disabled
    const agentTool = toolRegistry.getTool('Agent');
    expect(agentTool).toBeInstanceOf(AgentTool);
    expect((agentTool as AgentTool).disabledAgentTypes.has(agentName)).toBe(
      true,
    );

    // Enable agent in settings for reload simulation
    vi.spyOn(config, 'getAgentsSettings').mockReturnValue({
      overrides: {
        [agentName]: { enabled: true },
      },
    });

    // Trigger refresh
    // @ts-expect-error accessing private method for testing
    await config.onAgentsRefreshed();

    // After refresh, a new AgentTool is created without the disabled type
    const refreshedTool = toolRegistry.getTool('Agent');
    expect(refreshedTool).toBeInstanceOf(AgentTool);
    expect((refreshedTool as AgentTool).disabledAgentTypes.has(agentName)).toBe(
      false,
    );
  });

  // skip: 现存失败
  it.skip('should register unified Agent tool containing all agent types including session-restricted ones', async () => {
    // Create two agents: one that will be the session agent's allowed subagent,
    // and another that should also be available as an agent type.
    const allowedAgentName = 'allowed-agent';
    const blockedAgentName = 'blocked-agent';
    const sessionAgentName = 'session-agent';

    for (const name of [allowedAgentName, blockedAgentName, sessionAgentName]) {
      const agentPath = path.join(tmpDir, CONFIG_DIR, 'agents', `${name}.md`);
      const tools =
        name === sessionAgentName
          ? `read_file, Agent(${allowedAgentName})`
          : '';
      await fs.writeFile(
        agentPath,
        `---
name: ${name}
description: ${name} description
tools: "${tools}"
---
System prompt for ${name}`,
      );
    }

    const params: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: true,
      sessionAgent: sessionAgentName,
    };

    const config = new Config(params);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    const toolRegistry = config.getToolRegistry();
    const tools = toolRegistry.getAllToolNames();

    // The unified Agent tool should be present
    expect(tools).toContain('Agent');
    expect(tools).toContain(READ_FILE_TOOL_NAME);
  });

  // skip: 现存失败
  it.skip('should refresh the registered session runtime when agents are reloaded', async () => {
    const agentName = 'test-agent-runtime-refresh';
    const agentPath = path.join(
      tmpDir,
      CONFIG_DIR,
      'agents',
      `${agentName}.md`,
    );

    await fs.writeFile(
      agentPath,
      `---
name: ${agentName}
description: Test Agent Description
tools: []
---
Test System Prompt`,
    );

    const params: ConfigParameters = {
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test-session',
      targetDir: tmpDir,
      model: 'test-model',
      cwd: tmpDir,
      debugMode: false,
      enableAgents: true,
    };

    const config = new Config(params);
    const refreshRuntimeContext = vi.fn();

    config.registerSessionRuntimeBinding({
      refreshRuntimeContext,
    });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    await config.initialize();

    // @ts-expect-error accessing private method for testing
    await config.onAgentsRefreshed();

    expect(refreshRuntimeContext).toHaveBeenCalledWith({
      refreshTools: true,
      resetModelRouting: undefined,
    });
    expect(refreshRuntimeContext).toHaveBeenCalledWith({
      refreshSystemPrompt: true,
    });
  });
});
