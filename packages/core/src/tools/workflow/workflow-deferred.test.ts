/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from '../../config/config.js';
import { buildDeferredToolsReminder } from '../../core/environmentContext.js';
import {
  resolveWorkflowContext,
  resolveWorkflowIntent,
} from '../../core/workflow-intent.js';
import { WorkflowModeContext } from '../../core/workflow-mode.js';
import { runWithAgentContext } from '../../agents/runtime/agent-context.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { ToolRegistry } from '../tool-registry.js';
import { ToolSearchTool } from '../tool-search.js';
import { resolveDeferredToolCall, ToolCallTool } from '../tool-call.js';
import { ToolErrorType } from '../tool-error.js';
import { ToolNames } from '../tool-names.js';
import { ToolMode } from '../code-mode.js';
import { WorkflowTool } from './workflow.js';

afterEach(() => vi.restoreAllMocks());

function fixture(params: Partial<ConfigParameters> = {}) {
  const config = new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    debugMode: false,
    workflowsEnabled: true,
    ...params,
  });
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  const search = new ToolSearchTool(config);
  registry.registerTool(search);
  registry.registerTool(new ToolCallTool());
  registry.registerTool(new MockTool({ name: ToolNames.EXEC }));
  const workflow = new WorkflowTool(config);
  registry.registerTool(workflow);
  const lookup = (query = 'select:workflow') =>
    search.build({ query }).execute(new AbortController().signal);
  return { config, registry, workflow, lookup };
}

describe('deferred Workflow discovery', () => {
  it('keeps only the short catalog entry in a fresh Direct request', () => {
    const { registry, workflow } = fixture();
    expect(registry.getFunctionDeclarations()).not.toContainEqual(
      workflow.schema,
    );
    expect(
      registry.getFunctionDeclarations({ includeDeferred: true }),
    ).toContainEqual(workflow.schema);
    const reminder = buildDeferredToolsReminder(registry);
    expect(reminder).toContain('"workflow"');
    expect(reminder).toContain(workflow.description.split('\n')[0]);
    expect(reminder).not.toContain('**Runtime**');
    expect(reminder).not.toContain('parametersJsonSchema');
  });

  it.each(['select:workflow', 'workflow orchestration'])(
    'returns the full schema without expanding declarations: %s',
    async (query) => {
      const { registry, workflow, lookup } = fixture();
      const declarations = registry.getFunctionDeclarations();
      const envelope = {
        name: 'workflow',
        arguments: { script: 'return 42;' },
      };
      expect(await resolveDeferredToolCall(registry, envelope)).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        error: expect.objectContaining({
          message: expect.stringContaining('no verified schema review'),
        }),
      });
      const result = await lookup(query);
      expect(result.error).toBeUndefined();
      const block = String(result.llmContent).match(
        /<function>([\s\S]*?)<\/function>/,
      );
      expect(block).not.toBeNull();
      expect(JSON.parse(block![1])).toEqual(workflow.schema);
      expect(await resolveDeferredToolCall(registry, envelope)).toEqual({
        tool: workflow,
        arguments: envelope.arguments,
      });
      expect(registry.getFunctionDeclarations()).toEqual(declarations);
      expect(registry.isDeferredAndHidden('workflow')).toBe(true);
    },
  );

  it('directs native-deferred keyword and mode requests through the bridge', () => {
    const { config, registry } = fixture();
    const intent = resolveWorkflowIntent(config, { text: 'workflow' });
    const context = resolveWorkflowContext(config);
    const mode = new WorkflowModeContext();
    mode.setRequested(true);
    for (const reminder of [
      intent?.reminder,
      mode.prepare(context, null).reminder,
    ]) {
      expect(reminder).toContain('`tool_search`');
      expect(reminder).toContain('`tool_call`');
    }
    expect(registry.isDeferredAndHidden('workflow')).toBe(true);
  });

  it.each([ToolNames.TOOL_SEARCH, ToolNames.TOOL_CALL])(
    'does not advertise a hidden tool when %s is missing',
    (name) => {
      const { config, registry } = fixture();
      registry.unregisterTool(name);
      expect(resolveWorkflowContext(config)).toBeNull();
      registry.revealDeferredTool('workflow');
      expect(resolveWorkflowContext(config)?.bridgeWorkflowTool).toBe(false);
    },
  );

  it('honors explicit visibility without suggesting bridge discovery', () => {
    const { config, registry, workflow } = fixture({
      visibleTools: ['workflow'],
    });
    expect(registry.getFunctionDeclarations()).toContainEqual(workflow.schema);
    expect(buildDeferredToolsReminder(registry)).toBeNull();
    expect(resolveWorkflowContext(config)?.bridgeWorkflowTool).toBe(false);
  });

  it('preserves budget preload and restores deferral after clearing reveals', () => {
    const { config, registry, workflow } = fixture();
    expect(registry.preloadDeferredToolsWithinBudget(0)).toBe(0);
    expect(registry.preloadDeferredToolsWithinBudget(100_000)).toBe(1);
    expect(registry.getFunctionDeclarations()).toContainEqual(workflow.schema);
    expect(resolveWorkflowContext(config)?.bridgeWorkflowTool).toBe(false);
    registry.clearRevealedDeferredTools();
    expect(registry.getFunctionDeclarations()).not.toContainEqual(
      workflow.schema,
    );
    expect(resolveWorkflowContext(config)?.bridgeWorkflowTool).toBe(true);
  });

  it('keeps CodeMode discovery behind exec without Direct bridge instructions', async () => {
    const { config, registry, workflow, lookup } = fixture({
      toolMode: ToolMode.CodeModeOnly,
    });
    const declarations = registry.getFunctionDeclarations();
    expect(JSON.stringify(declarations)).not.toContain('tools.workflow(args:');
    expect(resolveWorkflowContext(config)?.bridgeWorkflowTool).toBe(false);
    const result = await lookup();
    const block = String(result.llmContent).match(
      /<function>([\s\S]*?)<\/function>/,
    );
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toMatchObject({
      ...workflow.schema,
      jsName: 'workflow',
    });
    expect(result.llmContent).toContain('through exec');
    expect(registry.getFunctionDeclarations()).toEqual(declarations);
  });

  it('retains the named-only schema through discovery', async () => {
    const { workflow, lookup } = fixture({ workflowNameOnly: true });
    const result = await lookup();
    const block = String(result.llmContent).match(
      /<function>([\s\S]*?)<\/function>/,
    );
    expect(JSON.parse(block![1])).toEqual(workflow.schema);
    expect(workflow.parameterSchema).toHaveProperty('properties.name');
    expect(workflow.parameterSchema).not.toHaveProperty('properties.script');
    expect(() => workflow.build({ script: 'return 42;' })).toThrow(
      'named workflows',
    );
  });

  it('does not let a reviewed deferred Workflow bypass subagent restrictions', async () => {
    const { registry, lookup } = fixture();
    await lookup();
    const result = await runWithAgentContext('child', () =>
      resolveDeferredToolCall(registry, {
        name: 'workflow',
        arguments: { script: 'return 42;' },
      }),
    );
    expect(result).toMatchObject({ errorType: ToolErrorType.EXECUTION_DENIED });
    expect(result).not.toHaveProperty('tool');
  });

  it('keeps mid-session review activation deferred and discoverable', async () => {
    const { config, registry, lookup } = fixture({
      workflowsEnabled: undefined,
    });
    registry.unregisterTool('workflow');
    const declarations = registry.getFunctionDeclarations();
    const setTools = vi.fn(async () => registry.warmAll());
    vi.spyOn(config, 'getLlmClient').mockReturnValue({ setTools } as never);
    await config.enableReviewWorkflow();
    expect(config.isWorkflowsEnabled()).toBe(true);
    expect(setTools).toHaveBeenCalledOnce();
    expect(registry.isDeferredAndHidden('workflow')).toBe(true);
    expect((await lookup()).llmContent).toContain('"name":"workflow"');
    expect(registry.getFunctionDeclarations()).toEqual(declarations);
  });
});
