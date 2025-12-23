/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ContextDisplay } from './ContextDisplay.js';
import type { ContextBreakdown } from '../types.js';

describe('ContextDisplay', () => {
  const createMockBreakdown = (
    overrides?: Partial<ContextBreakdown>,
  ): ContextBreakdown => ({
    userMessages: 1000,
    assistantResponses: 2000,
    toolCalls: 500,
    toolResponses: 300,
    systemInstructions: 200,
    cached: 100,
    thoughts: 50,
    total: 4150,
    ...overrides,
  });

  it('should render basic context information', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Context Usage');
    expect(output).toContain('4,150');
    expect(output).toContain('10,000');
    expect(output).toContain('41.5%');
    expect(output).toContain('5,850');
  });

  it('should display breakdown table', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('User Messages');
    expect(output).toContain('Assistant Responses');
    expect(output).toContain('Tool Calls');
    expect(output).toContain('Tool Responses');
    expect(output).toContain('System Instructions');
  });

  it('should show estimated exchanges when available', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('11');
    expect(output).toContain('more exchanges');
  });

  it('should not show estimated exchanges when zero', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={10000}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={100}
        remainingTokens={0}
        estimatedExchanges={0}
      />,
    );

    const output = lastFrame();
    expect(output).not.toContain('Est. Exchanges');
  });

  it('should show warning when usage is above 80%', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={8500}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={85}
        remainingTokens={1500}
        estimatedExchanges={3}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('approaching the limit');
  });

  it('should show critical warning when usage is above 90%', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={9500}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={95}
        remainingTokens={500}
        estimatedExchanges={1}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('critically high');
  });

  it('should not show warning when usage is below 80%', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={5000}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={50}
        remainingTokens={5000}
        estimatedExchanges={10}
      />,
    );

    const output = lastFrame();
    expect(output).not.toContain('approaching the limit');
    expect(output).not.toContain('critically high');
  });

  it('should display thoughts tokens when present', () => {
    const breakdown = createMockBreakdown({ thoughts: 150 });
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Thoughts');
    expect(output).toContain('150');
  });

  it('should display cached tokens when present', () => {
    const breakdown = createMockBreakdown({ cached: 200 });
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Cached');
    expect(output).toContain('200');
  });

  it('should not display thoughts when zero', () => {
    const breakdown = createMockBreakdown({ thoughts: 0 });
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).not.toContain('Thoughts');
  });

  it('should format large numbers with commas', () => {
    const breakdown = createMockBreakdown({
      userMessages: 15432,
      assistantResponses: 28765,
    });
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={50000}
        breakdown={breakdown}
        sessionLimit={100000}
        usagePercentage={50}
        remainingTokens={50000}
        estimatedExchanges={100}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('15,432');
    expect(output).toContain('28,765');
    expect(output).toContain('50,000');
    expect(output).toContain('100,000');
  });

  it('should show helpful tip at the bottom', () => {
    const breakdown = createMockBreakdown();
    const { lastFrame } = render(
      <ContextDisplay
        totalTokens={4150}
        breakdown={breakdown}
        sessionLimit={10000}
        usagePercentage={41.5}
        remainingTokens={5850}
        estimatedExchanges={11}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('/stats');
  });
});
