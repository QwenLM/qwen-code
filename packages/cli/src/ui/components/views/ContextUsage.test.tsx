/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ContextUsage } from './ContextUsage.js';
import type {
  ContextCategoryBreakdown,
  ContextThresholds,
  ContextTier,
} from '../../types.js';

afterEach(() => {
  cleanup();
});

const thresholds: ContextThresholds = {
  effectiveWindow: 108_000,
  warn: 76_800,
  auto: 95_000,
  hard: 105_000,
};

function makeBreakdown(
  currentTier: ContextTier,
  overrides: Partial<ContextCategoryBreakdown> = {},
): ContextCategoryBreakdown {
  return {
    systemPrompt: 5000,
    builtinTools: 8000,
    mcpTools: 0,
    memoryFiles: 200,
    skills: 1000,
    messages: 0,
    freeSpace: 80_000,
    autocompactBuffer: 33_000,
    thresholds,
    currentTier,
    ...overrides,
  };
}

describe('ContextUsage — CompactionThresholds section (review #4168 R1.6)', () => {
  it('keeps a loaded skill name and listing cost on one line with one body-cost label', () => {
    const name = 'agent-reproduce-feature';
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={50_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe', { skills: 10_000 })}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[{ name, tokens: 5000, loaded: true, bodyTokens: 5000 }]}
        showDetails={true}
      />,
    );
    const frame = lastFrame() ?? '';
    const skills = frame.slice(frame.lastIndexOf('Skills'));
    const nameLine = skills.split('\n').find((line) => line.includes(name));
    expect(nameLine).toBeDefined();
    expect(nameLine).toContain('5.0k tokens');
    expect(nameLine).not.toContain('body loaded');
    expect(nameLine).not.toContain('active');
    expect(skills.match(/body loaded/g)).toHaveLength(1);
    expect(skills).toContain('+5.0k tokens');
  });

  it('keeps a positive estimated count in the numeric usage view', () => {
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={50_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
        isEstimated={true}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Token usage is estimated');
    expect(frame).toContain('Used');
    expect(frame).toContain('Messages');
    expect(frame).not.toContain('No API response yet');
  });

  it('renders the startup context, unattributed and cached prefix rows only when nonzero (#12033)', () => {
    const present = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={50_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe', {
          startupContext: 1_200,
          unattributed: 900,
          cachedTokens: 30_000,
        })}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
      />,
    );
    const frame = present.lastFrame() ?? '';
    expect(frame).toContain('Startup context');
    expect(frame).toContain('Unattributed');
    expect(frame).toContain('Cached prefix');
    present.unmount();

    // Zero-suppression half. `makeBreakdown`'s defaults omit all three fields,
    // which is the shape of a `context_usage` item persisted by an older build
    // and replayed after `/restore`; `startupContext` is also 0 by
    // construction on a pre-first-send `/context`. Without the `> 0` guards
    // these rows render as `undefined tokens (NaN%)`.
    // `totalTokens` must stay > 0: `Cached prefix` and `Unattributed` are
    // `hasTokenCount`-gated, so at 0 neither can render with or without its
    // guard, and only the `Startup context` row would be witnessed.
    const absent = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={50_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
      />,
    );
    const zeroFrame = absent.lastFrame() ?? '';
    // The legend still renders, so the absences below are the guards and not
    // an empty frame.
    expect(zeroFrame).toContain('Usage by category');
    expect(zeroFrame).not.toContain('Startup context');
    expect(zeroFrame).not.toContain('Unattributed');
    expect(zeroFrame).not.toContain('Cached prefix');
  });

  it('renders the new three-tier section with all four threshold rows', () => {
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={0}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
        isEstimated={true}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Compaction thresholds');
    expect(frame).toContain('Effective window');
    expect(frame).toContain('Warn threshold');
    expect(frame).toContain('Auto threshold');
    expect(frame).toContain('Hard threshold');
    expect(frame).toContain('Current tier');
  });

  it('shows safe tier without any ▶ marker', () => {
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={50_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('safe')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
      />,
    );
    const frame = lastFrame() ?? '';
    // safe tier → no ▶ marker on any threshold row
    expect(frame).not.toContain('▶');
    // The literal word "safe" appears as the Current tier value
    expect(frame).toMatch(/Current tier[\s\S]*safe/);
  });

  it('places ▶ on the warn row when currentTier === warn', () => {
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={80_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('warn')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▶');
    // The ▶ should appear on the Warn-threshold line and nowhere else.
    const lines = frame.split('\n');
    const warnLine = lines.find((l) => l.includes('Warn threshold')) ?? '';
    expect(warnLine).toContain('▶');
    const autoLine = lines.find((l) => l.includes('Auto threshold')) ?? '';
    expect(autoLine).not.toContain('▶');
    const hardLine = lines.find((l) => l.includes('Hard threshold')) ?? '';
    expect(hardLine).not.toContain('▶');
  });

  it('places ▶ on the hard row when currentTier === hard', () => {
    const { lastFrame } = render(
      <ContextUsage
        modelName="qwen3-coder"
        totalTokens={106_000}
        contextWindowSize={128_000}
        breakdown={makeBreakdown('hard')}
        builtinTools={[]}
        mcpTools={[]}
        memoryFiles={[]}
        skills={[]}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const hardLine = lines.find((l) => l.includes('Hard threshold')) ?? '';
    expect(hardLine).toContain('▶');
    // Current tier reads `hard`
    expect(frame).toMatch(/Current tier[\s\S]*hard/);
  });
});
