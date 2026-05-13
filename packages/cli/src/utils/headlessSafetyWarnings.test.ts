/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ApprovalMode, type Config } from '@qwen-code/qwen-code-core';
import {
  HEADLESS_YOLO_NO_SANDBOX_WARNING,
  getHeadlessYoloSafetyWarning,
} from './headlessSafetyWarnings.js';

function makeConfig(
  approvalMode: ApprovalMode,
  sandbox: unknown,
): Pick<Config, 'getApprovalMode' | 'getSandbox'> {
  return {
    getApprovalMode: () => approvalMode,
    // The real return type is `SandboxConfig | undefined`; the warning
    // policy only cares about truthiness so the tests model it as such.
    getSandbox: () => sandbox as ReturnType<Config['getSandbox']>,
  };
}

describe('getHeadlessYoloSafetyWarning', () => {
  it('warns when approval mode is YOLO and no sandbox is configured', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    expect(getHeadlessYoloSafetyWarning(cfg, {})).toBe(
      HEADLESS_YOLO_NO_SANDBOX_WARNING,
    );
  });

  it('does not warn when approval mode is not YOLO', () => {
    const cfg = makeConfig(ApprovalMode.DEFAULT, undefined);
    expect(getHeadlessYoloSafetyWarning(cfg, {})).toBeNull();
  });

  it('does not warn when a sandbox is configured', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, {
      command: 'docker',
      image: 'qwen-code-sandbox',
    });
    expect(getHeadlessYoloSafetyWarning(cfg, {})).toBeNull();
  });

  it('does not warn when SANDBOX env indicates we are already sandboxed', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    expect(
      getHeadlessYoloSafetyWarning(cfg, { SANDBOX: 'sandbox-exec' }),
    ).toBeNull();
  });

  it('respects the explicit suppression env var', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    expect(
      getHeadlessYoloSafetyWarning(cfg, {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
      }),
    ).toBeNull();
  });
});
