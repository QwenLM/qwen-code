/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Locator, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type { TabState } from './runtime-state.js';
import { snapshotRefLocator, snapshotTab } from './snapshot.js';

describe('Playwright AI snapshots', () => {
  it('returns Playwright refs and preserves iframe refs', async () => {
    const raw = [
      '- generic [ref=e1]:',
      '  - button "Save" [ref=e2]',
      '  - iframe [ref=e3]:',
      '    - button "Inside" [ref=f1e2]',
    ].join('\n');
    const fixture = fakePage(raw);

    await expect(snapshotTab(tab(fixture.page))).resolves.toBe(raw);
    expect(fixture.ariaSnapshot).toHaveBeenCalledWith({ mode: 'ai' });
  });

  it.each([
    {
      name: 'roles and static content without cursor markers',
      lines: [
        '- generic [ref=e1]:',
        '  - gridcell "Acme Corp" [ref=e2]',
        '  - cell "Native Cell" [ref=e3]',
        '  - heading "Title" [level=1] [ref=e4]',
        '  - paragraph [ref=e5]: Static paragraph',
      ],
    },
    {
      name: 'quoted keys, link properties, and child containers',
      lines: [
        '- generic [ref=e1]:',
        `  - 'button "Cart: 3 items" [ref=e2]'`,
        '  - link "Docs" [ref=e3]:',
        '    - /url: /docs/intro',
        '  - link "Plain" [ref=e4]:',
        '    - generic [ref=e5]',
      ],
    },
    {
      name: 'nested nodes with and without pointer cursor markers',
      lines: [
        '- generic "pointer container" [ref=e1] [cursor=pointer]:',
        '  - img "Nested Image" [ref=e2]',
        `- 'generic "Total: 3 items" [ref=e3] [cursor=pointer]'`,
        `- 'generic "Total: 4 items" [ref=e4] [cursor=pointer]':`,
        '  - text: Details',
      ],
    },
    {
      name: 'page text containing node-like syntax',
      lines: [
        '- generic [ref=e1]:',
        '  - text: "[cursor=pointer] Click here to continue [ref=e7]"',
        `  - 'paragraph "Sponsored: [cursor=pointer]" [ref=e3]'`,
        '  - paragraph "Sponsored [cursor=pointer]" [ref=e4]',
        '  - text: |-',
        '      - button "This is page text, not a node"',
        '  - button "Real save" [ref=e2]',
      ],
    },
  ])('preserves $name verbatim', async ({ lines }) => {
    const raw = lines.join('\n');
    const fixture = fakePage(raw);

    await expect(snapshotTab(tab(fixture.page))).resolves.toBe(raw);
  });

  it('keeps later refs when one snapshot line exceeds the budget', async () => {
    const fixture = fakePage(
      [`- text: ${'x'.repeat(25_000)}`, '- button "Save" [ref=e2]'].join('\n'),
    );

    const result = await snapshotTab(tab(fixture.page));

    expect(result).toContain('- button "Save" [ref=e2]');
    expect(result).toContain('[truncated: snapshot exceeded 20000 characters]');
    expect(result.length).toBeLessThanOrEqual(20_000);
  });

  it('applies the fixed internal snapshot budget', async () => {
    const fixture = fakePage(`${'- button [ref=e1]\n'.repeat(2_000)}tail`);

    const result = await snapshotTab(tab(fixture.page));

    expect(result.length).toBeLessThanOrEqual(20_000);
    expect(result).toContain('[truncated: snapshot exceeded 20000 characters]');
  });

  it('uses only current Playwright aria refs', async () => {
    const fixture = fakePage('- button "Save" [ref=e1]', {
      missing: new Set(['e9']),
    });

    await expect(snapshotRefLocator(fixture.page, 'f1e2')).resolves.toBe(
      fixture.locators.get('f1e2')?.value,
    );
    await expect(snapshotRefLocator(fixture.page, 'e9')).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
    });
    await expect(snapshotRefLocator(fixture.page, 'n1')).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
    });
  });
});

function tab(page: Page): TabState {
  return { page } as unknown as TabState;
}

function fakePage(
  snapshot: string,
  options: {
    missing?: ReadonlySet<string>;
  } = {},
): {
  page: Page;
  ariaSnapshot: ReturnType<typeof vi.fn>;
  locators: Map<string, ReturnType<typeof fakeLocator>>;
} {
  const ariaSnapshot = vi.fn(async () => snapshot);
  const locators = new Map<string, ReturnType<typeof fakeLocator>>();
  const methods = {
    ariaSnapshot,
    locator: vi.fn((selector: string) => {
      const ref = selector.replace('aria-ref=', '');
      let locator = locators.get(ref);
      if (locator === undefined) {
        locator = fakeLocator(ref, options);
        locators.set(ref, locator);
      }
      return locator.value;
    }),
  };
  return {
    page: methods as unknown as Page,
    ariaSnapshot,
    locators,
  };
}

function fakeLocator(
  ref: string,
  options: {
    boxes?: ReadonlyMap<
      string,
      { x: number; y: number; width: number; height: number }
    >;
    missing?: ReadonlySet<string>;
    rootSnapshot?: string;
  },
): {
  value: Locator;
  ariaSnapshot: ReturnType<typeof vi.fn>;
} {
  const ariaSnapshot = vi.fn(async () => '');
  const methods = {
    ariaSnapshot,
    count: vi.fn(async () => (options.missing?.has(ref) ? 0 : 1)),
  };
  return { value: methods as unknown as Locator, ariaSnapshot };
}
