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

  it('escapes U+2028/U+2029 so pre-ES2019 engines can still parse the script', async () => {
    const renderer = new TemplateRenderer();
    // U+2028 (line separator) and U+2029 (paragraph separator) are passed
    // through raw by JSON.stringify but are line terminators to older engines.
    const payload = 'line1\u2028line2\u2029line3';
    const html = await renderer.renderInsightHTML(
      makeInsights({ latestActiveTime: payload }),
    );

    // The raw separators must not survive into the inline script; the escaped
    // forms must appear instead.
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');

    // And the escape must round-trip back to the original characters.
    const match = html.match(/window\.INSIGHT_DATA = (.*);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]) as InsightData;
    expect(parsed.latestActiveTime).toBe(payload);
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
