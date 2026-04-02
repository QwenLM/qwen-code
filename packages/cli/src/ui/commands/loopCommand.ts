/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * /loop command — run prompts on recurring intervals.
 *
 * Usage:
 *   /loop [interval] <prompt>                 Start a loop
 *   /loop [interval] --id <name> <prompt>     Start a named loop
 *   /loop <prompt> every <interval>           Start with trailing interval
 *   /loop list                                List all active loops
 *   /loop status [id]                         Show loop status
 *   /loop stop [id|--all]                     Stop loop(s)
 *   /loop pause [id|--all]                    Pause loop(s)
 *   /loop resume [id|--all]                   Resume loop(s)
 *   /loop restore [--all]                     Restore from previous session
 */

import {
  getLoopManager,
  parseInterval,
  formatInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_LOOPS,
  persistLoopStates,
  clearPersistedLoopState,
  loadPersistedLoopStates,
  acquireLock,
  releaseLock,
} from '@qwen-code/qwen-code-core';
import { MessageType } from '../types.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { join } from 'node:path';

function getQwenDir(): string {
  return join(process.cwd(), '.qwen');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type Subcommand = 'status' | 'stop' | 'resume' | 'pause' | 'restore' | 'list';

interface ParsedArgs {
  subcommand?: Subcommand;
  targetId?: string;
  targetAll?: boolean;
  loopId?: string;
  intervalMs: number;
  maxIterations: number;
  prompt: string;
}

const SUBCOMMANDS: Subcommand[] = [
  'status',
  'stop',
  'pause',
  'resume',
  'restore',
  'list',
];

function parseLoopArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/);

  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === '')) {
    return { intervalMs: DEFAULT_INTERVAL_MS, maxIterations: 0, prompt: '' };
  }

  // Subcommands
  if (SUBCOMMANDS.includes(tokens[0] as Subcommand)) {
    const sub = tokens[0] as Subcommand;
    let targetId: string | undefined;
    let targetAll = false;

    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--all') targetAll = true;
      else if (!targetId) targetId = tokens[i];
    }

    return {
      subcommand: sub,
      targetId,
      targetAll,
      intervalMs: 0,
      maxIterations: 0,
      prompt: '',
    };
  }

  let intervalMs = DEFAULT_INTERVAL_MS;
  let maxIterations = 0;
  let loopId: string | undefined;
  let startIndex = 0;

  // Leading interval
  const parsedInterval = parseInterval(tokens[0]);
  if (parsedInterval !== null) {
    intervalMs = parsedInterval;
    startIndex = 1;
  }

  // --id <name>
  if (tokens[startIndex] === '--id' && startIndex + 1 < tokens.length) {
    loopId = tokens[startIndex + 1];
    startIndex += 2;
  }

  // --max N — require valid positive integer; treat missing/invalid as error (empty prompt → usage)
  if (tokens[startIndex] === '--max') {
    if (startIndex + 1 >= tokens.length) {
      return { intervalMs, maxIterations: 0, prompt: '', loopId }; // triggers usage error
    }
    const maxVal = parseInt(tokens[startIndex + 1], 10);
    if (isNaN(maxVal) || maxVal <= 0) {
      return { intervalMs, maxIterations: 0, prompt: '', loopId }; // triggers usage error
    }
    maxIterations = maxVal;
    startIndex += 2;
  }

  let prompt = tokens.slice(startIndex).join(' ');

  // Trailing "every <interval>" syntax
  if (parsedInterval === null && prompt) {
    const everyMatch = prompt.match(
      /^(.+?)\s+every\s+(\d+(?:\.\d+)?)\s*([smhd]|seconds?|minutes?|hours?|days?)\s*$/i,
    );
    if (everyMatch) {
      const unitMap: Record<string, string> = {
        s: 's',
        second: 's',
        seconds: 's',
        m: 'm',
        minute: 'm',
        minutes: 'm',
        h: 'h',
        hour: 'h',
        hours: 'h',
        d: 'd',
        day: 'd',
        days: 'd',
      };
      const unit = unitMap[everyMatch[3].toLowerCase()];
      if (unit) {
        const trailingInterval = parseInterval(everyMatch[2] + unit);
        if (trailingInterval !== null) {
          intervalMs = trailingInterval;
          prompt = everyMatch[1].trim();
        }
      }
    }
  }

  return { intervalMs, maxIterations, prompt, loopId };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const loopCommand: SlashCommand = {
  name: 'loop',
  get description() {
    return t('Run a prompt on a recurring interval');
  },
  kind: CommandKind.BUILT_IN,

  action: async (context, args) => {
    const { ui } = context;
    const manager = getLoopManager();
    const parsed = parseLoopArgs(args);

    // Feature gate — read from merged settings using bracket notation
    const settings = (
      context.services.settings as unknown as Record<string, unknown>
    )?.['merged'] as Record<string, unknown> | undefined;
    if (settings?.['loopEnabled'] === false) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'The /loop command is disabled. Enable it in settings (loopEnabled).',
          ),
        },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'list') {
      const states = manager.getAllStates();
      if (states.size === 0) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No active loops.') },
          Date.now(),
        );
        return;
      }
      const lines: string[] = [];
      for (const [id, state] of states) {
        const label = state.config.label ? ` (${state.config.label})` : '';
        const status = state.isPaused ? t('paused') : t('running');
        lines.push(
          `  ${id}${label} — ${state.config.prompt} [${formatInterval(state.config.intervalMs)}, ${status}, iter ${state.iteration}]`,
        );
      }
      ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Active loops ({{count}}):\n{{list}}', {
            count: String(states.size),
            list: lines.join('\n'),
          }),
        },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // status [id]
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'status') {
      const state = parsed.targetId
        ? manager.getState(parsed.targetId)
        : manager.getState();
      if (!state || !state.isActive) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No active loop found.') },
          Date.now(),
        );
        return;
      }

      const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
      const iterInfo =
        state.config.maxIterations > 0
          ? `${state.iteration}/${state.config.maxIterations}`
          : String(state.iteration);

      let status: string;
      if (state.isPaused && state.consecutiveFailures > 0) {
        status = t('paused ({{failures}} consecutive failures)', {
          failures: String(state.consecutiveFailures),
        });
      } else if (state.isPaused) {
        status = t('paused');
      } else {
        status = t('running');
      }

      const lines = [
        t('Loop {{id}}: {{status}}', { id: state.id, status }),
        t('Prompt: {{prompt}}', { prompt: state.config.prompt }),
        t('Interval: {{interval}}', {
          interval: formatInterval(state.config.intervalMs),
        }),
        t('Iterations: {{iterations}}', { iterations: iterInfo }),
        t('Elapsed: {{elapsed}}s', { elapsed: String(elapsed) }),
      ];

      if (state.config.expiresAt) {
        const expiresIn = Math.max(
          0,
          Math.round((state.config.expiresAt - Date.now()) / 3_600_000),
        );
        lines.push(t('Expires in: {{hours}}h', { hours: String(expiresIn) }));
      }

      if (state.nextFireAt && !state.isPaused && !state.waitingForResponse) {
        const remaining = Math.max(
          0,
          Math.round((state.nextFireAt - Date.now()) / 1000),
        );
        lines.push(
          t('Next in: {{remaining}}s', { remaining: String(remaining) }),
        );
      }

      ui.addItem(
        { type: MessageType.INFO, text: lines.join('\n') },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // stop [id|--all]
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'stop') {
      const qwenDir = getQwenDir();

      // --all: stop everything
      if (parsed.targetAll) {
        const count = manager.getActiveCount();
        manager.stop();
        void clearPersistedLoopState(qwenDir);
        ui.addItem(
          {
            type: MessageType.INFO,
            text:
              count > 0
                ? t('Stopped {{count}} loop(s).', { count: String(count) })
                : t('No active loops to stop.'),
          },
          Date.now(),
        );
        return;
      }

      // Specific ID
      if (parsed.targetId) {
        if (!manager.isActive(parsed.targetId)) {
          ui.addItem(
            {
              type: MessageType.INFO,
              text: t('No loop with ID "{{id}}" found.', {
                id: parsed.targetId,
              }),
            },
            Date.now(),
          );
          return;
        }
        manager.stopOne(parsed.targetId);
        void persistLoopStates(manager.toPersistedStates(), qwenDir);
        ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Loop "{{id}}" stopped.', { id: parsed.targetId }),
          },
          Date.now(),
        );
        return;
      }

      // No target: stop default/first loop (safe for multi-loop)
      const defaultState = manager.getState();
      if (defaultState) {
        manager.stopOne(defaultState.id);
        if (manager.getActiveCount() > 0) {
          void persistLoopStates(manager.toPersistedStates(), qwenDir);
        } else {
          void clearPersistedLoopState(qwenDir);
        }
        ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Loop "{{id}}" stopped.', { id: defaultState.id }),
          },
          Date.now(),
        );
        return;
      }

      // No active loops — clear persisted state (dismiss notification)
      void clearPersistedLoopState(qwenDir);
      ui.addItem(
        { type: MessageType.INFO, text: t('No active loops to stop.') },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // pause [id|--all]
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'pause') {
      if (parsed.targetAll) {
        manager.pause();
        ui.addItem(
          { type: MessageType.INFO, text: t('All loops paused.') },
          Date.now(),
        );
        return;
      }
      const id = parsed.targetId;
      const state = id ? manager.getState(id) : manager.getState();
      if (!state || !state.isActive || state.isPaused) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No running loop to pause.') },
          Date.now(),
        );
        return;
      }
      manager.pause(state.id);
      ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Loop "{{id}}" paused. Use /loop resume to continue.', {
            id: state.id,
          }),
        },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // resume [id|--all]
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'resume') {
      if (parsed.targetAll) {
        manager.resume();
        ui.addItem(
          { type: MessageType.INFO, text: t('All paused loops resumed.') },
          Date.now(),
        );
        return;
      }
      const id = parsed.targetId;
      const state = id ? manager.getState(id) : manager.getState();
      if (!state || !state.isPaused) {
        ui.addItem(
          { type: MessageType.INFO, text: t('No paused loop to resume.') },
          Date.now(),
        );
        return;
      }
      manager.resume(state.id);
      ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Loop "{{id}}" resumed.', { id: state.id }),
        },
        Date.now(),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // restore [--all]
    // -----------------------------------------------------------------------
    if (parsed.subcommand === 'restore') {
      if (manager.getActiveCount() > 0 && !parsed.targetAll) {
        ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Loops already active. Use /loop stop --all first, or /loop restore --all.',
            ),
          },
          Date.now(),
        );
        return;
      }
      const qwenDir = getQwenDir();

      // Multi-session coordination: acquire lock before restoring persisted state
      const sessionId = `session-${process.pid}`;
      const locked = await acquireLock(qwenDir, sessionId);
      if (!locked) {
        ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Another session is managing loops in this project. Only one session can restore at a time.',
            ),
          },
          Date.now(),
        );
        return;
      }

      const persisted = await loadPersistedLoopStates(qwenDir);
      if (!persisted || persisted.tasks.length === 0) {
        await releaseLock(qwenDir, sessionId);
        ui.addItem(
          { type: MessageType.INFO, text: t('No saved loops found.') },
          Date.now(),
        );
        return;
      }

      const maxLoops =
        (settings?.['loopMaxConcurrent'] as number) ?? DEFAULT_MAX_LOOPS;
      let restored = 0;
      let firstPrompt: string | null = null;
      for (const task of persisted.tasks) {
        if (manager.getActiveCount() >= maxLoops) break;
        manager.start({ ...task.config, id: task.id }, true);
        if (!firstPrompt) firstPrompt = task.config.prompt;
        restored++;
      }

      ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Restored {{count}} loop(s). Use /loop list to see them.', {
            count: String(restored),
          }),
        },
        Date.now(),
      );

      // Only submit the prompt if the first restored loop got the streaming slot.
      // If the slot was busy (existing loop streaming), restored loops start via timers.
      const waitingId = manager.getWaitingLoopId();
      if (firstPrompt && waitingId) {
        return {
          type: 'submit_prompt' as const,
          content: [{ text: firstPrompt }],
        };
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Start a new loop
    // -----------------------------------------------------------------------
    if (!parsed.prompt) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Usage: /loop [interval] <prompt>\n' +
              'Examples:\n' +
              '  /loop 5m check if CI passed\n' +
              '  /loop 30s --id ci is the server healthy?\n' +
              '  /loop 1h --max 5 summarize new commits\n' +
              '  /loop check the deploy every 20m\n' +
              '  /loop list | status | stop | pause | resume | restore',
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

    const maxLoops =
      (settings?.['loopMaxConcurrent'] as number) ?? DEFAULT_MAX_LOOPS;
    // Allow if this replaces an existing loop (same named ID); block otherwise
    const replacing = parsed.loopId && manager.isActive(parsed.loopId);
    if (manager.getActiveCount() >= maxLoops && !replacing) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Maximum concurrent loops reached ({{max}}). Stop one first with /loop stop.',
            { max: String(maxLoops) },
          ),
        },
        Date.now(),
      );
      return;
    }

    // Warn when overwriting unnamed default loop
    if (!parsed.loopId && manager.getActiveCount() > 0) {
      const defaultState = manager.getState();
      if (defaultState) {
        ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Previous loop stopped (was: {{prompt}})', {
              prompt: defaultState.config.prompt,
            }),
          },
          Date.now(),
        );
      }
    }

    // Wire up settings for expiry and jitter
    const expiryDays = (settings?.['loopExpiryDays'] as number) ?? 7;
    const jitterEnabled = settings?.['loopJitterEnabled'] !== false;

    const config = {
      prompt: parsed.prompt,
      intervalMs: parsed.intervalMs,
      maxIterations: parsed.maxIterations,
      id: parsed.loopId,
      expiresAt:
        expiryDays > 0 ? Date.now() + expiryDays * 24 * 60 * 60 * 1000 : 0, // 0 is falsy → skips expiry check in LoopManager
      jitter: jitterEnabled,
    };

    const loopIdResult = manager.start(config, true);

    const maxInfo =
      parsed.maxIterations > 0
        ? t(', max {{max}} iterations', { max: String(parsed.maxIterations) })
        : '';

    ui.addItem(
      {
        type: MessageType.INFO,
        text: t(
          'Loop "{{id}}" started: every {{interval}}{{maxInfo}}\nPrompt: {{prompt}}\nUse /loop stop {{id}} to cancel.',
          {
            id: loopIdResult,
            interval: formatInterval(parsed.intervalMs),
            maxInfo,
            prompt: parsed.prompt,
          },
        ),
      },
      Date.now(),
    );

    // Persist
    const qwenDir = getQwenDir();
    void persistLoopStates(manager.toPersistedStates(), qwenDir);

    // Only submit the prompt if this loop got the streaming slot.
    // If the slot was busy, the loop will fire via its timer instead.
    if (manager.getWaitingLoopId() === loopIdResult) {
      return {
        type: 'submit_prompt' as const,
        content: [{ text: parsed.prompt }],
      };
    }
    return;
  },

  completion: async (_context, partialArg) => {
    const tokens = partialArg.trim().split(/\s+/);
    const trimmed = partialArg.trim();

    if (!trimmed) {
      return [
        'list',
        'status',
        'stop',
        'pause',
        'resume',
        'restore',
        '5m ',
        '10m ',
        '30m ',
        '1h ',
        '1d ',
      ];
    }

    // First token: subcommand completion
    if (tokens.length === 1) {
      const all = [...SUBCOMMANDS, '--id'];
      const matches = all.filter((s) => s.startsWith(trimmed));
      if (matches.length > 0) return matches;
    }

    // Second token after targeted subcommand: complete loop IDs
    if (
      tokens.length === 2 &&
      ['status', 'stop', 'pause', 'resume'].includes(tokens[0])
    ) {
      const manager = getLoopManager();
      const ids = [...manager.getAllStates().keys(), '--all'];
      return ids.filter((id) => id.startsWith(tokens[1]));
    }

    return null;
  },
};
