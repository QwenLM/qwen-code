/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen fleet up` — lay out a board and its participants in tmux.
 *
 * This writes no terminal code. tmux already provides everything the layout
 * needs — panes, per-pane working directories, keyboard switching, zoom,
 * detach and reattach, and a server that keeps the processes alive when the
 * client goes away. The command is a sequence of calls into the tmux wrappers
 * that already ship in core.
 *
 * What it adds is the leftmost pane: a live view of the board, which tmux
 * cannot know anything about. That pane is the whole reason the command
 * exists — the rest is arranging windows.
 *
 * Agents are started with the command passed at split time rather than typed
 * in afterwards, so there is no window where keystrokes can land before a
 * shell is ready.
 */

import type { CommandModule, Argv } from 'yargs';
import {
  verifyTmux,
  tmuxHasSession,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxSplitWindow,
  tmuxSelectPane,
  tmuxSelectPaneTitle,
  tmuxSelectLayout,
  tmuxSetOption,
  tmuxRespawnPane,
  tmuxListPanes,
  parseTmuxListPanes,
  tmuxCurrentWindowTarget,
  tmuxCurrentSession,
} from '@qwen-code/qwen-code-core';
import {
  resolveBoardName,
  BOARD_ENV,
  PARTICIPANT_ENV,
} from './board/context.js';

const DEFAULT_SESSION = 'qwen-fleet';
/** Columns given to the board pane. Narrow enough to leave the agents readable. */
const BOARD_WIDTH_COLUMNS = 46;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command a pane runs. Board and participant travel as environment
 * variables so every later `qwen board …` in that pane inherits them without
 * repeating the flags.
 */
function paneCommand(
  board: string,
  as: string | undefined,
  command: string,
): string {
  const env = [`${BOARD_ENV}=${shellQuote(board)}`];
  if (as) env.push(`${PARTICIPANT_ENV}=${shellQuote(as)}`);
  return `env ${env.join(' ')} ${command}`;
}

export const fleetCommand: CommandModule = {
  command: 'fleet',
  describe: 'Run several agents against one board',
  builder: (yargs: Argv) =>
    yargs
      .command({
        command: 'up [goal]',
        describe: 'Open a tmux layout with a board pane and agent panes',
        builder: (y: Argv) =>
          y
            .positional('goal', {
              type: 'string',
              describe: 'Seed the board with this as the first task',
            })
            .option('agents', {
              type: 'number',
              default: 2,
              describe: 'How many Qwen agent panes to open',
            })
            .option('with', {
              type: 'array',
              string: true,
              default: [] as string[],
              describe:
                'Extra commands to run in their own panes, e.g. --with codex',
            })
            .option('board', { type: 'string' })
            .option('session', { type: 'string', default: DEFAULT_SESSION })
            .option('attach', {
              type: 'boolean',
              default: true,
              describe: 'Attach after the layout is built',
            }),
        handler: async (argv) => {
          const a = argv as unknown as {
            goal?: string;
            agents: number;
            with: string[];
            board?: string;
            session: string;
            attach: boolean;
          };
          try {
            await verifyTmux();
          } catch (err) {
            console.error(
              `${err instanceof Error ? err.message : String(err)}\n` +
                `Install tmux, or start the agents yourself in separate ` +
                `terminals — they only need ${BOARD_ENV} set to the same board.`,
            );
            process.exitCode = 1;
            return;
          }

          const board = resolveBoardName({ board: a.board });

          if (a.goal) {
            const { createBoardTask } =
              await import('@qwen-code/qwen-code-core');
            await createBoardTask({ board, subject: a.goal });
          }

          // Inside tmux already: add a window rather than a second session, so
          // the user does not end up with nested clients.
          const inside = Boolean(process.env['TMUX']);
          let target: string;
          if (inside) {
            // Add the window to the session the user is actually in. Using the
            // configured name here fails outright when their current session is
            // called anything else, which is the common case.
            const current = await tmuxCurrentSession();
            await tmuxNewWindow(current, board);
            target = await tmuxCurrentWindowTarget();
          } else {
            if (!(await tmuxHasSession(a.session))) {
              await tmuxNewSession(a.session, { windowName: board });
            }
            target = `${a.session}:`;
          }

          // The window's existing pane becomes the board, respawned rather
          // than typed into: send-keys would race a shell that may not be
          // ready, and respawn-pane makes the command the pane's process.
          const existing = parseTmuxListPanes(await tmuxListPanes(target));
          const boardPane = existing[0]?.paneId;
          if (!boardPane) {
            console.error('Could not find a pane to host the board.');
            process.exitCode = 1;
            return;
          }
          await tmuxRespawnPane(
            boardPane,
            paneCommand(
              board,
              undefined,
              `qwen board watch --board ${shellQuote(board)}`,
            ),
          );

          const specs: Array<{ name: string; command: string }> = [];
          for (let i = 1; i <= Math.max(0, a.agents); i++) {
            const name = `agent-${i}`;
            specs.push({ name, command: paneCommand(board, name, 'qwen') });
          }
          a.with.forEach((cmd, i) => {
            const name = `ext-${i + 1}`;
            // A foreign agent never reads QWEN_BOARD, and nothing we control
            // can inject into its prompt. Printing the protocol into its pane
            // first is the most we can do without pretending otherwise: the
            // operator hands it over, and it is right there to copy.
            specs.push({
              name,
              command: paneCommand(
                board,
                name,
                `sh -c ${shellQuote(`qwen board protocol; exec ${cmd}`)}`,
              ),
            });
          });

          // No explicit sizes: an N-way split computed by hand hits `-l 100%`
          // on the last pane, which tmux rejects. Create the panes, then let
          // `main-vertical` do the arithmetic — it puts the first pane on the
          // left and stacks the rest on the right, which is the layout.
          for (const spec of specs) {
            const pane = await tmuxSplitWindow(boardPane, {
              command: spec.command,
            });
            await tmuxSelectPaneTitle(pane, spec.name);
          }

          if (specs.length > 0) {
            await tmuxSetOption(
              target,
              'main-pane-width',
              String(BOARD_WIDTH_COLUMNS),
            );
            await tmuxSelectLayout(target, 'main-vertical');
          }

          await tmuxSelectPane(boardPane);

          if (!a.attach || inside) {
            console.log(
              inside
                ? `Board "${board}" opened in a new window.`
                : `Board "${board}" ready. Attach with: tmux attach -t ${a.session}`,
            );
            return;
          }
          // Replace this process so the user lands in the session directly and
          // Ctrl-C reaches tmux rather than us.
          const { spawnSync } = await import('node:child_process');
          spawnSync('tmux', ['attach', '-t', a.session], {
            stdio: 'inherit',
          });
        },
      })
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
