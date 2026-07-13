/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { InsightData } from '../types/StaticInsightTypes.js';

// Stub the web-templates bundle so the renderer can be imported in isolation.
vi.mock('@qwen-code/web-templates', () => ({
  INSIGHT_JS: '',
  INSIGHT_CSS: '',
}));

const { TemplateRenderer } = await import('./TemplateRenderer.js');

function makeInsights(overrides: Partial<InsightData> = {}): InsightData {
  return {
    heatmap: {},
    currentStreak: 0,
    longestStreak: 0,
    longestWorkDate: null,
    longestWorkDuration: 0,
    activeHours: {},
    latestActiveTime: null,
    ...overrides,
  } as InsightData;
}

describe('TemplateRenderer', () => {
  it('escapes `<` in report data so it cannot break out of the inline script', async () => {
    const renderer = new TemplateRenderer();
    const payload = '</script><img src=x onerror=alert(1)>';
    const html = await renderer.renderInsightHTML(
      makeInsights({ latestActiveTime: payload }),
    );

    // The raw closing tag / injected element must not appear verbatim.
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
  });

  it('preserves the original data after JSON.parse (escape round-trips)', async () => {
    const renderer = new TemplateRenderer();
    const payload = '</script><b>hi</b>';
    const html = await renderer.renderInsightHTML(
      makeInsights({ latestActiveTime: payload }),
    );

    const match = html.match(/window\.INSIGHT_DATA = (.*);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as InsightData;
    expect(parsed.latestActiveTime).toBe(payload);
  });
});
