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
