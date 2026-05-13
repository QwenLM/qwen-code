/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ApprovalMode,
  type Config,
  type SessionMetrics,
} from '@qwen-code/qwen-code-core';
import {
  HEADLESS_YOLO_NO_SANDBOX_WARNING,
  getHeadlessYoloSafetyWarning,
  getDangerousToolAuditLine,
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

function metricsWithToolCounts(
  counts: Partial<Record<string, number>>,
): SessionMetrics {
  const byName: Record<string, { count: number }> = {};
  for (const [name, count] of Object.entries(counts)) {
    if (count !== undefined) byName[name] = { count };
  }
  return {
    tools: { byName },
    // The audit reader only touches `tools.byName.<name>.count`, so the
    // rest of the SessionMetrics shape is irrelevant; cast through unknown
    // to avoid duplicating the entire schema in tests.
  } as unknown as SessionMetrics;
}

function makeYoloConfig(): Pick<Config, 'getApprovalMode'> {
  return { getApprovalMode: () => ApprovalMode.YOLO };
}

describe('getDangerousToolAuditLine', () => {
  it('returns null when approval mode is not YOLO', () => {
    const cfg = { getApprovalMode: () => ApprovalMode.DEFAULT };
    const metrics = metricsWithToolCounts({
      run_shell_command: 3,
      write_file: 1,
    });
    expect(getDangerousToolAuditLine(cfg, metrics, {})).toBeNull();
  });

  it('returns null when no dangerous tools were invoked', () => {
    const metrics = metricsWithToolCounts({
      read_file: 5,
      grep_search: 2,
    });
    expect(getDangerousToolAuditLine(makeYoloConfig(), metrics, {})).toBeNull();
  });

  it('summarises shell / write / edit counts when YOLO and any are non-zero', () => {
    const metrics = metricsWithToolCounts({
      run_shell_command: 4,
      write_file: 2,
      edit: 1,
      read_file: 12, // ignored
    });
    expect(getDangerousToolAuditLine(makeYoloConfig(), metrics, {})).toBe(
      'YOLO audit: executed 4 shell, 2 write, 1 edit tool call(s) during this run.',
    );
  });

  it('reports zeros for tools that were not invoked but still emits when at least one dangerous tool ran', () => {
    const metrics = metricsWithToolCounts({ edit: 3 });
    expect(getDangerousToolAuditLine(makeYoloConfig(), metrics, {})).toBe(
      'YOLO audit: executed 0 shell, 0 write, 3 edit tool call(s) during this run.',
    );
  });

  it('respects QWEN_CODE_SUPPRESS_YOLO_WARNING=1', () => {
    const metrics = metricsWithToolCounts({ run_shell_command: 1 });
    expect(
      getDangerousToolAuditLine(makeYoloConfig(), metrics, {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
      }),
    ).toBeNull();
  });

  it('does NOT suppress on QWEN_CODE_SUPPRESS_YOLO_WARNING=0 / false', () => {
    const metrics = metricsWithToolCounts({ run_shell_command: 1 });
    for (const val of ['0', 'false', '']) {
      expect(
        getDangerousToolAuditLine(makeYoloConfig(), metrics, {
          QWEN_CODE_SUPPRESS_YOLO_WARNING: val,
        }),
      ).toContain('YOLO audit');
    }
  });
});
