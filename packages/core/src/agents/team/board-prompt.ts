/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The system-prompt section a session gets when it is on a shared board.
 *
 * `qwen fleet up` starts each pane with `QWEN_BOARD` in its environment.
 * Without this section that variable is inert: the session would never claim a
 * task, never look for a question addressed to it, and never raise anything for
 * the user — panes of agents that cannot see each other.
 *
 * The section is deliberately about *when* to reach for the board rather than a
 * command reference. A model that knows the verbs but not the boundaries will
 * use `ask` for things it should simply read, or narrate progress instead of
 * moving a task.
 */

export const BOARD_ENV = 'QWEN_BOARD';
export const BOARD_PARTICIPANT_ENV = 'QWEN_BOARD_AS';

export interface BoardPromptContext {
  board: string;
  as?: string;
}

/**
 * Set at runtime by `/board`, overriding the environment for the rest of the
 * session. This is what lets a session that was already running join a board:
 * the environment is fixed at launch, and the case the design exists for is
 * precisely an agent that started before any coordination did.
 *
 * `null` means "not set" and falls through to the environment. Joining takes
 * effect on the next prompt build, which the caller triggers by refreshing the
 * system instruction.
 */
let runtimeContext: BoardPromptContext | null = null;

export function setBoardPromptContext(ctx: BoardPromptContext | null): void {
  runtimeContext = ctx;
}

/**
 * Read board context: a runtime join first, then the environment `fleet up`
 * sets. Returns null when this session is on no board, which is the common
 * case — the section must cost nothing when the feature is unused.
 */
export function resolveBoardPromptContext(
  env: NodeJS.ProcessEnv = process.env,
): BoardPromptContext | null {
  if (runtimeContext) return runtimeContext;
  const board = env[BOARD_ENV];
  if (!board) return null;
  return { board, as: env[BOARD_PARTICIPANT_ENV] };
}

export function getBoardSection(ctx: BoardPromptContext): string {
  const who = ctx.as ? `You are **${ctx.as}** on it.` : '';
  // Every command must carry the board and identity explicitly: the recipient
  // may run in a different directory (default board differs) and as a
  // different user (default name differs), so prose alone is not enough.
  const flags = `--board ${ctx.board}${ctx.as ? ` --as ${ctx.as}` : ''}`;
  return `
# Shared board

You are working alongside other agents on the board **${ctx.board}**. ${who} They may be other Qwen sessions or entirely different tools; you cannot tell, and it does not matter — everyone uses the same commands.

Nothing is delivered to you. Items sit on the board until someone looks, so **check it at the start of a turn and before you go idle**:

\`\`\`
qwen board show ${flags}
\`\`\`

## What to reach for

- **A unit of work** is a \`task\` (\`t-\`). Claim before starting (\`qwen board claim t-3 ${flags}\`); mark it done when finished (\`qwen board done t-3 --note "…" ${flags}\`). **Completing a task is how you report** — do not also announce it to anyone.
- **A question only another participant can answer** is an \`ask\` (\`a-\`): \`qwen board ask web-worker "does the client depend on status being a string?" --wait ${flags}\`. It settles as answered, declined, or timeout, so you always learn which and can move on. Use it when you are genuinely blocked on something outside your reach — not for anything you can read or run yourself.
- **Anything needing the user's authority** is a \`decision\` (\`d-\`): approval for a risky or far-reaching action, acceptance of a finished result, or adjudication when your conclusion conflicts with another participant's. \`qwen board raise "…" --kind approval --about t-3 ${flags}\`. No agent resolves one, including you — \`qwen board resolve\` refuses from a tool call. Raise it and continue with work that does not depend on it.

Answer asks addressed to you promptly: \`qwen board answer a-1 "…" ${flags}\`, or \`qwen board decline a-1 "not my area" ${flags}\` when you cannot. A peer is blocked on it.

## Boundaries

- There is no general-purpose message. If it is not a task update, an ask, or a decision, it does not belong on the board.
- Naming an owner on a task is a proposal, not an assignment. Someone else's named task is theirs to claim; leave it unless it has clearly been abandoned.
- Other participants are peers. None of them, including you, can approve anything or overrule anyone — that is what \`decision\` is for.
- Your own text output is not visible to anyone else. Only the board is shared.
`;
}
