/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QWEN_CODE_DESKTOP_ENV,
  QWEN_CODE_SERVE_ENV,
  resolveTelemetryClient,
  resolveTelemetryRuntime,
} from './runtime-attribution.js';

describe('resolveTelemetryRuntime', () => {
  it('returns cli when there is no channel and no daemon marker', () => {
    expect(resolveTelemetryRuntime(undefined, {})).toBe('cli');
  });

  it('returns acp when a channel is set without the daemon marker', () => {
    expect(resolveTelemetryRuntime('ACP', {})).toBe('acp');
    expect(resolveTelemetryRuntime('VSCode', {})).toBe('acp');
    expect(resolveTelemetryRuntime('desktop', {})).toBe('acp');
  });

  it('returns daemon when the daemon marker is set', () => {
    expect(
      resolveTelemetryRuntime(undefined, { [QWEN_CODE_SERVE_ENV]: '1' }),
    ).toBe('daemon');
  });

  it('prefers the daemon marker over the channel heuristic', () => {
    // Daemon-spawned ACP children fall back to channel "ACP", which is
    // otherwise indistinguishable from a direct third-party ACP launch.
    expect(resolveTelemetryRuntime('ACP', { [QWEN_CODE_SERVE_ENV]: '1' })).toBe(
      'daemon',
    );
    expect(
      resolveTelemetryRuntime('feishu', { [QWEN_CODE_SERVE_ENV]: '1' }),
    ).toBe('daemon');
  });

  it('ignores an empty daemon marker', () => {
    expect(
      resolveTelemetryRuntime(undefined, { [QWEN_CODE_SERVE_ENV]: '' }),
    ).toBe('cli');
  });
});

describe('resolveTelemetryClient', () => {
  it('maps the VS Code companion channel to vscode', () => {
    expect(resolveTelemetryClient('VSCode', {})).toBe('vscode');
  });

  it('maps the Electron desktop channel to desktop', () => {
    expect(resolveTelemetryClient('desktop', {})).toBe('desktop');
  });

  it('maps the desktop-shell env marker to desktop-shell', () => {
    expect(
      resolveTelemetryClient(undefined, { [QWEN_CODE_DESKTOP_ENV]: '1' }),
    ).toBe('desktop-shell');
    expect(
      resolveTelemetryClient('ACP', { [QWEN_CODE_DESKTOP_ENV]: '1' }),
    ).toBe('desktop-shell');
  });

  it('prefers the channel identity over the env marker', () => {
    expect(
      resolveTelemetryClient('VSCode', { [QWEN_CODE_DESKTOP_ENV]: '1' }),
    ).toBe('vscode');
  });

  it('returns undefined when no first-party client is identifiable', () => {
    expect(resolveTelemetryClient(undefined, {})).toBeUndefined();
    expect(resolveTelemetryClient('ACP', {})).toBeUndefined();
    expect(resolveTelemetryClient('some-third-party', {})).toBeUndefined();
  });

  it('ignores an empty desktop-shell marker', () => {
    expect(
      resolveTelemetryClient(undefined, { [QWEN_CODE_DESKTOP_ENV]: '' }),
    ).toBeUndefined();
  });
});
