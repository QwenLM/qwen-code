/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  startAcceptanceEnv,
  type AcceptanceEnv,
  type LiveModel,
} from './harness.js';
import type { CaseResult, CheckResult } from './report.js';
import { toolUse } from './tool-use.js';

export async function runLiveCase(
  model: LiveModel,
  name: string,
  trial: number,
  drive: (env: AcceptanceEnv) => Promise<CheckResult[]>,
): Promise<CaseResult> {
  let env: AcceptanceEnv | undefined;
  let checks: CheckResult[] = [];
  let error: string | undefined;
  try {
    env = await startAcceptanceEnv({
      mode: { kind: 'live', model },
      cardTimeoutMs: 15 * 60 * 1000,
    });
    checks = await drive(env);
  } catch (caught) {
    error = String(caught instanceof Error ? caught.message : caught).split(
      '\n',
    )[0];
    await env?.screenshot(`${name}-failure`);
  } finally {
    await env?.close();
  }
  const { calledTool, viewErrors } = toolUse(env?.mainRequests() ?? []);
  if (error) {
    checks.push({
      id: `${name}.harness`,
      covers: '—',
      status: 'fail',
      detail: error,
    });
  }
  const firstCardMs = env?.firstCardMs;
  return {
    case: name,
    model: model.label,
    trial,
    calledTool,
    viewErrors,
    secondsToFirstCard:
      firstCardMs === undefined ? undefined : Math.round(firstCardMs / 1000),
    checks,
  };
}
