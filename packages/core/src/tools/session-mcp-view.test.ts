/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MCPServerConfig } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type {
  DiscoveredMCPPrompt,
  DiscoveredMCPResource,
} from './mcp-client.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { passesSessionFilter, SessionMcpView } from './session-mcp-view.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Construct a minimal `DiscoveredMCPTool` stub. We only need the
 * `serverName`, `serverToolName`, and `trust` accessors for these
 * tests + the `withTrust` clone semantic.
 */
function mkTool(
  serverName: string,
  serverToolName: string,
  trust?: boolean,
): DiscoveredMCPTool {
  return new DiscoveredMCPTool(
    // mcpTool stub: tests only inspect `trust` / `name` / `serverName`,
    // never invoke the underlying CallableTool.
    undefined as unknown as ConstructorParameters<typeof DiscoveredMCPTool>[0],
    serverName,
    serverToolName,
    /* description */ 'd',
    /* parameterSchema */ { type: 'object', properties: {} },
    trust,
  );
}

function mkPrompt(name: string): DiscoveredMCPPrompt {
  return {
    name,
    serverName: 'srv',
    invoke: vi.fn(),
  };
}

function mkResource(uri: string): DiscoveredMCPResource {
  return { uri, name: uri, serverName: 'srv' };
}

function mkRegistries() {
  const toolMap = new Map<string, DiscoveredMCPTool>();
  const tools = {
    registerTool: vi.fn((t: DiscoveredMCPTool) => {
      toolMap.set(t.name, t);
    }),
    removeMcpToolsByServer: vi.fn((name: string) => {
      for (const [k, t] of toolMap) {
        if (t.serverName === name) toolMap.delete(k);
      }
    }),
    _toolMap: toolMap,
  } as unknown as ToolRegistry & {
    registerTool: ReturnType<typeof vi.fn>;
    removeMcpToolsByServer: ReturnType<typeof vi.fn>;
    _toolMap: Map<string, DiscoveredMCPTool>;
  };

  const promptList: DiscoveredMCPPrompt[] = [];
  const prompts = {
    registerPrompt: vi.fn((p: DiscoveredMCPPrompt) => {
      promptList.push(p);
    }),
    removePromptsByServer: vi.fn(() => {
      promptList.length = 0;
    }),
    _list: promptList,
  } as unknown as PromptRegistry & {
    registerPrompt: ReturnType<typeof vi.fn>;
    removePromptsByServer: ReturnType<typeof vi.fn>;
    _list: DiscoveredMCPPrompt[];
  };

  const resourceList: DiscoveredMCPResource[] = [];
  const resources = {
    registerResource: vi.fn((r: DiscoveredMCPResource) => {
      resourceList.push(r);
    }),
    removeResourcesByServer: vi.fn(() => {
      resourceList.length = 0;
    }),
    _list: resourceList,
  } as unknown as ResourceRegistry & {
    registerResource: ReturnType<typeof vi.fn>;
    removeResourcesByServer: ReturnType<typeof vi.fn>;
    _list: DiscoveredMCPResource[];
  };

  return { tools, prompts, resources };
}

describe('passesSessionFilter', () => {
  it('returns true with no filters', () => {
    expect(passesSessionFilter(mkTool('s', 'foo'))).toBe(true);
  });
  it('returns false when excluded (exclude wins over include)', () => {
    expect(passesSessionFilter(mkTool('s', 'foo'), ['foo'], ['foo'])).toBe(
      false,
    );
  });
  it('returns true when included only', () => {
    expect(passesSessionFilter(mkTool('s', 'foo'), ['foo'])).toBe(true);
    expect(passesSessionFilter(mkTool('s', 'bar'), ['foo'])).toBe(false);
  });
  it('strips parens form from include entries', () => {
    expect(passesSessionFilter(mkTool('s', 'foo'), ['foo(arg1,arg2)'])).toBe(
      true,
    );
  });
});

describe('SessionMcpView', () => {
  const cfg = new MCPServerConfig('node');

  it('applyTools registers filtered tools, calls remove first', () => {
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    view.applyTools([mkTool('srv', 'foo'), mkTool('srv', 'bar')]);
    expect(tools.removeMcpToolsByServer).toHaveBeenCalledWith('srv');
    expect(tools.registerTool).toHaveBeenCalledTimes(2);
  });

  it('applyTools per-session trust copy: snapshot tool NOT mutated (V21 C7)', () => {
    const { tools, prompts, resources } = mkRegistries();
    const snapshotTool = mkTool('srv', 'foo', /*trust*/ false);
    const viewA = new SessionMcpView(
      tools,
      prompts,
      resources,
      'A',
      'srv',
      new MCPServerConfig(
        'node',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        /*trust*/ true,
      ),
    );
    viewA.applyTools([snapshotTool]);
    expect(snapshotTool.trust).toBe(false);
    // The registered tool is a clone with session A's trust.
    const registered = (
      tools as unknown as { _toolMap: Map<string, DiscoveredMCPTool> }
    )._toolMap.get(snapshotTool.name);
    expect(registered).toBeDefined();
    expect(registered!.trust).toBe(true);
    expect(registered).not.toBe(snapshotTool);
  });

  it('applyTools skips clone when trust matches (allocation pin)', () => {
    const { tools, prompts, resources } = mkRegistries();
    const snapshotTool = mkTool('srv', 'foo', /*trust*/ true);
    const viewA = new SessionMcpView(
      tools,
      prompts,
      resources,
      'A',
      'srv',
      new MCPServerConfig(
        'node',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        /*trust*/ true,
      ),
    );
    viewA.applyTools([snapshotTool]);
    const registered = (
      tools as unknown as { _toolMap: Map<string, DiscoveredMCPTool> }
    )._toolMap.get(snapshotTool.name);
    expect(registered).toBe(snapshotTool);
  });

  it('applyTools filters by includeTools', () => {
    const { tools, prompts, resources } = mkRegistries();
    const cfgFiltered = new MCPServerConfig(
      'node',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['only_me'],
    );
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfgFiltered,
    );
    view.applyTools([mkTool('srv', 'only_me'), mkTool('srv', 'not_me')]);
    expect(tools.registerTool).toHaveBeenCalledTimes(1);
  });

  it('applyTools continues when one registration fails', () => {
    const toolMap = new Map<string, DiscoveredMCPTool>();
    const tools = {
      registerTool: vi.fn((tool: DiscoveredMCPTool) => {
        if (tool.serverToolName === 'bad') {
          throw new Error('bad tool');
        }
        toolMap.set(tool.serverToolName, tool);
      }),
      removeMcpToolsByServer: vi.fn(() => {
        toolMap.clear();
      }),
    } as unknown as ToolRegistry & {
      registerTool: ReturnType<typeof vi.fn>;
    };
    const { prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );

    expect(() =>
      view.applyTools([
        mkTool('srv', 'good_before'),
        mkTool('srv', 'bad'),
        mkTool('srv', 'good_after'),
      ]),
    ).not.toThrow();

    expect(tools.registerTool).toHaveBeenCalledTimes(3);
    expect([...toolMap.keys()]).toEqual(['good_before', 'good_after']);
  });

  it('applyPrompts registers all snapshot prompts', () => {
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    view.applyPrompts([mkPrompt('p1'), mkPrompt('p2')]);
    expect(prompts.removePromptsByServer).toHaveBeenCalledWith('srv');
    expect(prompts.registerPrompt).toHaveBeenCalledTimes(2);
  });

  it('applyPrompts filters and continues when one registration fails', () => {
    const { tools, resources } = mkRegistries();
    const promptList: string[] = [];
    const prompts = {
      registerPrompt: vi.fn((prompt: DiscoveredMCPPrompt) => {
        if (prompt.name === 'bad') {
          throw new Error('bad prompt');
        }
        promptList.push(prompt.name);
      }),
      removePromptsByServer: vi.fn(() => {
        promptList.length = 0;
      }),
    } as unknown as PromptRegistry & {
      registerPrompt: ReturnType<typeof vi.fn>;
    };
    const cfgFiltered = new MCPServerConfig(
      'node',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['keep', 'bad'],
    );
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfgFiltered,
    );

    expect(() =>
      view.applyPrompts([mkPrompt('keep'), mkPrompt('skip'), mkPrompt('bad')]),
    ).not.toThrow();

    expect(prompts.registerPrompt).toHaveBeenCalledTimes(2);
    expect(promptList).toEqual(['keep']);
  });

  it('applyResources registers all snapshot resources, calls remove first', () => {
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    view.applyResources([mkResource('file:///a'), mkResource('file:///b')]);
    expect(resources.removeResourcesByServer).toHaveBeenCalledWith('srv');
    expect(resources.registerResource).toHaveBeenCalledTimes(2);
  });

  it('applyResources([]) is a no-op so pre-existing resources survive — transient-failure guard', () => {
    // An empty snapshot can mean "resources/list failed" (swallowed to []),
    // not "no resources", so it must not wipe the session's resources.
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    // Pre-populate from an earlier (successful) snapshot.
    view.applyResources([mkResource('file:///a'), mkResource('file:///b')]);
    expect(resources._list).toHaveLength(2);
    (resources.removeResourcesByServer as ReturnType<typeof vi.fn>).mockClear();
    (resources.registerResource as ReturnType<typeof vi.fn>).mockClear();

    // A later empty snapshot (transient failure) must preserve them.
    view.applyResources([]);
    expect(resources.removeResourcesByServer).not.toHaveBeenCalled();
    expect(resources.registerResource).not.toHaveBeenCalled();
    expect(resources._list).toHaveLength(2);
  });

  it('applyResources does NOT apply the includeTools/excludeTools filter', () => {
    // A resource's identity is its URI, not a tool name; the tool-name
    // allow/deny filter must not drop resources. Here `includeTools` is
    // restricted to a name that matches no resource URI — all resources
    // must still register.
    const { tools, prompts, resources } = mkRegistries();
    const cfgFiltered = new MCPServerConfig(
      'node',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['only_this_tool'],
    );
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfgFiltered,
    );
    view.applyResources([mkResource('file:///x'), mkResource('file:///y')]);
    expect(resources.registerResource).toHaveBeenCalledTimes(2);
  });

  it('applyResources continues when one registration fails', () => {
    const { tools, prompts } = mkRegistries();
    const registered: string[] = [];
    const resources = {
      registerResource: vi.fn((r: DiscoveredMCPResource) => {
        if (r.uri === 'file:///bad') throw new Error('bad resource');
        registered.push(r.uri);
      }),
      removeResourcesByServer: vi.fn(),
    } as unknown as ResourceRegistry & {
      registerResource: ReturnType<typeof vi.fn>;
    };
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    expect(() =>
      view.applyResources([
        mkResource('file:///good1'),
        mkResource('file:///bad'),
        mkResource('file:///good2'),
      ]),
    ).not.toThrow();
    expect(resources.registerResource).toHaveBeenCalledTimes(3);
    expect(registered).toEqual(['file:///good1', 'file:///good2']);
  });

  it('updateConfig changes filter for subsequent applyTools', () => {
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    view.applyTools([mkTool('srv', 'foo')]);
    expect(tools.registerTool).toHaveBeenCalledTimes(1);

    // Tighten filter to exclude foo.
    view.updateConfig(
      new MCPServerConfig(
        'node',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['foo'],
      ),
    );
    view.applyTools([mkTool('srv', 'foo')]);
    // Second apply removes existing first, then filters out foo.
    expect(tools.removeMcpToolsByServer).toHaveBeenCalledTimes(2);
    // No additional registration (still 1 from before).
    expect(tools.registerTool).toHaveBeenCalledTimes(1);
  });

  it('teardown drops all three registries (idempotent across calls)', () => {
    const { tools, prompts, resources } = mkRegistries();
    const view = new SessionMcpView(
      tools,
      prompts,
      resources,
      'sid',
      'srv',
      cfg,
    );
    view.applyTools([mkTool('srv', 'foo')]);
    view.applyPrompts([mkPrompt('p1')]);
    view.applyResources([mkResource('file:///a')]);

    view.teardown();
    view.teardown(); // idempotent

    expect(tools.removeMcpToolsByServer).toHaveBeenLastCalledWith('srv');
    expect(prompts.removePromptsByServer).toHaveBeenLastCalledWith('srv');
    expect(resources.removeResourcesByServer).toHaveBeenLastCalledWith('srv');
  });
});
