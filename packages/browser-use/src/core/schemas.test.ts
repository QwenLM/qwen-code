/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { commandSchemas } from './schemas.js';

describe('browser command schemas', () => {
  it('accepts the five coordinate CUA mouse buttons from Codex', () => {
    const base = { tabId: 'tab-1', x: 1, y: 1 };

    for (const button of [1, 2, 3, 4, 5]) {
      expect(
        commandSchemas['cua.click'].safeParse({ ...base, button }).success,
      ).toBe(true);
    }
    expect(
      commandSchemas['cua.click'].safeParse({ ...base, button: 6 }).success,
    ).toBe(false);
    expect(
      commandSchemas['locator.click'].safeParse({
        tabId: 'tab-1',
        steps: [{ kind: 'locator', selector: 'button' }],
        button: 'back',
      }).success,
    ).toBe(false);
  });

  it('accepts Playwright AI snapshot refs only', () => {
    for (const nodeId of ['e12', 'f1e3']) {
      expect(
        commandSchemas['dom_cua.click'].safeParse({
          tabId: 'tab-1',
          node_id: nodeId,
        }).success,
      ).toBe(true);
    }
    for (const nodeId of ['n12', 'n7/n3', 'e1/e2']) {
      expect(
        commandSchemas['dom_cua.click'].safeParse({
          tabId: 'tab-1',
          node_id: nodeId,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps DOM CUA typing focus-based and scrolling optionally targeted', () => {
    expect(
      commandSchemas['dom_cua.type'].safeParse({
        tabId: 'tab-1',
        text: 'hello',
      }).success,
    ).toBe(true);
    expect(
      commandSchemas['dom_cua.type'].safeParse({
        tabId: 'tab-1',
        node_id: 'e1',
        text: 'hello',
      }).success,
    ).toBe(false);
    for (const node_id of [undefined, 'e1']) {
      expect(
        commandSchemas['dom_cua.scroll'].safeParse({
          tabId: 'tab-1',
          ...(node_id === undefined ? {} : { node_id }),
          x: 0,
          y: 100,
        }).success,
      ).toBe(true);
    }
  });

  it('keeps runtime-only controls out of the model command contract', () => {
    expect(
      commandSchemas['playwright.domSnapshot'].safeParse({
        tabId: 'tab-1',
        maxChars: 1_000,
      }).success,
    ).toBe(false);
    expect(
      commandSchemas['dom_cua.click'].safeParse({
        tabId: 'tab-1',
        node_id: 'e1',
        force: true,
      }).success,
    ).toBe(false);
    expect(
      commandSchemas['tab.screenshot'].safeParse({
        tabId: 'tab-1',
        scale: 2,
      }).success,
    ).toBe(false);
    expect(
      commandSchemas['dev.logs'].safeParse({
        tabId: 'tab-1',
        clear: true,
      }).success,
    ).toBe(false);
    expect('dom_cua.screenshot' in commandSchemas).toBe(false);
    expect('locator.setInputFiles' in commandSchemas).toBe(false);
    expect('dev.network' in commandSchemas).toBe(false);
    expect('download.path' in commandSchemas).toBe(false);
    expect(
      commandSchemas['locator.downloadMedia'].safeParse({
        tabId: 'tab-1',
        steps: [{ kind: 'locator', selector: 'img' }],
        timeoutMs: 1_000,
      }).success,
    ).toBe(true);
  });
});
