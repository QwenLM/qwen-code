/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BrowserInfo {
  id: string;
  name: string;
  type: 'extension';
  family: 'chrome';
}

export interface TabInfo {
  id: string;
  title: string | null;
  url: string | null;
}

export interface BrowserUserTabInfo {
  id: string;
  title: string | null;
  url: string | null;
  lastOpened?: string;
  tabGroup?: string;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  dateVisited: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotEnvelope {
  base64: string;
  width: number;
  height: number;
  viewport: {
    width: number;
    height: number;
  };
  devicePixelRatio: number;
  coordinateSpace: 'css-pixels';
}

export interface LogEntry {
  level: 'debug' | 'info' | 'log' | 'warn' | 'error';
  message: string;
  timestamp: string;
  url?: string;
}

export const SNAPSHOT_REF_PATTERN = /^(?:f\d{1,9})?e\d{1,9}$/;

type JsonPrimitive = string | number | boolean | null;
export type DispatchResult =
  | JsonPrimitive
  | BrowserInfo
  | TabInfo
  | BrowserUserTabInfo
  | BrowserHistoryEntry
  | ScreenshotEnvelope
  | Box
  | DispatchResult[]
  | { readonly [key: string]: DispatchResult };

export type LocatorMatcher = string | { regex: string; flags?: string };
export type LocatorStep =
  | { kind: 'locator'; selector: string }
  | { kind: 'frame'; selector: string }
  | { kind: 'getByRole'; role: string; name?: LocatorMatcher; exact?: boolean }
  | {
      kind: 'getByText' | 'getByLabel' | 'getByPlaceholder';
      text: LocatorMatcher;
      exact?: boolean;
    }
  | { kind: 'getByTestId'; testId: string }
  | {
      kind: 'filter';
      hasText?: LocatorMatcher;
      hasNotText?: LocatorMatcher;
      has?: LocatorStep[];
      hasNot?: LocatorStep[];
      visible?: boolean;
    }
  | { kind: 'first' | 'last' }
  | { kind: 'nth'; index: number }
  | { kind: 'and' | 'or'; steps: LocatorStep[] };
export type BrowserSelectOption =
  | string
  | (
      | { index: number; label?: string; value?: string }
      | { index?: number; label: string; value?: string }
      | { index?: number; label?: string; value: string }
    );
