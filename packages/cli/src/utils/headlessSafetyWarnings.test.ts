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
  readDangerousToolCounts,
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

describe('readDangerousToolCounts', () => {
  it('returns zeros when no relevant tools were invoked', () => {
    const m = metricsWithToolCounts({ read_file: 5, grep_search: 2 });
    expect(readDangerousToolCounts(m)).toEqual({ shell: 0, write: 0, edit: 0 });
  });

  it('pulls counts by canonical tool name', () => {
    const m = metricsWithToolCounts({
      run_shell_command: 4,
      write_file: 2,
      edit: 1,
      read_file: 12,
    });
    expect(readDangerousToolCounts(m)).toEqual({ shell: 4, write: 2, edit: 1 });
  });

  it('gracefully handles a metrics blob with no tools field', () => {
    expect(readDangerousToolCounts({} as unknown as SessionMetrics)).toEqual({
      shell: 0,
      write: 0,
      edit: 0,
    });
  });
});

describe('getDangerousToolAuditLine', () => {
  it('returns null when approval mode is not YOLO', () => {
    const cfg = { getApprovalMode: () => ApprovalMode.DEFAULT };
    expect(
      getDangerousToolAuditLine(cfg, { shell: 3, write: 1, edit: 0 }, {}),
    ).toBeNull();
  });

  it('returns null when no dangerous tools were invoked', () => {
    expect(
      getDangerousToolAuditLine(
        makeYoloConfig(),
        { shell: 0, write: 0, edit: 0 },
        {},
      ),
    ).toBeNull();
  });

  it('summarises shell / write / edit counts when YOLO and any are non-zero', () => {
    expect(
      getDangerousToolAuditLine(
        makeYoloConfig(),
        { shell: 4, write: 2, edit: 1 },
        {},
      ),
    ).toBe(
      'YOLO audit: executed 4 shell, 2 write, 1 edit tool call(s) during this run.',
    );
  });

  it('reports zeros for tools that were not invoked but still emits when at least one dangerous tool ran', () => {
    expect(
      getDangerousToolAuditLine(
        makeYoloConfig(),
        { shell: 0, write: 0, edit: 3 },
        {},
      ),
    ).toBe(
      'YOLO audit: executed 0 shell, 0 write, 3 edit tool call(s) during this run.',
    );
  });

  it('respects QWEN_CODE_SUPPRESS_YOLO_WARNING=1', () => {
    expect(
      getDangerousToolAuditLine(
        makeYoloConfig(),
        { shell: 1, write: 0, edit: 0 },
        { QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
      ),
    ).toBeNull();
  });

  it('does NOT suppress on QWEN_CODE_SUPPRESS_YOLO_WARNING=0 / false', () => {
    for (const val of ['0', 'false', '']) {
      expect(
        getDangerousToolAuditLine(
          makeYoloConfig(),
          { shell: 1, write: 0, edit: 0 },
          { QWEN_CODE_SUPPRESS_YOLO_WARNING: val },
        ),
      ).toContain('YOLO audit');
    }
  });

  it('models the "daemon / multi-run" case via delta counts (current minus baseline)', () => {
    // Simulating two consecutive runs in one process: telemetry singleton
    // has 5 cumulative shell calls, but this run only added 2 of them. The
    // caller subtracts the baseline before invoking the audit.
    const baseline = readDangerousToolCounts(
      metricsWithToolCounts({ run_shell_command: 3 }),
    );
    const current = readDangerousToolCounts(
      metricsWithToolCounts({ run_shell_command: 5 }),
    );
    const delta = {
      shell: current.shell - baseline.shell,
      write: current.write - baseline.write,
      edit: current.edit - baseline.edit,
    };
    expect(getDangerousToolAuditLine(makeYoloConfig(), delta, {})).toBe(
      'YOLO audit: executed 2 shell, 0 write, 0 edit tool call(s) during this run.',
    );
  });
});
