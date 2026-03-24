/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * /loop command — run a prompt or slash command on a recurring interval.
 *
 * Usage:
 *   /loop [interval] <prompt>    Start a loop
 *   /loop status                 Show active loop status
 *   /loop stop                   Stop the active loop
 */

import {
  getLoopManager,
  parseInterval,
  formatInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
} from '@qwen-code/qwen-code-core';
import { MessageType } from '../types.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Parse /loop arguments into config.
 *
 * Supported formats:
 *   /loop 5m check CI           → interval=5m, maxIterations=0, prompt="check CI"
 *   /loop 5m --max 10 check CI  → interval=5m, maxIterations=10, prompt="check CI"
 *   /loop check CI              → interval=10m (default), prompt="check CI"
 *   /loop status
 *   /loop stop
 */
function parseLoopArgs(args: string): {
  subcommand?: 'status' | 'stop';
  intervalMs: number;
  maxIterations: number;
  prompt: string;
} {
  const tokens = args.trim().split(/\s+/);

  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === '')) {
    return { intervalMs: DEFAULT_INTERVAL_MS, maxIterations: 0, prompt: '' };
  }

  // Check for subcommands
  if (tokens[0] === 'status') {
    return {
      subcommand: 'status',
      intervalMs: 0,
      maxIterations: 0,
      prompt: '',
    };
  }
  if (tokens[0] === 'stop') {
    return {
      subcommand: 'stop',
      intervalMs: 0,
      maxIterations: 0,
      prompt: '',
    };
  }

  let intervalMs = DEFAULT_INTERVAL_MS;
  let maxIterations = 0;
  let startIndex = 0;

  // Try to parse first token as interval
  const parsed = parseInterval(tokens[0]);
  if (parsed !== null) {
    intervalMs = parsed;
    startIndex = 1;
  }

  // Check for --max N
  if (tokens[startIndex] === '--max' && startIndex + 1 < tokens.length) {
    const maxVal = parseInt(tokens[startIndex + 1], 10);
    if (!isNaN(maxVal) && maxVal > 0) {
      maxIterations = maxVal;
      startIndex += 2;
    }
  }

  const prompt = tokens.slice(startIndex).join(' ');

  return { intervalMs, maxIterations, prompt };
}

export const loopCommand: SlashCommand = {
  name: 'loop',
  get description() {
    return t('Run a prompt on a recurring interval');
  },
  kind: CommandKind.BUILT_IN,

  action: (context, args) => {
    const { ui } = context;
    const manager = getLoopManager();
    const parsed = parseLoopArgs(args);

    // /loop status
    if (parsed.subcommand === 'status') {
      const state = manager.getState();
      if (!state || !state.isActive) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No active loop.') },
          Date.now(),
        );
        return;
      }

      const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
      const iterationInfo =
        state.config.maxIterations > 0
          ? `${state.iteration}/${state.config.maxIterations}`
          : String(state.iteration);

      const status = state.isPaused
        ? t('paused ({{failures}} consecutive failures)', {
            failures: String(state.consecutiveFailures),
          })
        : t('running');

      ui.addItem(
        {
          type: MessageType.INFO,
          text: [
            t('Loop status: {{status}}', { status }),
            t('Prompt: {{prompt}}', { prompt: state.config.prompt }),
            t('Interval: {{interval}}', {
              interval: formatInterval(state.config.intervalMs),
            }),
            t('Iterations: {{iterations}}', { iterations: iterationInfo }),
            t('Elapsed: {{elapsed}}s', { elapsed: String(elapsed) }),
          ].join('\n'),
        },
        Date.now(),
      );
      return;
    }

    // /loop stop
    if (parsed.subcommand === 'stop') {
      if (!manager.isActive()) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No active loop to stop.') },
          Date.now(),
        );
        return;
      }

      const state = manager.getState();
      const iterations = state?.iteration ?? 0;
      manager.stop();

      ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Loop stopped after {{count}} iteration(s).', {
            count: String(iterations),
          }),
        },
        Date.now(),
      );
      return;
    }

    // /loop [interval] <prompt> — start a new loop
    if (!parsed.prompt) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Usage: /loop [interval] <prompt>\n' +
              'Examples:\n' +
              '  /loop 5m check if CI passed\n' +
              '  /loop 30s is the server healthy?\n' +
              '  /loop 1h --max 5 summarize new commits\n' +
              '  /loop status\n' +
              '  /loop stop',
          ),
        },
        Date.now(),
      );
      return;
    }

    if (parsed.intervalMs < MIN_INTERVAL_MS) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Minimum interval is {{min}}.', {
            min: formatInterval(MIN_INTERVAL_MS),
          }),
        },
        Date.now(),
      );
      return;
    }

    if (parsed.intervalMs > MAX_INTERVAL_MS) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Maximum interval is {{max}}.', {
            max: formatInterval(MAX_INTERVAL_MS),
          }),
        },
        Date.now(),
      );
      return;
    }

    // Stop any existing loop
    if (manager.isActive()) {
      manager.stop();
    }

    const maxInfo =
      parsed.maxIterations > 0
        ? t(', max {{max}} iterations', { max: String(parsed.maxIterations) })
        : '';

    ui.addItem(
      {
        type: MessageType.INFO,
        text: t(
          'Loop started: every {{interval}}{{maxInfo}}\nPrompt: {{prompt}}\nUse /loop stop to cancel.',
          {
            interval: formatInterval(parsed.intervalMs),
            maxInfo,
            prompt: parsed.prompt,
          },
        ),
      },
      Date.now(),
    );

    // Start the loop — skipFirstIteration because we return submit_prompt below
    manager.start(
      {
        prompt: parsed.prompt,
        intervalMs: parsed.intervalMs,
        maxIterations: parsed.maxIterations,
      },
      true,
    );

    // Submit the first iteration via the command system
    return {
      type: 'submit_prompt' as const,
      content: [{ text: parsed.prompt }],
    };
  },

  completion: async (_context, partialArg) => {
    const trimmed = partialArg.trim();
    if (!trimmed) {
      return ['status', 'stop', '5m ', '10m ', '30m ', '1h '];
    }
    if ('status'.startsWith(trimmed)) {
      return ['status'];
    }
    if ('stop'.startsWith(trimmed)) {
      return ['stop'];
    }
    return null;
  },
};
