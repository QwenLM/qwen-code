/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { FunctionDeclaration } from '@google/genai';
import { AgentCore } from './agent-core.js';
import { ToolNames } from '../../tools/tool-names.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { ExecTool } from '../../tools/exec.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { ToolSearchTool } from '../../tools/tool-search.js';

// The skill-announcement gate asks whether the model can INVOKE a skill, and
// that is two conditions, not one.
//
// Declared: `willHaveSkillTool()` reads only the `toolConfig` — the name list
// and the `disallowedTools` blocklist — so it is blind to a tool the
// permission layer kept out of the registry and to an inline declaration. So
// the gate reads the declarations `prepareTools` produced.
//
// Executable: being declared is not sufficient. A fork keeps the parent's
// declared names for prompt-cache parity while `fork_tools` narrows what may
// run, so `skill` can sit in the declarations and still be refused at call
// time — a wasted turn, and the announcement is consumed on the shared Config
// either way, hiding the activation from the session that can act on it.
describe('AgentCore skill-gate inputs', () => {
  function registryWith(names: string[]) {
    const declarations: FunctionDeclaration[] = names.map((name) => ({ name }));
    return {
      warmAll: vi.fn().mockResolvedValue(undefined),
      getFunctionDeclarations: vi.fn().mockReturnValue(declarations),
      getFunctionDeclarationsFiltered: vi
        .fn()
        .mockImplementation((wanted: string[]) =>
          declarations.filter((d) => wanted.includes(d.name as string)),
        ),
      getTool: vi.fn().mockReturnValue(undefined),
    };
  }

  function makeCore(
    toolConfig: unknown,
    registryNames = [ToolNames.READ_FILE, ToolNames.SKILL, ToolNames.GREP],
  ) {
    const registry = registryWith(registryNames);
    const runtimeContext = {
      getToolRegistry: () => registry,
      getMaxSubagentDepth: () => 5,
      getDebugLogger: () => undefined,
    };
    return new AgentCore(
      'probe',
      runtimeContext as never,
      { systemPrompt: '' } as never,
      { model: 'test-model' } as never,
      { max_turns: 1 } as never,
      toolConfig as never,
    );
  }

  /** The gate's first half: the names actually sent to the model. */
  async function declaredNames(core: AgentCore): Promise<Set<string>> {
    const declarations = await core.prepareTools();
    return new Set(
      declarations.map((d) => d.name).filter((n): n is string => !!n),
    );
  }

  /** The gate's second half, as `processFunctionCalls` reaches it. */
  function executable(core: AgentCore, tool: string): boolean {
    return (
      core as unknown as { isToolExecutionAllowed: (t: string) => boolean }
    ).isToolExecutionAllowed.call(core, tool);
  }

  /** The fork shape: `fork_tools` narrows execution to `tools`. */
  function restrictExecution(core: AgentCore, tools: string[]): void {
    const internals = core as unknown as {
      executionAllowedTools?: string[];
      executionAllowedExactTools?: Set<string>;
    };
    internals.executionAllowedTools = tools;
    internals.executionAllowedExactTools = new Set(tools);
  }

  /** A CodeModeOnly core over a real registry: exec, then `toolNames`. */
  function codeModeCore(
    name: string,
    toolConfig: ConstructorParameters<typeof AgentCore>[5],
    toolNames: string[],
  ) {
    const config = makeFakeConfig({ codeModeOnly: true });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    for (const toolName of toolNames)
      registry.registerTool(new MockTool({ name: toolName }));
    return new AgentCore(
      name,
      config,
      { systemPrompt: '' } as never,
      { model: 'test-model' } as never,
      { max_turns: 1 } as never,
      toolConfig,
    );
  }

  async function execDeclaration(core: AgentCore) {
    const declarations = await core.prepareTools();
    return declarations.find((item) => item.name === ToolNames.EXEC);
  }

  const codeModeAllowed = (core: AgentCore) =>
    (core as unknown as { codeModeAllowedToolNames?: readonly string[] })
      .codeModeAllowedToolNames;

  describe('declared', () => {
    it('excludes a tool the disallowedTools blocklist removed', async () => {
      // `tools: ['*']` says "everything", so a `toolConfig`-based read reports
      // SKILL as available; the blocklist is applied after, to the list.
      const core = makeCore({
        tools: ['*'],
        disallowedTools: [ToolNames.SKILL],
      });
      expect((await declaredNames(core)).has(ToolNames.SKILL)).toBe(false);
    });

    it('excludes a tool absent from an inline-only declaration set', async () => {
      // No string entries at all: `prepareTools` declares exactly the inline
      // ones, while a `toolConfig.tools` read sees an empty string list and
      // concludes the agent inherits everything.
      const core = makeCore({ tools: [{ name: ToolNames.READ_FILE }] });
      expect([...(await declaredNames(core))]).toEqual([ToolNames.READ_FILE]);
    });

    it('excludes a tool the registry never held', async () => {
      // The permission layer keeps a tool out of the registry, so naming it in
      // an explicit list does not declare it.
      const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] }, [
        ToolNames.READ_FILE,
      ]);
      expect((await declaredNames(core)).has(ToolNames.SKILL)).toBe(false);
    });

    it('includes a tool that survives every filter', async () => {
      // The other direction, so the set is not mistaken for "always empty".
      const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] });
      expect((await declaredNames(core)).has(ToolNames.SKILL)).toBe(true);
    });
  });

  /** The gate itself — the answer, not its inputs. */
  function gate(core: AgentCore, declared: Set<string>): boolean {
    return (
      core as unknown as {
        canInvokeSkill: (d: ReadonlySet<string | undefined>) => boolean;
      }
    ).canInvokeSkill.call(core, declared);
  }

  describe('the gate combines both', () => {
    it('refuses when declared but not executable', async () => {
      // The fork Critical. Checking the two inputs separately is not enough:
      // dropping the execution term leaves every input assertion green.
      const core = makeCore({ tools: ['*'] });
      restrictExecution(core, [ToolNames.READ_FILE]);

      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('refuses when executable but not declared', async () => {
      // The other term: `disallowedTools` removes SKILL at declaration, so
      // the gate refuses what the registry could still execute. This case no
      // longer distinguishes the gate from `willHaveSkillTool()` — the shared
      // predicate reads the blocklist too, so both now answer false for this
      // input. Snapshot-versus-gate independence is pinned by 'announces at
      // startup and refuses at the gate' below, which re-points the snapshot
      // at a registry that never held the tool.
      const core = makeCore({
        tools: ['*'],
        disallowedTools: [ToolNames.SKILL],
      });
      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('opens only when both hold', async () => {
      const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] });
      expect(gate(core, await declaredNames(core))).toBe(true);
    });
  });

  // The gate and the startup snapshot are INDEPENDENT, not ordered. Both
  // directions are pinned because the option doc now claims both, and a claim
  // in a comment with no test behind it is how this PR's earlier rounds went
  // stale: an ordering was asserted, the mechanism changed, and the assertion
  // outlived it.
  describe('gate versus startup snapshot', () => {
    function snapshot(core: AgentCore): boolean {
      return (
        core as unknown as { willHaveSkillTool: () => boolean }
      ).willHaveSkillTool.call(core);
    }

    it('announces at startup and refuses at the gate', async () => {
      // `toolConfig` names SKILL, but the permission layer kept it out of the
      // registry, so it is never declared.
      const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] }, [
        ToolNames.READ_FILE,
      ]);
      expect(snapshot(core)).toBe(true);
      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('stays silent at startup when the blocklist removes SKILL (#12424)', async () => {
      // The snapshot shares its predicate with the SkillManager decision in
      // SubagentManager, which honours `disallowedTools`; before that it
      // announced every skill to an agent that could load none of them.
      const core = makeCore({
        tools: ['*'],
        disallowedTools: [ToolNames.SKILL],
      });
      expect(snapshot(core)).toBe(false);
      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('stays silent at startup and opens at the gate', async () => {
      // The reverse: `willHaveSkillTool` reads only the STRING entries, so an
      // inline declaration is invisible to it, while `prepareTools` passes it
      // through. Neither predicate bounds the other.
      const core = makeCore({
        tools: [ToolNames.READ_FILE, { name: ToolNames.SKILL }],
      });
      expect(snapshot(core)).toBe(false);
      expect(gate(core, await declaredNames(core))).toBe(true);
    });
  });

  describe('code mode skill gate', () => {
    const makeCodeModeCore = (
      toolConfig: ConstructorParameters<typeof AgentCore>[5],
      includeSkill = true,
    ) =>
      codeModeCore('skill-code-mode', toolConfig, [
        ToolNames.READ_FILE,
        ToolNames.TEAM_DELETE,
        ToolNames.CRON_CREATE,
        ...(includeSkill ? [ToolNames.SKILL] : []),
      ]);

    it('announces the listing for an exec-only agent under CodeModeOnly', () => {
      // `prepareTools()` admits every code-mode-callable binding when the
      // configured names include `exec`, and SKILL is one of them, so this
      // agent can load skills and must be told they exist. Dropping the
      // tool-mode argument at the `willHaveSkillTool()` call site turns this
      // red while `SubagentManager` still keeps the SkillManager — the
      // listing-versus-pointer disagreement #12424 exists to remove.
      const core = makeCodeModeCore({ tools: [ToolNames.EXEC] });
      expect(
        (
          core as unknown as { willHaveSkillTool: () => boolean }
        ).willHaveSkillTool.call(core),
      ).toBe(true);
    });

    it.each([
      { tools: ['*'] },
      { tools: [ToolNames.SKILL] },
      { tools: [ToolNames.EXEC], executionAllowedTools: [ToolNames.EXEC] },
    ])('opens for an executable nested skill: %j', async (toolConfig) => {
      const core = makeCodeModeCore(toolConfig);
      const declared = await declaredNames(core);
      expect(declared).toEqual(new Set([ToolNames.EXEC]));
      expect(gate(core, declared)).toBe(true);
    });

    it.each([
      { tools: ['*'], disallowedTools: [ToolNames.SKILL] },
      { tools: ['*'], disallowedTools: [ToolNames.EXEC] },
      { tools: [ToolNames.READ_FILE] },
      { tools: [ToolNames.EXEC], executionAllowedTools: [ToolNames.READ_FILE] },
    ])(
      'closes when skill is outside effective permissions: %j',
      async (toolConfig) => {
        const core = makeCodeModeCore(toolConfig);
        expect(gate(core, await declaredNames(core))).toBe(false);
      },
    );

    it('prepares a fork policy when inherited declarations skip preparation', async () => {
      const core = makeCodeModeCore({
        tools: [ToolNames.EXEC],
        executionAllowedTools: [ToolNames.READ_FILE],
      });
      const prepare = vi.spyOn(core, 'prepareTools');
      await core.processFunctionCalls(
        [],
        new AbortController(),
        'fork-prompt',
        1,
        [{ name: ToolNames.EXEC }],
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(codeModeAllowed(core)).toEqual([ToolNames.READ_FILE]);
      expect(gate(core, new Set([ToolNames.EXEC]))).toBe(false);
    });

    it('closes for an unregistered skill', async () => {
      const core = makeCodeModeCore({ tools: ['*'] }, false);
      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('keeps newly nested leader tools out of the subagent catalog', async () => {
      const core = makeCodeModeCore({ tools: ['*'] });
      const description = (await execDeclaration(core))?.description;
      expect(description).toContain('tools.skill(args:');
      expect(description).not.toContain('tools.team_delete(args:');
      expect(description).not.toContain('tools.cron_create(args:');
    });
  });

  describe('executable', () => {
    it.each([
      { tools: ['read_file'] },
      { tools: ['exec'], executionAllowedTools: ['read_file'] },
      { tools: ['*'], disallowedTools: ['write_file'] },
    ])(
      'offers scoped discovery for deferred Code Mode tools: %j',
      async (toolConfig) => {
        const config = makeFakeConfig({ codeModeOnly: true });
        const registry = new ToolRegistry(config);
        vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
        registry.registerTool(new ExecTool(config));
        registry.registerTool(new ToolSearchTool(config));
        registry.registerTool(
          new MockTool({ name: 'read_file', shouldDefer: true }),
        );
        registry.registerTool(
          new MockTool({ name: 'write_file', shouldDefer: true }),
        );
        vi.spyOn(registry, 'isPermissionDeferred').mockReturnValue(true);
        const core = new AgentCore(
          'lazy-agent',
          config,
          { systemPrompt: '' },
          { model: 'test-model' },
          { max_turns: 1 },
          toolConfig,
        );
        const declarations = await core.prepareTools();
        expect(declarations.map((d) => d.name)).toEqual([
          'exec',
          'tool_search',
        ]);
        expect(declarations[0].description).not.toContain(
          'tools.read_file(args:',
        );
        expect(executable(core, 'tool_search')).toBe(true);
        expect(
          (core as unknown as { codeModeAllowedToolNames: string[] })
            .codeModeAllowedToolNames,
        ).toEqual(['read_file']);
      },
    );

    it('falls back to scoped signatures when the agent disallows search', async () => {
      const config = makeFakeConfig({ codeModeOnly: true });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new ToolSearchTool(config));
      registry.registerTool(
        new MockTool({ name: 'read_file', shouldDefer: true }),
      );
      registry.registerTool(
        new MockTool({ name: 'write_file', shouldDefer: true }),
      );
      const core = new AgentCore(
        'lazy-agent',
        config,
        { systemPrompt: '' },
        { model: 'test-model' },
        { max_turns: 1 },
        { tools: ['read_file'], disallowedTools: ['tool_search'] },
      );
      const declarations = await core.prepareTools();
      expect(declarations.map((d) => d.name)).toEqual(['exec']);
      expect(declarations[0].description).toContain('tools.read_file(args:');
      expect(declarations[0].description).not.toContain(
        'tools.write_file(args:',
      );
      expect(executable(core, 'tool_search')).toBe(false);
    });

    it('allows everything when no execution allowlist is set', () => {
      const core = makeCore({ tools: ['*'] });
      expect(executable(core, ToolNames.SKILL)).toBe(true);
    });

    it('refuses a declared tool the fork allowlist withholds', async () => {
      // The fork shape: declarations keep the parent's names for prompt-cache
      // parity while `fork_tools` narrows execution. SKILL is declared AND
      // unusable, so a gate reading declarations alone opens on it.
      const core = makeCore({ tools: ['*'] });
      restrictExecution(core, [ToolNames.READ_FILE]);

      expect((await declaredNames(core)).has(ToolNames.SKILL)).toBe(true);
      expect(executable(core, ToolNames.SKILL)).toBe(false);
    });

    it('uses exec as a restricted gateway for a narrowed CodeModeOnly agent', async () => {
      const core = codeModeCore(
        'restricted-code-mode',
        {
          tools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
          executionAllowedTools: [ToolNames.READ_FILE],
        },
        [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
      );

      const exec = await execDeclaration(core);

      expect(exec).toBeDefined();
      expect(executable(core, ToolNames.EXEC)).toBe(true);
      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.write_file');
      expect(codeModeAllowed(core)).toEqual([ToolNames.READ_FILE]);
    });

    it('narrows an inherited fork exec surface to its execution allowlist', async () => {
      const core = codeModeCore(
        'restricted-fork',
        {
          tools: [ToolNames.EXEC],
          executionAllowedTools: [ToolNames.READ_FILE],
        },
        [ToolNames.READ_FILE, ToolNames.SHELL],
      );

      const exec = await execDeclaration(core);

      expect(executable(core, ToolNames.EXEC)).toBe(true);
      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.run_shell_command');
    });

    it('inherits the parent exec bindings for an unrestricted fork', async () => {
      const core = codeModeCore(
        'unrestricted-fork',
        {
          tools: [ToolNames.EXEC],
          executionAllowedTools: [ToolNames.EXEC],
        },
        [ToolNames.READ_FILE, ToolNames.SHELL],
      );

      const exec = await execDeclaration(core);

      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).toContain('tools.run_shell_command');
    });

    // The shape a workflow agent({ tools }) dispatch produces: a declaration
    // allowlist without `exec` and without an execution allowlist. The agent
    // keeps exec, and exec can call only the listed tools.
    it('keeps exec and narrows its bindings for a tools-only CodeModeOnly agent', async () => {
      const core = codeModeCore(
        'workflow-narrowed-code-mode',
        { tools: [ToolNames.READ_FILE] },
        [ToolNames.READ_FILE, ToolNames.WRITE_FILE, ToolNames.SHELL],
      );

      const exec = await execDeclaration(core);

      expect(exec).toBeDefined();
      expect(executable(core, ToolNames.EXEC)).toBe(true);
      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.write_file');
      expect(exec?.description).not.toContain('tools.run_shell_command');
      expect(codeModeAllowed(core)).toEqual([ToolNames.READ_FILE]);
    });

    it('keeps disallowed tools out of a restricted CodeModeOnly gateway', async () => {
      const core = codeModeCore(
        'disallowed-code-mode',
        {
          tools: ['*'],
          disallowedTools: [ToolNames.WRITE_FILE],
          executionAllowedTools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
        },
        [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
      );

      const exec = await execDeclaration(core);

      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.write_file');
      expect(codeModeAllowed(core)).toEqual([ToolNames.READ_FILE]);
    });
  });
});
