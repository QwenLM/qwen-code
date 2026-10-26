/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Presentation logic for the Agents page (roster and runtimes).
 *
 * Everything here is pure and testable without a browser, following the same
 * split as `agents-manager-logic.ts`.
 */

/**
 * The programs an agent can run as. Mirrors `SessionAgentProgram` in
 * `@qwen-code/sdk/daemon`; a runtime reports which of them it can run.
 */
export const AGENT_PROGRAMS = ['qwen', 'claude', 'codex'] as const;
export type AgentProgramView = (typeof AGENT_PROGRAMS)[number];

export function programLabel(program: string | undefined): string {
  return program === 'codex'
    ? 'Codex'
    : program === 'claude'
      ? 'Claude Code'
      : 'Qwen Code';
}

/** Narrows a server-sent program id; anything unknown is dropped. */
export function isAgentProgram(value: unknown): value is AgentProgramView {
  return (AGENT_PROGRAMS as readonly unknown[]).includes(value);
}

/**
 * The programs a runtime offers, in display order. An omitted field keeps the
 * older daemon's Qwen default; an explicit empty list offers no programs.
 */
export function runtimePrograms(runtime: {
  programs?: readonly string[];
}): AgentProgramView[] {
  const reported = AGENT_PROGRAMS.filter((program) =>
    runtime.programs?.includes(program),
  );
  return runtime.programs === undefined ? ['qwen'] : reported;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** "45 秒" or "6 分 45 秒": the one duration format the collaboration UI uses. */
export function formatElapsed(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return t('collab.elapsed.seconds', { count: seconds });
  return t('collab.elapsed.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}
