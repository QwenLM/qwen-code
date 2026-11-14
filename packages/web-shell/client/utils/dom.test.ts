// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it } from 'vitest';
import { isFocusUnclaimed } from './dom';

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

function shadow() {
  const host = document.createElement('div');
  host.tabIndex = 0;
  document.body.append(host);
  hosts.push(host);
  return { host, root: host.attachShadow({ mode: 'open' }) };
}

it('allows recovery when only the original shadow host retains focus', () => {
  const { host, root } = shadow();
  host.focus();
  expect(document.activeElement).toBe(host);
  expect(root.activeElement).toBeNull();
  expect(isFocusUnclaimed(root)).toBe(true);
});

it('preserves focus acquired inside the original shadow root', () => {
  const { root } = shadow();
  const control = document.createElement('button');
  root.append(control);
  control.focus();
  expect(root.activeElement).toBe(control);
  expect(isFocusUnclaimed(root)).toBe(false);
});

it('preserves focus acquired outside the original shadow root', () => {
  const { root } = shadow();
  const other = document.createElement('button');
  document.body.append(other);
  hosts.push(other);
  other.focus();
  expect(root.activeElement).toBeNull();
  expect(isFocusUnclaimed(root)).toBe(false);
});

it('checks focus outside a nested shadow root before recovering', () => {
  const { root } = shadow();
  const innerHost = document.createElement('div');
  innerHost.tabIndex = 0;
  root.append(innerHost);
  const inner = innerHost.attachShadow({ mode: 'open' });
  innerHost.focus();
  expect(isFocusUnclaimed(inner)).toBe(true);
  const other = document.createElement('button');
  root.append(other);
  other.focus();
  expect(isFocusUnclaimed(inner)).toBe(false);
});

it('does not recover through a disconnected shadow host', () => {
  const { host, root } = shadow();
  host.remove();
  expect(isFocusUnclaimed(root)).toBe(false);
});
