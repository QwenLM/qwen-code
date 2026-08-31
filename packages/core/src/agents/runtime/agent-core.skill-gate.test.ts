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

// The skill-announcement gate asks whether the model can INVOKE a skill, and
// that is two conditions, not one.
//
// Declared: `willHaveSkillTool()` reads `toolConfig.tools`, a copy of only the
// first of `prepareTools`' filters — blind to the `disallowedTools` blocklist,
// an inline-only declaration set, and a tool the permission layer kept out of
// the registry. So the gate reads the declarations `prepareTools` produced.
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
      const internals = core as unknown as {
        executionAllowedTools?: string[];
        executionAllowedExactTools?: Set<string>;
      };
      internals.executionAllowedTools = [ToolNames.READ_FILE];
      internals.executionAllowedExactTools = new Set([ToolNames.READ_FILE]);

      expect(gate(core, await declaredNames(core))).toBe(false);
    });

    it('refuses when executable but not declared', async () => {
      // The other term. Reverting the gate to `willHaveSkillTool()` — which
      // reads `toolConfig` and says true here — is caught by this.
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
      // `toolConfig` says the agent inherits everything; the blocklist removes
      // SKILL from the declarations afterwards.
      const core = makeCore({
        tools: ['*'],
        disallowedTools: [ToolNames.SKILL],
      });
      expect(snapshot(core)).toBe(true);
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

  describe('executable', () => {
    it('allows everything when no execution allowlist is set', () => {
      const core = makeCore({ tools: ['*'] });
      expect(executable(core, ToolNames.SKILL)).toBe(true);
    });

    it('refuses a declared tool the fork allowlist withholds', async () => {
      // The fork shape: declarations keep the parent's names for prompt-cache
      // parity while `fork_tools` narrows execution. SKILL is declared AND
      // unusable, so a gate reading declarations alone opens on it.
      const core = makeCore({ tools: ['*'] });
      const internals = core as unknown as {
        executionAllowedTools?: string[];
        executionAllowedExactTools?: Set<string>;
      };
      internals.executionAllowedTools = [ToolNames.READ_FILE];
      internals.executionAllowedExactTools = new Set([ToolNames.READ_FILE]);

      expect((await declaredNames(core)).has(ToolNames.SKILL)).toBe(true);
      expect(executable(core, ToolNames.SKILL)).toBe(false);
    });

    it('uses exec as a restricted gateway for a narrowed CodeModeOnly agent', async () => {
      const config = makeFakeConfig({ codeModeOnly: true });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      registry.registerTool(new MockTool({ name: ToolNames.WRITE_FILE }));
      const core = new AgentCore(
        'restricted-code-mode',
        config,
        { systemPrompt: '' } as never,
        { model: 'test-model' } as never,
        { max_turns: 1 } as never,
        {
          tools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
          executionAllowedTools: [ToolNames.READ_FILE],
        },
      );

      const declarations = await core.prepareTools();
      const exec = declarations.find(
        (declaration) => declaration.name === ToolNames.EXEC,
      );

      expect(exec).toBeDefined();
      expect(executable(core, ToolNames.EXEC)).toBe(true);
      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.write_file');
      expect(
        (
          core as unknown as {
            codeModeAllowedToolNames?: readonly string[];
          }
        ).codeModeAllowedToolNames,
      ).toEqual([ToolNames.READ_FILE]);
    });

    it('narrows an inherited fork exec surface to its execution allowlist', async () => {
      const config = makeFakeConfig({ codeModeOnly: true });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      registry.registerTool(new MockTool({ name: ToolNames.SHELL }));
      const core = new AgentCore(
        'restricted-fork',
        config,
        { systemPrompt: '' } as never,
        { model: 'test-model' } as never,
        { max_turns: 1 } as never,
        {
          tools: [ToolNames.EXEC],
          executionAllowedTools: [ToolNames.READ_FILE],
        },
      );

      const declarations = await core.prepareTools();
      const exec = declarations.find(
        (declaration) => declaration.name === ToolNames.EXEC,
      );

      expect(executable(core, ToolNames.EXEC)).toBe(true);
      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.run_shell_command');
    });

    it('inherits the parent exec bindings for an unrestricted fork', async () => {
      const config = makeFakeConfig({ codeModeOnly: true });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      registry.registerTool(new MockTool({ name: ToolNames.SHELL }));
      const core = new AgentCore(
        'unrestricted-fork',
        config,
        { systemPrompt: '' } as never,
        { model: 'test-model' } as never,
        { max_turns: 1 } as never,
        {
          tools: [ToolNames.EXEC],
          executionAllowedTools: [ToolNames.EXEC],
        },
      );

      const declarations = await core.prepareTools();
      const exec = declarations.find(
        (declaration) => declaration.name === ToolNames.EXEC,
      );

      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).toContain('tools.run_shell_command');
    });

    it('keeps disallowed tools out of a restricted CodeModeOnly gateway', async () => {
      const config = makeFakeConfig({ codeModeOnly: true });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      registry.registerTool(new MockTool({ name: ToolNames.WRITE_FILE }));
      const core = new AgentCore(
        'disallowed-code-mode',
        config,
        { systemPrompt: '' } as never,
        { model: 'test-model' } as never,
        { max_turns: 1 } as never,
        {
          tools: ['*'],
          disallowedTools: [ToolNames.WRITE_FILE],
          executionAllowedTools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE],
        },
      );

      const declarations = await core.prepareTools();
      const exec = declarations.find(
        (declaration) => declaration.name === ToolNames.EXEC,
      );

      expect(exec?.description).toContain('tools.read_file');
      expect(exec?.description).not.toContain('tools.write_file');
      expect(
        (
          core as unknown as {
            codeModeAllowedToolNames?: readonly string[];
          }
        ).codeModeAllowedToolNames,
      ).toEqual([ToolNames.READ_FILE]);
    });
  });
});
