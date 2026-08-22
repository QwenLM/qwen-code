/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { FunctionDeclaration } from '@google/genai';
import { AgentCore } from './agent-core.js';
import { ToolNames } from '../../tools/tool-names.js';

// The skill-announcement gate must answer from what the model was DECLARED.
// `willHaveSkillTool()` reads `toolConfig.tools`, which is a copy of only the
// first of `prepareTools`' filters — it cannot see the `disallowedTools`
// blocklist, an inline-only declaration set, or a tool the permission layer
// kept out of the registry. Each of those makes the copy say "yes" while the
// declaration says no, which is the same shape as the defect the gate exists
// for, one level in.
//
// So the gate reads the names `prepareTools` actually returned. These tests
// drive `prepareTools` through each filter and assert the recorded set
// matches the declarations it produced — the property the gate rests on.
describe('AgentCore records the declarations it sent', () => {
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

  /** The set the gate reads, reached the way the runtime reaches it. */
  function declaredAfterPrepare(core: AgentCore): ReadonlySet<string> {
    return (core as unknown as { declaredToolNames?: ReadonlySet<string> })
      .declaredToolNames!;
  }

  it('drops a tool the disallowedTools blocklist removed', async () => {
    // `tools: ['*']` says "everything", so `toolConfig` alone reports SKILL as
    // available — the blocklist is applied after, and only to the list.
    const core = makeCore({ tools: ['*'], disallowedTools: [ToolNames.SKILL] });
    const declarations = await core.prepareTools();

    const names = declarations.map((d) => d.name);
    expect(names).not.toContain(ToolNames.SKILL);
    expect(declaredAfterPrepare(core).has(ToolNames.SKILL)).toBe(false);
    // …and the set is the declarations, not a re-derivation of them.
    expect([...declaredAfterPrepare(core)].sort()).toEqual([...names].sort());
  });

  it('drops a tool absent from an inline-only declaration set', async () => {
    // No string entries at all: `prepareTools` declares exactly the inline
    // ones, while a `toolConfig.tools`-based read sees an empty string list
    // and concludes the agent inherits everything.
    const core = makeCore({ tools: [{ name: ToolNames.READ_FILE }] });
    const declarations = await core.prepareTools();

    expect(declarations.map((d) => d.name)).toEqual([ToolNames.READ_FILE]);
    expect(declaredAfterPrepare(core).has(ToolNames.SKILL)).toBe(false);
  });

  it('drops a tool the registry never held', async () => {
    // The permission layer keeps a tool out of the registry, so naming it in
    // an explicit list does not declare it.
    const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] }, [
      ToolNames.READ_FILE,
    ]);
    const declarations = await core.prepareTools();

    expect(declarations.map((d) => d.name)).toEqual([ToolNames.READ_FILE]);
    expect(declaredAfterPrepare(core).has(ToolNames.SKILL)).toBe(false);
  });

  it('answers the skill gate from the record, not from toolConfig', async () => {
    // The link the other tests do not cover: recording the declarations is
    // only useful if the gate READS them. Reverting the predicate to
    // `willHaveSkillTool()` — the defect's shape — leaves every assertion
    // above green, because they inspect the record rather than the answer.
    //
    // `tools: ['*']` with SKILL blocked is the discriminating input:
    // `toolConfig` says the agent inherits everything (true), the
    // declarations say SKILL was removed (false).
    const core = makeCore({ tools: ['*'], disallowedTools: [ToolNames.SKILL] });
    await core.prepareTools();

    const gate = (core as unknown as { hasSkillToolForGate?: () => boolean })
      .hasSkillToolForGate;
    expect(
      typeof gate,
      'AgentCore no longer exposes the gate predicate under test',
    ).toBe('function');
    expect(gate!.call(core)).toBe(false);
  });

  it('keeps a tool that survives every filter', async () => {
    // The other direction, so the record is not mistaken for "always empty".
    const core = makeCore({ tools: [ToolNames.READ_FILE, ToolNames.SKILL] });
    await core.prepareTools();

    expect(declaredAfterPrepare(core).has(ToolNames.SKILL)).toBe(true);
  });
});
