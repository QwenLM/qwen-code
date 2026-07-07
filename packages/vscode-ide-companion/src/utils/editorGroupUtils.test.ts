/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatViewType = 'mainThreadWebview-qwenCode.chat';

const vscodeMock = vi.hoisted(() => ({
  ViewColumn: { One: 1, Two: 2, Three: 3, Four: 4 },
  window: {
    tabGroups: {
      all: [] as Array<{ tabs: Array<{ input: unknown }>; viewColumn: number }>,
    },
  },
}));

vi.mock('vscode', () => vscodeMock);

import {
  findLeftGroupOfChatWebview,
  findRightGroupOfChatWebview,
} from './editorGroupUtils.js';

function chatTab() {
  return { input: { viewType: chatViewType } };
}

function regularTab() {
  return { input: { viewType: 'default' } };
}

describe('findLeftGroupOfChatWebview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.tabGroups.all = [];
  });

  it('returns the nearest left neighbor when chat webview has a group to its left', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [chatTab()], viewColumn: 2 },
      { tabs: [regularTab()], viewColumn: 3 },
    ];

    expect(findLeftGroupOfChatWebview()).toBe(1);
  });

  it('returns the closest left neighbor when multiple left groups exist', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [regularTab()], viewColumn: 2 },
      { tabs: [chatTab()], viewColumn: 4 },
      { tabs: [regularTab()], viewColumn: 5 },
    ];

    // closest left is group 2, not group 1
    expect(findLeftGroupOfChatWebview()).toBe(2);
  });

  it('returns undefined when chat webview is in the leftmost group', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [chatTab()], viewColumn: 1 },
      { tabs: [regularTab()], viewColumn: 2 },
    ];

    expect(findLeftGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when no chat webview is found', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [regularTab()], viewColumn: 2 },
    ];

    expect(findLeftGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when there are no tab groups', () => {
    vscodeMock.window.tabGroups.all = [];

    expect(findLeftGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when tabGroups access throws', () => {
    // make .all throw on access
    Object.defineProperty(vscodeMock.window.tabGroups, 'all', {
      get: () => {
        throw new Error('unexpected error');
      },
      configurable: true,
    });

    expect(findLeftGroupOfChatWebview()).toBeUndefined();

    // restore
    Object.defineProperty(vscodeMock.window.tabGroups, 'all', {
      value: [],
      configurable: true,
      writable: true,
    });
  });
});

describe('findRightGroupOfChatWebview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.window.tabGroups.all = [];
  });

  it('returns the nearest right neighbor when chat webview has a group to its right', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [chatTab()], viewColumn: 2 },
      { tabs: [regularTab()], viewColumn: 3 },
    ];

    expect(findRightGroupOfChatWebview()).toBe(3);
  });

  it('returns the closest right neighbor when multiple right groups exist', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [chatTab()], viewColumn: 2 },
      { tabs: [regularTab()], viewColumn: 3 },
      { tabs: [regularTab()], viewColumn: 5 },
    ];

    // closest right is group 3, not group 5
    expect(findRightGroupOfChatWebview()).toBe(3);
  });

  it('returns undefined when chat webview is in the rightmost group', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [chatTab()], viewColumn: 3 },
    ];

    expect(findRightGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when no chat webview is found', () => {
    vscodeMock.window.tabGroups.all = [
      { tabs: [regularTab()], viewColumn: 1 },
      { tabs: [regularTab()], viewColumn: 2 },
    ];

    expect(findRightGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when there are no tab groups', () => {
    vscodeMock.window.tabGroups.all = [];

    expect(findRightGroupOfChatWebview()).toBeUndefined();
  });

  it('returns undefined when tabGroups access throws', () => {
    Object.defineProperty(vscodeMock.window.tabGroups, 'all', {
      get: () => {
        throw new Error('unexpected error');
      },
      configurable: true,
    });

    expect(findRightGroupOfChatWebview()).toBeUndefined();

    Object.defineProperty(vscodeMock.window.tabGroups, 'all', {
      value: [],
      configurable: true,
      writable: true,
    });
  });
});
