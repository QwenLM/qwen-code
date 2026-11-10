/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SHOW_TOOL,
  messageText,
  startAcceptanceEnv,
  type AcceptanceEnv,
  type LiveModel,
} from './harness.js';
import type { CaseResult, CheckResult } from './report.js';

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
  const main = env?.mainRequests() ?? [];
  const calledTool = main.some((request) =>
    request.messages.some((message) =>
      (message.tool_calls ?? []).some(
        (call) => call.function?.name === SHOW_TOOL,
      ),
    ),
  );
  const last = main[main.length - 1];
  const showIds = new Set(
    (last?.messages ?? []).flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function?.name === SHOW_TOOL)
        .map((call) => call.id),
    ),
  );
  const viewErrors = (last?.messages ?? []).filter(
    (message) =>
      message.role === 'tool' &&
      showIds.has(message.tool_call_id) &&
      messageText(message.content).includes('VIEW_ERROR'),
  ).length;
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
