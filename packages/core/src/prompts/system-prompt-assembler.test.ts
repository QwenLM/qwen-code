/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SystemPromptAssembler,
  validatePromptSectionDescriptors,
} from './system-prompt-assembler.js';
import { buildSystemPromptResultForTurn } from './build-system-prompt.js';
import type {
  PromptAssemblyContext,
  PromptSectionDescriptor,
} from './types.js';

function createContext(
  bundle: 'full' | 'lean',
  options: {
    surface?: PromptAssemblyContext['surface'];
    capabilities?: PromptAssemblyContext['renderInputs']['hostCapabilities'];
    gates?: PromptAssemblyContext['enabledSectionGates'];
    memory?: PromptAssemblyContext['renderInputs']['memory'];
    sessionGuidance?: PromptAssemblyContext['renderInputs']['sessionGuidance'];
    language?: PromptAssemblyContext['renderInputs']['language'];
    outputStyle?: PromptAssemblyContext['renderInputs']['outputStyle'];
  } = {},
): PromptAssemblyContext {
  return Object.freeze({
    source: 'default',
    bundle,
    surface: options.surface ?? 'headless',
    enabledSectionGates: Object.freeze([...(options.gates ?? [])]),
    renderInputs: Object.freeze({
      usingTools: Object.freeze({
        cacheVariant: 'none',
        compute: () => null,
      }),
      hostCapabilities: Object.freeze([
        ...(options.capabilities ?? ['compression']),
      ]),
      sessionGuidance:
        options.sessionGuidance ??
        Object.freeze({
          cacheVariant: 'none',
          computeForBundle: () => null,
        }),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.outputStyle ? { outputStyle: options.outputStyle } : {}),
    }),
  });
}

describe('SystemPromptAssembler', () => {
  it('selects exactly one Full communication variant', async () => {
    const prompt = (
      await new SystemPromptAssembler({ sessionId: 'full' }).build(
        createContext('full'),
      )
    ).join('\n\n');
    expect(prompt).toContain('# Text output');
    expect(prompt).not.toContain('Write code that reads like');
  });

  it.each(['local_tui', 'sdk'] as const)(
    'allows explicitly enabled Lean autonomy on the %s surface',
    async (surface) => {
      const prompt = (
        await new SystemPromptAssembler({
          sessionId: `autonomy-${surface}`,
        }).build(
          createContext('lean', {
            surface,
            gates: ['behavior.autonomy'],
          }),
        )
      ).join('\n\n');
      expect(prompt).toContain('You are operating autonomously');
    },
  );

  it('allows explicitly enabled autonomy for Full', async () => {
    const prompt = (
      await new SystemPromptAssembler({ sessionId: 'autonomy-full' }).build(
        createContext('full', {
          surface: 'headless',
          gates: ['behavior.autonomy'],
        }),
      )
    ).join('\n\n');

    expect(prompt).toContain('You are operating autonomously');
  });

  it.each(['headless', 'remote_worker'] as const)(
    'renders autonomy for Lean on the %s surface',
    async (surface) => {
      const prompt = (
        await new SystemPromptAssembler({
          sessionId: `autonomy-${surface}`,
        }).build(
          createContext('lean', {
            surface,
            gates: ['behavior.autonomy'],
          }),
        )
      ).join('\n\n');
      expect(prompt).toContain('You are operating autonomously');
    },
  );

  it('keeps Lean autonomy disabled by default', async () => {
    const prompt = (
      await new SystemPromptAssembler({ sessionId: 'autonomy-disabled' }).build(
        createContext('lean', { surface: 'headless' }),
      )
    ).join('\n\n');

    expect(prompt).not.toContain('You are operating autonomously');
  });

  it('renders Lean without Full core sections', async () => {
    const prompt = (
      await new SystemPromptAssembler({ sessionId: 'lean' }).build(
        createContext('lean'),
      )
    ).join('\n\n');
    expect(prompt).toContain('# Harness');
    expect(prompt).not.toContain('# Communicating with the user');
    expect(prompt).not.toContain('Lead with the outcome.');
    expect(prompt).toContain('Write code that reads like');
    expect(prompt).not.toContain('# Doing tasks');
  });

  it('renders the mandatory default section exactly once for Full and Lean', async () => {
    for (const bundle of ['full', 'lean'] as const) {
      const prompt = (
        await new SystemPromptAssembler({
          sessionId: `mandatory-${bundle}`,
        }).build(createContext(bundle))
      ).join('\n\n');
      for (const marker of [
        'You are Qwen Code.',
        'IMPORTANT: Assist with authorized security testing',
      ]) {
        expect(prompt.split(marker)).toHaveLength(2);
      }
      expect(prompt).not.toContain('25 words');
      expect(prompt).not.toContain('100 words');
      expect(prompt).not.toContain('summarizeToolResults');
      expect(prompt).not.toContain('# Evidence and completion');
    }
  });

  it('gates verified-vs-assumed guidance for default Full', async () => {
    const assembler = new SystemPromptAssembler({
      sessionId: 'verified-vs-assumed',
    });
    const disabledPrompt = (await assembler.build(createContext('full'))).join(
      '\n\n',
    );
    const enabledPrompt = (
      await assembler.build(
        createContext('full', {
          gates: ['behavior.verified_vs_assumed'],
        }),
      )
    ).join('\n\n');
    const leanPrompt = (
      await new SystemPromptAssembler({ sessionId: 'verified-lean' }).build(
        createContext('lean', {
          gates: ['behavior.verified_vs_assumed'],
        }),
      )
    ).join('\n\n');

    const guidance =
      'When reporting results, be accurate about what you verified vs. what you assumed.';
    expect(disabledPrompt).not.toContain(guidance);
    expect(enabledPrompt).toContain(guidance);
    expect(leanPrompt).not.toContain(guidance);
    expect(leanPrompt).toContain('Report outcomes faithfully:');
  });

  it.each(['full', 'lean'] as const)(
    'renders act-dont-rederive for %s only when its resolved gate is enabled',
    async (bundle) => {
      const disabledPrompt = (
        await new SystemPromptAssembler({
          sessionId: `act-dont-rederive-disabled-${bundle}`,
        }).build(createContext(bundle))
      ).join('\n\n');
      const enabledPrompt = (
        await new SystemPromptAssembler({
          sessionId: `act-dont-rederive-enabled-${bundle}`,
        }).build(
          createContext(bundle, {
            gates: ['behavior.act_dont_rederive'],
          }),
        )
      ).join('\n\n');

      expect(disabledPrompt).not.toContain(
        'When you have enough information to act, act.',
      );
      expect(enabledPrompt).toContain(
        'When you have enough information to act, act.',
      );
    },
  );

  it('renders the same brand identity on every main surface', async () => {
    const build = async (surface: PromptAssemblyContext['surface']) => {
      const sections = await new SystemPromptAssembler({
        sessionId: `identity-${surface}`,
      }).build(createContext('full', { surface }));
      return sections.join('\n\n');
    };

    const cliPrompt = await build('headless');
    const sdkPrompt = await build('sdk');
    expect(cliPrompt).toContain('You are Qwen Code.');
    expect(sdkPrompt).toContain('You are Qwen Code.');
    expect(sdkPrompt).not.toContain('You are a Qoder agent.');
  });

  it.each(['full', 'lean'] as const)(
    'lets turn updates replace the %s communication variant',
    async (bundle) => {
      const prompt = (
        await new SystemPromptAssembler({
          sessionId: `turn-updates-${bundle}`,
        }).build(
          createContext(bundle, {
            gates: ['communication.turn_updates'],
          }),
        )
      ).join('\n\n');

      expect(prompt).toContain('Before you start, say in a line');
      expect(prompt).toContain(
        'Close with a short recap that stands on its own',
      );
      expect(prompt).not.toContain('# Text output');
      expect(prompt).not.toContain('# Communicating with the user');
    },
  );

  it('renders delivering work for either bundle when its feature gate is enabled', async () => {
    const disabledPrompt = (
      await new SystemPromptAssembler({
        sessionId: 'delivering-disabled',
      }).build(createContext('lean'))
    ).join('\n\n');
    const leanPrompt = (
      await new SystemPromptAssembler({
        sessionId: 'delivering-enabled',
      }).build(
        createContext('lean', {
          gates: ['behavior.delivering_work'],
        }),
      )
    ).join('\n\n');
    const fullPrompt = (
      await new SystemPromptAssembler({ sessionId: 'delivering-full' }).build(
        createContext('full', {
          gates: ['behavior.delivering_work'],
        }),
      )
    ).join('\n\n');

    expect(disabledPrompt).not.toContain('# Delivering work');
    expect(leanPrompt).toContain('# Delivering work');
    expect(fullPrompt).toContain('# Delivering work');
  });

  it('renders remote-controlled behavior sections only when their gates are enabled', async () => {
    const disabledPrompt = (
      await new SystemPromptAssembler({
        sessionId: 'model-behavior-disabled',
      }).build(createContext('lean'))
    ).join('\n\n');
    const enabledPrompt = (
      await new SystemPromptAssembler({
        sessionId: 'model-behavior-enabled',
      }).build(
        createContext('lean', {
          gates: ['behavior.overcorrection', 'behavior.tool_argument_json'],
        }),
      )
    ).join('\n\n');

    expect(disabledPrompt).not.toContain(
      'Avoid unnecessary or excessive self-correction.',
    );
    expect(disabledPrompt).not.toContain(
      'Object and array parameter values must be a single JSON value',
    );
    expect(enabledPrompt).toContain(
      'Avoid unnecessary or excessive self-correction.',
    );
    expect(enabledPrompt).toContain('# Corrections');
    expect(enabledPrompt).toContain(
      'Object and array parameter values must be a single JSON value',
    );
  });

  it('uses the compact native memory renderer only for Lean', async () => {
    const computeForBundle = vi.fn((bundle: 'full' | 'lean') =>
      bundle === 'lean'
        ? '# Memory\ncompact'
        : '# auto memory\n## Types of memory',
    );
    const memory = Object.freeze({
      owner: 'native' as const,
      cacheVariant: 'native',
      computeForBundle,
    });

    const fullPrompt = (
      await new SystemPromptAssembler({ sessionId: 'memory-full' }).build(
        createContext('full', {
          capabilities: ['compression', 'memory'],
          memory,
        }),
      )
    ).join('\n\n');
    const leanPrompt = (
      await new SystemPromptAssembler({ sessionId: 'memory-lean' }).build(
        createContext('lean', {
          capabilities: ['compression', 'memory'],
          memory,
        }),
      )
    ).join('\n\n');

    expect(fullPrompt).toContain('# auto memory');
    expect(fullPrompt).toContain('## Types of memory');
    expect(leanPrompt).toContain('# Memory\ncompact');
    expect(leanPrompt).not.toContain('## Types of memory');
    expect(computeForBundle.mock.calls.map(([bundle]) => bundle)).toEqual([
      'full',
      'lean',
    ]);
  });

  it('keeps SDK-owned memory verbatim in Lean', async () => {
    const sdkMemory = vi.fn(() => '# SDK Memory');
    const prompt = (
      await new SystemPromptAssembler({ sessionId: 'memory-sdk-lean' }).build(
        createContext('lean', {
          surface: 'sdk',
          capabilities: ['compression', 'memory'],
          memory: Object.freeze({
            owner: 'sdk',
            cacheVariant: 'sdk:1',
            computeForBundle: sdkMemory,
          }),
        }),
      )
    ).join('\n\n');

    expect(prompt).toContain('# SDK Memory');
    expect(sdkMemory).toHaveBeenCalledOnce();
  });

  it('renders and caches session guidance separately for Full and Lean', async () => {
    const computeForBundle = vi.fn((bundle: 'full' | 'lean') =>
      bundle === 'full'
        ? '# Session-specific guidance\n- full-only Agent guidance'
        : '# Session-specific guidance\n- lean guidance',
    );
    const sessionGuidance = Object.freeze({
      cacheVariant: 'agent=1;fork_subagent=0',
      computeForBundle,
    });
    const assembler = new SystemPromptAssembler({
      sessionId: 'bundle-session-guidance',
    });

    const fullPrompt = (
      await assembler.build(createContext('full', { sessionGuidance }))
    ).join('\n\n');
    const leanPrompt = (
      await assembler.build(createContext('lean', { sessionGuidance }))
    ).join('\n\n');

    expect(fullPrompt).toContain('full-only Agent guidance');
    expect(leanPrompt).toContain('lean guidance');
    expect(leanPrompt).not.toContain('full-only Agent guidance');
    expect(computeForBundle.mock.calls.map(([bundle]) => bundle)).toEqual([
      'full',
      'lean',
    ]);
  });

  it('orders operational sections consistently', async () => {
    const section = (text: string) =>
      Object.freeze({ cacheVariant: text, compute: () => text });
    const sections = await new SystemPromptAssembler({
      sessionId: 'native-operational-order',
    }).build(
      createContext('lean', {
        surface: 'headless',
        capabilities: ['compression', 'memory', 'workflows'],
        gates: [
          'behavior.tool_argument_json',
          'behavior.act_dont_rederive',
          'behavior.delivering_work',
          'behavior.overcorrection',
          'behavior.autonomy',
        ],
        sessionGuidance: Object.freeze({
          cacheVariant: 'session',
          computeForBundle: () => '# Session-specific guidance',
        }),
        memory: Object.freeze({
          owner: 'native',
          cacheVariant: 'memory',
          computeForBundle: () => '# Memory',
        }),
        language: section('# Language'),
        outputStyle: Object.freeze({
          ...section('# Output style'),
          keepCodingInstructions: true,
        }),
      }),
    );
    const prompt = sections.filter(Boolean).join('\n\n');

    const expectedOrder = [
      'Object and array parameter values must be a single JSON value',
      '# Session-specific guidance',
      '# Memory',
      '# Language',
      '# Output style',
      '# Context management',
      'When you have enough information to act, act.',
      '# Delivering work',
      '# Corrections',
      'You are operating autonomously',
    ];
    const indexes = expectedOrder.map((marker) => prompt.indexOf(marker));

    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(sections[0]).toContain(
      'Object and array parameter values must be a single JSON value',
    );
    expect(sections[0]).not.toContain('# Session-specific guidance');
    expect(sections[1]).toContain('# Session-specific guidance');
    expect(prompt).not.toContain('# Available saved workflows');
  });

  it('is byte deterministic across 100 builds with stable inputs', async () => {
    const assembler = new SystemPromptAssembler({ sessionId: 'deterministic' });
    const context = createContext('full');
    const prompts = await Promise.all(
      Array.from({ length: 100 }, async () =>
        (await assembler.build(context)).join('\n\n'),
      ),
    );
    expect(new Set(prompts).size).toBe(1);
  });

  it('rejects invalid descriptors before rendering', () => {
    const render = vi.fn(() => 'invalid');
    const invalid = {
      id: 'bad@section',
      version: 1,
      systemBlock: 'stable',
      order: 1,
      eligibleBundles: ['full'],
      eligibleSurfaces: ['headless'],
      render,
    } satisfies PromptSectionDescriptor;
    expect(() => validatePromptSectionDescriptors([invalid])).toThrow(
      'Invalid prompt section id',
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects an empty eligibility restriction', () => {
    expect(() =>
      validatePromptSectionDescriptors([
        {
          id: 'empty.bundles',
          version: 1,
          systemBlock: 'stable',
          order: 1,
          eligibleBundles: [],
          render: () => 'x',
        } satisfies PromptSectionDescriptor,
      ]),
    ).toThrow('invalid bundles');
  });

  it('does not execute cached section inputs twice', async () => {
    const language = vi.fn(() => '# Language\nRespond in Chinese.');
    const context = createContext('full');
    const withSpy = {
      ...context,
      renderInputs: {
        ...context.renderInputs,
        language: { cacheVariant: 'stable', compute: language },
      },
    } satisfies PromptAssemblyContext;
    const assembler = new SystemPromptAssembler({ sessionId: 'cache' });
    await assembler.build(withSpy);
    await assembler.build(withSpy);
    expect(language).toHaveBeenCalledTimes(1);
  });
});

describe('effective memory prompt metadata', () => {
  it.each(['full', 'lean', 'skill', 'custom'] as const)(
    'preserves %s metadata on initial render and cache hits',
    async (version) => {
      const computeForBundle = vi.fn(() => 'MEMORY');
      const context = createContext(version === 'lean' ? 'lean' : 'full', {
        capabilities: ['memory'],
        memory: {
          owner: version === 'custom' ? 'sdk' : 'native',
          cacheVariant: version,
          versionForBundle: () => version,
          computeForBundle,
        },
      });
      const assembler = new SystemPromptAssembler({
        sessionId: `memory-version-${version}`,
      });
      for (let i = 0; i < 2; i++) {
        const result = await buildSystemPromptResultForTurn(assembler, {
          resolvedSource: { source: 'default' },
          assemblyContext: context,
        });
        expect(result.memoryPromptVersion).toBe(version);
      }
      expect(computeForBundle).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, '', '   '])(
    'reports none for an empty memory section: %j',
    async (body) => {
      const context = createContext('full', {
        capabilities: ['memory'],
        memory: {
          owner: 'native',
          cacheVariant: String(body),
          versionForBundle: () => 'skill',
          computeForBundle: () => body,
        },
      });
      const result = await buildSystemPromptResultForTurn(
        new SystemPromptAssembler({ sessionId: `empty-memory-${body}` }),
        { resolvedSource: { source: 'default' }, assemblyContext: context },
      );
      expect(result.memoryPromptVersion).toBe('none');
    },
  );
  it('does not report a version when the memory section is ineligible', async () => {
    const result = await buildSystemPromptResultForTurn(
      new SystemPromptAssembler({ sessionId: 'ineligible-memory' }),
      {
        resolvedSource: { source: 'default' },
        assemblyContext: createContext('full', {
          capabilities: [],
          memory: {
            owner: 'native',
            cacheVariant: 'skill',
            versionForBundle: () => 'skill',
            computeForBundle: () => 'MEMORY',
          },
        }),
      },
    );
    expect(result.memoryPromptVersion).toBe('none');
  });
});
