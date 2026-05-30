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
    // Real return type is `SandboxConfig | undefined`; the warning policy
    // only cares about truthiness so the tests model it as such.
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

  it('does not warn when SANDBOX env is set to the value the sandbox transport actually writes', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    // macOS seatbelt
    expect(
      getHeadlessYoloSafetyWarning(cfg, { SANDBOX: 'sandbox-exec' }),
    ).toBeNull();
    // Docker / Podman container name
    expect(
      getHeadlessYoloSafetyWarning(cfg, { SANDBOX: 'qwen-code-sandbox' }),
    ).toBeNull();
    // Generic truthy values
    expect(getHeadlessYoloSafetyWarning(cfg, { SANDBOX: '1' })).toBeNull();
    expect(getHeadlessYoloSafetyWarning(cfg, { SANDBOX: 'true' })).toBeNull();
  });

  it('warns when SANDBOX env is unset or empty string', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    expect(getHeadlessYoloSafetyWarning(cfg, {})).toBe(
      HEADLESS_YOLO_NO_SANDBOX_WARNING,
    );
    expect(getHeadlessYoloSafetyWarning(cfg, { SANDBOX: '' })).toBe(
      HEADLESS_YOLO_NO_SANDBOX_WARNING,
    );
  });

  it('respects the explicit suppression env var when set to 1 or true', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    expect(
      getHeadlessYoloSafetyWarning(cfg, {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
      }),
    ).toBeNull();
    expect(
      getHeadlessYoloSafetyWarning(cfg, {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: 'true',
      }),
    ).toBeNull();
  });

  it('does NOT suppress when QWEN_CODE_SUPPRESS_YOLO_WARNING is 0 / false / empty', () => {
    const cfg = makeConfig(ApprovalMode.YOLO, undefined);
    for (const val of ['0', 'false', '', 'no']) {
      expect(
        getHeadlessYoloSafetyWarning(cfg, {
          QWEN_CODE_SUPPRESS_YOLO_WARNING: val,
        }),
      ).toBe(HEADLESS_YOLO_NO_SANDBOX_WARNING);
    }
  });
});
