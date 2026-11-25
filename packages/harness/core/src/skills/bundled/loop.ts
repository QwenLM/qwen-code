/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * @fileoverview `/loop` bundled skill — schedules a recurring prompt or slash
 * command via the cron subsystem (fixed-interval mode) or ScheduleWakeup
 * (dynamic-pacing mode).
 *
 * Mode routing:
 *   /loop 5m <prompt>       → Fixed-interval (CronCreate, existing behavior)
 *   /loop <prompt> (no interval) → Dynamic-pacing (ScheduleWakeup)
 *   /loop (no interval, no prompt) → Autonomous-loop (ScheduleWakeup + default check)
 */

import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  SCHEDULE_WAKEUP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
} from '../../tools/definitions/base-declarations.js';
import type { BundledSkillRegistrar } from './index.js';
import { hasLoopMd } from './loop-md.js';
import { CONFIG_DIR } from '../../utils/paths.js';

/**
 * The slice of the activation context `/loop` needs.
 *
 * Declared per skill rather than shared, the way `simplify.ts` declares its own:
 * each body generator consumes a different part of what
 * `prepareSkillBody` hands it.
 *
 * `sessionId` is the correlation key for the `/loop` origin marker. A skill body
 * is not given a `Config`, so this is the only handle it has on which session it
 * is running in — and the marker has to be keyed, because a process can host
 * several sessions whose `/loop` and CronCreate calls interleave.
 */
interface LoopBodyContext {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL = '10m';

/**
 * Recurring tasks auto-expire after this many days (matches
 * DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24*60*60*1000)).
 */
const DEFAULT_MAX_AGE_DAYS = 7;

// Interval detection regex: a number followed by s/m/h/d
const INTERVAL_RE = /^\d+[smhd]$/;

// ---------------------------------------------------------------------------
// Usage message
// ---------------------------------------------------------------------------

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval, or let the agent
self-pace with dynamic timing.

## Modes

**Fixed-interval** (explicit interval):
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop check the deploy every 20m

**Dynamic-pacing** (no interval — agent decides timing):
  /loop monitor CI pipeline
  /loop watch PR #123 for review

In dynamic mode the agent uses ${SCHEDULE_WAKEUP_TOOL_NAME} to decide when to
wake up next (60s–3600s). Omitting the tool call ends the loop.

## Intervals (fixed mode)

Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If an explicit interval is provided, defaults to fixed-interval mode.

## Examples

  /loop 5m /babysit-prs         (fixed: every 5 min)
  /loop 1h /standup 1           (fixed: every 1 hour)
  /loop check the deploy        (dynamic: agent picks timing)
  /loop monitor CI pipeline     (dynamic: agent picks timing)
  /loop check deploy every 20m  (fixed: every 20 min)`;

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

type LoopMode = 'fixed' | 'dynamic';

interface ParsedLoopArgs {
  mode: LoopMode;
  /** For fixed mode: the interval string (e.g. "5m"). For dynamic: undefined. */
  interval?: string;
  /** The user's prompt text (after stripping interval/flags). */
  prompt: string;
  /** Whether task should be persisted to disk. */
  durable: boolean;
  /** Custom expiry in days. undefined = permanent (no expiry) when durable, 7d default when not durable. */
  durableDays?: number;
  /** Stop after this many fires. */
  maxTurns?: number;
  /** Stop once this many credits have been spent in total. */
  maxCredits?: number;
}

/**
 * Parse /loop arguments to determine the mode and extract interval+prompt.
 *
 * Priority:
 * 1. Leading token matches interval pattern → fixed mode
 * 2. Trailing "every <N><unit>" clause → fixed mode
 * 3. Otherwise → dynamic-pacing mode
 */
function parseLoopArgs(raw: string): ParsedLoopArgs {
  let input = raw;
  let durable = false;
  let durableDays: number | undefined;

  // Strip --durable [Nd] flag if present
  // Patterns: --durable, --durable 30d, --durable 7d
  const durableMatch = input.match(/(?:^|\s)--durable(?:\s+(\d+)d)?(?:\s|$)/);
  if (durableMatch) {
    durable = true;
    if (durableMatch[1]) {
      durableDays = parseInt(durableMatch[1], 10);
    }
    // Remove the matched --durable [Nd] from input. Global, so a repeated flag
    // cannot leave a copy behind for the interval parser to trip over.
    input = input.replace(/\s*--durable(?:\s+\d+d)?\s*/g, ' ').trim();
  }

  // Legacy: --permanent implies durable + no expiry
  if (/(?:^|\s)--permanent(?:\s|$)/.test(input) || /(?:^|\s)-p(?:\s|$)/.test(input)) {
    durable = true;
    // durableDays remains undefined = permanent
    input = input.replace(/\s*--permanent\s*/g, ' ').replace(/\s*-p\s*/g, ' ').trim();
  }

  // Ceilings. Stripped before the interval is parsed, or "--max-turns 5" would
  // leave a bare 5 behind for the interval parser to misread as a cadence.
  // Fractional credits are allowed — a turn often costs less than one — while
  // turns are whole by nature.
  //
  // Stripping is global. A repeated flag used to leave the second copy in the
  // input, and since "--max-turns" is not an interval the whole line then fell
  // through to dynamic mode carrying flag text inside the prompt. First value
  // wins, which matches how the other flags here behave.
  let maxTurns: number | undefined;
  const turnsMatch = input.match(/(?:^|\s)--max-turns(?:\s+|=)(\d+)(?:\s|$)/);
  if (turnsMatch) {
    maxTurns = parseInt(turnsMatch[1]!, 10);
    input = input.replace(/\s*--max-turns(?:\s+|=)\d+\s*/g, ' ').trim();
  }

  let maxCredits: number | undefined;
  const creditsMatch = input.match(
    /(?:^|\s)--max-credits(?:\s+|=)(\d+(?:\.\d+)?)(?:\s|$)/,
  );
  if (creditsMatch) {
    maxCredits = parseFloat(creditsMatch[1]!);
    input = input
      .replace(/\s*--max-credits(?:\s+|=)\d+(?:\.\d+)?\s*/g, ' ')
      .trim();
  }

  const tokens = input.split(/\s+/);

  // Rule 1: Leading token is an interval
  if (tokens[0] && INTERVAL_RE.test(tokens[0])) {
    return {
      mode: 'fixed',
      interval: tokens[0],
      prompt: tokens.slice(1).join(' '),
      durable,
      durableDays,
      maxTurns,
      maxCredits,
    };
  }

  // Rule 2: Trailing "every <N><unit>" or "every <N> <unit-word>"
  const trailingMatch = input.match(
    /\s+every\s+(\d+)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)\s*$/i,
  );
  if (trailingMatch) {
    const n = trailingMatch[1];
    let unit = trailingMatch[2].toLowerCase();
    // Normalize unit words to single char
    if (unit.startsWith('second')) unit = 's';
    else if (unit.startsWith('minute')) unit = 'm';
    else if (unit.startsWith('hour')) unit = 'h';
    else if (unit.startsWith('day')) unit = 'd';
    const interval = `${n}${unit}`;
    const prompt = input.slice(0, trailingMatch.index).trim();
    return { mode: 'fixed', interval, prompt, durable, durableDays, maxTurns, maxCredits };
  }

  // Rule 3: No interval detected → dynamic-pacing mode
  // (DEFAULT_INTERVAL only applies if user explicitly wanted fixed mode
  //  but forgot the interval — handled by the usage message)
  void DEFAULT_INTERVAL;
  return { mode: 'dynamic', prompt: input, durable, durableDays, maxTurns, maxCredits };
}

// ---------------------------------------------------------------------------
// Fixed-interval prompt (existing CronCreate flow)
// ---------------------------------------------------------------------------

/**
 * The ceiling parameters, as instructions rather than values.
 *
 * The flags are parsed here but applied by the model's tool call, so the prompt
 * has to name the parameters it must pass. A ceiling the user typed and the model
 * then dropped is worse than no flag at all.
 */
function budgetNotes(maxTurns?: number, maxCredits?: number): string {
  let notes = '';
  if (maxTurns !== undefined) {
    notes += `\n   - \`maxTurns\`: \`${maxTurns}\` (stop after ${maxTurns} fires — the user asked for this, do not omit it)`;
  }
  if (maxCredits !== undefined) {
    notes += `\n   - \`maxCredits\`: \`${maxCredits}\` (stop once ${maxCredits} credits have been spent — the user asked for this, do not omit it)`;
  }
  return notes;
}

function buildFixedPrompt(interval: string, prompt: string, _hasLoopMdFile: boolean, durable: boolean, durableDays?: number, maxTurns?: number, maxCredits?: number): string {
  // Note: loop.md sentinel is NOT injected here. If the user provides their own
  // prompt, it should be used verbatim. loop.md injection only applies when
  // /loop is called without any prompt (handled by buildLoopMdPrompt).

  // Build durable/permanent CronCreate parameters
  let durableNotes = '';
  if (durable) {
    durableNotes += '\n   - `durable`: `true` (persist to disk, survives restarts)';
    if (durableDays === undefined) {
      // No expiry specified = permanent
      durableNotes += '\n   - `permanent`: `true` (no auto-expiry)';
    } else {
      // Custom expiry in days — passed through to CronCreate's expiresDays
      durableNotes += `\n   - \`expiresDays\`: \`${durableDays}\` (auto-expires ${durableDays} days from now)`;
    }
  }
  durableNotes += budgetNotes(maxTurns, maxCredits);
  return `# /loop — schedule a recurring prompt (fixed-interval mode)

Parse the input below into \`[interval] <prompt…>\` and schedule it with ${CRON_CREATE_TOOL_NAME}.

## Interval → cron

The interval is: \`${interval}\`
The prompt is: \`${prompt}\`

Supported suffixes: \`s\` (seconds, rounded up to nearest minute, min 1), \`m\` (minutes), \`h\` (hours), \`d\` (days). Convert:

| Interval pattern      | Cron expression     | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\` where N ≤ 59   | \`*/N * * * *\`     | every N minutes                          |
| \`Nm\` where N ≥ 60   | \`0 */H * * *\`     | round to hours (H = N/60, must divide 24)|
| \`Nh\` where N ≤ 23   | \`0 */N * * *\`     | every N hours                            |
| \`Nd\`                | \`0 0 */N * *\`     | every N days at midnight local           |
| \`Ns\`                | treat as \`ceil(N/60)m\` | cron minimum granularity is 1 minute  |

**If the interval doesn't cleanly divide its unit** (e.g. \`7m\` → \`*/7 * * * *\` gives uneven gaps at :56→:00; \`90m\` → 1.5h which cron can't express), pick the nearest clean interval and **MUST tell the user what you rounded to before calling ${CRON_CREATE_TOOL_NAME}**. For seconds input specifically, **MUST inform the user** that their \`Ns\` interval was rounded up to \`ceil(N/60)\` minutes — the minimum granularity.

## Action

1. Call ${CRON_CREATE_TOOL_NAME} with:
   - \`cron\`: the expression from the table above
   - \`prompt\`: \`${prompt}\` (verbatim; slash commands are passed through unchanged)
   - \`recurring\`: \`true\`${durableNotes}
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, ${durable ? 'that it\'s persisted to disk' : 'that it\'s session-only (dies when process exits)'}${durableDays ? `, expires in ${durableDays} days` : durable ? ', permanent (no expiry)' : `, auto-expires after ${DEFAULT_MAX_AGE_DAYS} days`}, and that they can cancel sooner with ${CRON_DELETE_TOOL_NAME} (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.`;
}

// ---------------------------------------------------------------------------
// Dynamic-pacing prompt (ScheduleWakeup flow)
// ---------------------------------------------------------------------------

function buildDynamicPrompt(prompt: string, _hasLoopMdFile: boolean, maxTurns?: number, maxCredits?: number): string {
  // No sentinel injection when user provides their own prompt.
  // loop.md sentinel is only used in buildLoopMdPrompt() (no-args case).
  return `# /loop — dynamic-pacing mode

You are entering a self-paced loop. You will execute the task, then decide when to check again using ${SCHEDULE_WAKEUP_TOOL_NAME}.

## Your task

${prompt}

## Dynamic-pacing rules

Decide what makes the next iteration worth running — a passage of time, or an observable event.

1. **Run the task now**, following the instructions above.
2. **If the next run is gated on an event** (CI finishing, a log line matching, a file changing, a PR comment) and no ${MONITOR_TOOL_NAME} is already running for it: arm one now with \`persistent: true\`. Its events arrive as \`<task-notification>\` messages and wake this loop immediately — you do not wait for the ${SCHEDULE_WAKEUP_TOOL_NAME} deadline. Arm once; on later iterations call ${TASK_LIST_TOOL_NAME} first and skip this step if a monitor is already running.
3. **Briefly confirm**: that you're self-pacing, whether a ${MONITOR_TOOL_NAME} is the primary wake signal, that you ran the task now, and what fallback delay you're about to pick. Write this as text *before* calling ${SCHEDULE_WAKEUP_TOOL_NAME} — the turn ends as soon as that tool returns.
4. **Then, as the last action of this turn, decide whether the loop continues.** If the task needs another iteration, call ${SCHEDULE_WAKEUP_TOOL_NAME} with:
   - \`delaySeconds\`: with a ${MONITOR_TOOL_NAME} armed this is the **fallback heartbeat** — how long to wait if no event fires (lean 1200–1800s; idle ticks more frequent than the task needs are pure overhead). Without a ${MONITOR_TOOL_NAME} this is the cadence — pick based on what you observed. Read the tool's own description for cache-aware delay guidance.
   - \`reason\`: one short sentence on why you picked that delay.
   - \`prompt\`: the literal text \`${prompt}\` — pass it verbatim so the next firing re-enters this skill and continues the loop.${budgetNotes(maxTurns, maxCredits)}
   If it doesn't need another iteration, stop instead (step 6) — re-arming is a per-turn choice, not a default.
5. **If you were woken by a \`<task-notification>\`** rather than this prompt: handle the event in the context of the loop task, then make the same decision. If the loop should continue, call ${SCHEDULE_WAKEUP_TOOL_NAME} again with the same \`prompt\` and the same 1200–1800s \`delaySeconds\` from step 4 (the ${MONITOR_TOOL_NAME} remains the wake signal; the new wakeup is only the fallback heartbeat). If the event means the work is finished, stop (step 6).
6. **To stop the loop** — the task is complete, further iterations can't make progress, or the user asked you to stop — call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\` (no other fields) and ${TASK_STOP_TOOL_NAME} any ${MONITOR_TOOL_NAME} you armed (use ${TASK_LIST_TOOL_NAME} to find the task ID if it is no longer in context). Also ${CRON_DELETE_TOOL_NAME} any ${CRON_CREATE_TOOL_NAME} you armed (${CRON_LIST_TOOL_NAME} to find it). Stopping is the loop's normal ending — the user can restart it anytime with /loop.

## Two wake channels

- **${MONITOR_TOOL_NAME}** = event-driven ("wake me when something happens")
- **${SCHEDULE_WAKEUP_TOOL_NAME}** = time-driven fallback heartbeat ("check in N seconds regardless")
- Use both together: the Monitor reacts instantly; the wakeup prevents hanging forever if the event never fires.

## Important

- Calling ${SCHEDULE_WAKEUP_TOOL_NAME} = "I want to continue monitoring"
- Calling ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\` = "I'm done, end the loop"
- The delay is clamped to [60, 3600] seconds by the runtime`;
}

// ---------------------------------------------------------------------------
// loop.md default prompt (auto-start when loop.md exists in the config dir)
// ---------------------------------------------------------------------------

function buildLoopMdPrompt(): string {
  return `# /loop — loop.md task list mode (dynamic-pacing)

The user has a \`${CONFIG_DIR}/loop.md\` file defining their loop task list. You are entering a self-paced loop driven by that file.

## Action

1. **Run the loop.md tasks now** — the sentinel \`<<loop.md-dynamic>>\` in the wakeup prompt will expand to the full file content at fire time.
2. **After completing the tasks**, briefly confirm what you did.
3. **Call ${SCHEDULE_WAKEUP_TOOL_NAME}** with:
   - \`delaySeconds\`: pick a sensible cadence based on the task nature — stay under 270s only if the tasks genuinely need that frequency, otherwise go 1200s+ (the context cache expires at 5 minutes, so the 300–1200s band pays a cache miss without earning it).
   - \`reason\`: one sentence explaining your timing choice.
   - \`prompt\`: the literal sentinel \`<<loop.md-dynamic>>\`
4. **To stop the loop**, call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\` (no other fields).

## Important

- The \`${CONFIG_DIR}/loop.md\` content will be injected automatically on the first fire and whenever the file changes.
- On subsequent unchanged fires, you'll get a reminder to continue the tasks from your cached context.
- Calling ${SCHEDULE_WAKEUP_TOOL_NAME} = continue; NOT calling = stop.`;
}

// ---------------------------------------------------------------------------
// Autonomous-loop prompt (no user prompt, no loop.md)
// ---------------------------------------------------------------------------

function buildAutonomousPrompt(): string {
  return `# /loop — autonomous-loop mode (dynamic-pacing)

You are entering an autonomous self-paced loop with no specific user task. Perform a general project health check and maintenance cycle.

## Autonomous-loop instructions (for the immediate execution and every fire)

1. Check for any pending issues, failing tests, stale PRs, or deployment problems.
2. Report findings briefly.
3. Self-pace the next iteration via ${SCHEDULE_WAKEUP_TOOL_NAME}.

## Dynamic-pacing rules

1. **Run the autonomous check now**.
2. **Briefly confirm**: that this is the autonomous default in dynamic-pacing mode, that you ran the check now, and what fallback delay you're about to pick.
3. **Call ${SCHEDULE_WAKEUP_TOOL_NAME}** with:
   - \`delaySeconds\`: 1800 (30 minutes) as a default autonomous cadence — idle checks rarely justify a tighter loop, and the context cache is already cold past 5 minutes.
   - \`reason\`: explain what you found and why this delay is appropriate.
   - \`prompt\`: the literal sentinel \`<<autonomous-loop-dynamic>>\`
4. **To stop the loop**, call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\` (no other fields).`;
}

// ---------------------------------------------------------------------------
// Skill registration
// ---------------------------------------------------------------------------

export function registerLoopSkill(registrar: BundledSkillRegistrar): void {
  registrar.registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt or slash command on a recurring interval (fixed mode) or with dynamic self-pacing (no interval). Examples: /loop 5m /foo, /loop monitor CI',
    location: 'bundled',
    body: '',
    userInvocable: true,
    whenToUse:
      'When the user wants to set up a recurring task, poll for status, monitor something, or run something repeatedly. Supports fixed intervals (e.g. "every 5 minutes") and dynamic self-pacing (agent decides timing). Do NOT invoke for one-off tasks.',
    argumentHint: '[interval] <prompt>',
    async getBody(args, _context?: LoopBodyContext) {
      const trimmed = (args ?? '').trim();

      // No args: if loop.md exists, use it as default task list
      if (!trimmed) {
        const loopMd = await hasLoopMd();
        if (loopMd) {
          return buildLoopMdPrompt();
        }
        return USAGE_MESSAGE;
      }

      const parsed = parseLoopArgs(trimmed);

      // Check if loop.md exists to determine sentinel type
      const loopMdExists = await hasLoopMd();

      if (parsed.mode === 'fixed') {
        if (!parsed.prompt.trim()) {
          return USAGE_MESSAGE;
        }
        return buildFixedPrompt(parsed.interval!, parsed.prompt, loopMdExists, parsed.durable, parsed.durableDays, parsed.maxTurns, parsed.maxCredits);
      }

      // Dynamic-pacing mode
      if (!parsed.prompt.trim()) {
        // No prompt = autonomous loop
        return buildAutonomousPrompt();
      }
      return buildDynamicPrompt(parsed.prompt, loopMdExists, parsed.maxTurns, parsed.maxCredits);
    },
  });
}
