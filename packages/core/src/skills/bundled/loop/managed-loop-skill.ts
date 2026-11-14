/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derives the Managed `/loop` skill body from the bundled local SKILL.md.
 *
 * The Managed variant differs from the local skill in two ways:
 *  - wording: a Managed schedule is always durable and runs until cancelled
 *    (no 7-day auto-expiry, no session-only default);
 *  - surface: it describes only the creators the Session's tool profile
 *    declares, so it never steers the model toward a refused tool.
 *
 * The composition lives here (not in Java string surgery) because the two
 * paths interleave throughout the body. Java selects the committed asset for
 * the Session's profile; a collocated parity test pins each asset to this
 * generator and the generator to the bundled source.
 *
 * See docs/design/2026-11-14-managed-loop-skill-asset.md.
 */

/** The creator surface a Managed profile declares. */
export type ManagedLoopProfile = 'union' | 'cron' | 'wakeup';

/**
 * Managed wording substitutions applied to the fixed-interval path. Each pair
 * is [local sentence, managed sentence]; the local sentence must appear verbatim
 * in the bundled body so a drift in the source reddens the parity test.
 */
const WORDING_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  [
    '`durable`: `true` if the user\'s language implies persistence ("keep doing this", "set this up permanently", "every day even after restart"). Otherwise omit (defaults to session-only).',
    '`durable`: `true` (a Managed schedule is always durable; `durable: false` is refused).',
  ],
  [
    'the auto-expiry (7 days after creation by default — the CronCreate tool description states the configured limit, which may differ or be disabled), and that they can cancel sooner with CronDelete (include the job ID).',
    'that it runs until cancelled (a Managed schedule does not expire), and that they can cancel with CronDelete (include the job ID).',
  ],
  [
    'Fixed interval → CronCreate `prompt`: `<<loop.md>>` (with `recurring: true`, and `durable: true` if persistence is implied)',
    'Fixed interval → CronCreate `prompt`: `<<loop.md>>` (with `recurring: true` and `durable: true`)',
  ],
  [
    'Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: `<<autonomous-loop>>` (with `recurring: true`, and `durable: true` if persistence is implied)',
    'Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: `<<autonomous-loop>>` (with `recurring: true` and `durable: true`)',
  ],
];

function applyWording(body: string): string {
  let out = body;
  for (const [local, managed] of WORDING_SUBSTITUTIONS) {
    if (!out.includes(local)) {
      throw new Error(
        `Managed loop wording substitution source not found in bundled body: ${local.slice(0, 60)}…`,
      );
    }
    out = out.split(local).join(managed);
  }
  return out;
}

/** Split a markdown body into its top-level (## ) sections, keeping the preamble. */
function splitSections(body: string): {
  preamble: string;
  sections: Map<string, string>;
} {
  const lines = body.split('\n');
  const preamble: string[] = [];
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n'));
  };
  for (const line of lines) {
    const header = /^## (.+)$/.exec(line);
    if (header) {
      flush();
      current = header[1];
      buffer = [line];
    } else if (current === null) {
      preamble.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return { preamble: preamble.join('\n'), sections };
}

const SELF_PACED = 'Prompt-only self-paced path';
const FIXED_INTERVAL = 'Fixed-interval recurring path';

/** Cron-only Parsing: no self-paced route; empty input is unsupported. */
const CRON_PARSING = `## Parsing

Parse the input after removing the \`/loop\` prefix:

1. **Leading interval token**: if the first whitespace-delimited token matches \`^\\d+[smhd]$\` (e.g. \`5m\`, \`2h\`), this is the fixed-interval recurring path. The rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with \`every <N><unit>\` or \`every <N> <unit-word>\` (e.g. \`every 20m\`, \`every 5 minutes\`, \`every 2 hours\`), this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — \`check every PR\` has no interval.
3. **No interval**: a Managed schedule on this Session requires a fixed interval. If the input has no interval, tell the user this Session schedules fixed-interval loops only and ask for an interval (for example \`/loop 5m check the build\`); do not schedule.

If an interval was given but the prompt is empty (e.g. \`/loop 5m\`), this is a fixed-interval **autonomous** loop — see the Autonomous mode section.

Examples:

- \`5m /babysit-prs\` → fixed interval \`5m\`, prompt \`/babysit-prs\` (leading interval token)
- \`check the deploy every 20m\` → fixed interval \`20m\`, prompt \`check the deploy\` (trailing "every" clause)
- \`run tests every 5 minutes\` → fixed interval \`5m\`, prompt \`run tests\` (trailing "every" clause)
- \`check every PR\` → no interval; ask for one ("every" is not followed by a time expression)
- \`5m\` → fixed-interval autonomous loop (interval \`5m\`, sentinel \`<<autonomous-loop>>\`)
`;

/** Wakeup-only Parsing: no fixed-interval route. */
const WAKEUP_PARSING = `## Parsing

Parse the input after removing the \`/loop\` prefix:

1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.
2. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.

A Managed Session on this profile follows up through self-paced wakeups, not a fixed cron schedule. If the user asks for a fixed interval (for example \`/loop 5m …\` or \`… every 20m\`), tell them this Session schedules self-paced follow-ups only and run the prompt now with a self-paced wakeup; do not attempt a cron schedule.

Examples:

- \`check every PR\` → prompt-only self-paced path, prompt \`check every PR\`
- \`check the deploy\` → prompt-only self-paced path, prompt \`check the deploy\`
- (empty) → self-paced autonomous loop (sentinel \`<<autonomous-loop-dynamic>>\`)
`;

/** Cron-only loop.md mode: fixed-interval sentinel only. */
const CRON_LOOP_MD = `## loop.md task-file mode

Use this when the user wants the loop to work a task list kept in a file (they say "work through my loop.md", "loop over the tasks in .qwen/loop.md", or point at such a file). Tasks live in \`.qwen/loop.md\` (project) or \`~/.qwen/loop.md\` (home; project wins). Instead of a natural-language prompt, set the loop's \`prompt\` to a sentinel so each fire re-reads the file:

- Fixed interval → CronCreate \`prompt\`: \`<<loop.md>>\` (with \`recurring: true\` and \`durable: true\`)

At each fire you receive either the full task list (first delivery, after the file changes, or after a compaction) or a short reminder to keep working the list established earlier. Work the tasks. If \`.qwen/loop.md\` is absent at fire time, the loop falls back to autonomous mode (it keeps working autonomously instead of no-op'ing); a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your \`.qwen/loop.md\` task list…"), not the raw sentinel.
`;

/** Wakeup-only loop.md mode: self-paced sentinel only. */
const WAKEUP_LOOP_MD = `## loop.md task-file mode

Use this when the user wants the loop to work a task list kept in a file (they say "work through my loop.md", "loop over the tasks in .qwen/loop.md", or point at such a file). Tasks live in \`.qwen/loop.md\` (project) or \`~/.qwen/loop.md\` (home; project wins). Instead of a natural-language prompt, set the loop's \`prompt\` to a sentinel so each fire re-reads the file:

- Self-paced (no interval) → LoopWakeup \`prompt\`: \`<<loop.md-dynamic>>\`

At each fire you receive either the full task list (first delivery, after the file changes, or after a compaction) or a short reminder to keep working the list established earlier. Work the tasks; re-arm LoopWakeup with \`<<loop.md-dynamic>>\` only when continued follow-up is useful (same "don't re-arm if complete/blocked" rules as the prompt-only path). If \`.qwen/loop.md\` is absent at fire time, the loop falls back to autonomous mode (it keeps working autonomously instead of no-op'ing); a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your \`.qwen/loop.md\` task list…"), not the raw sentinel.
`;

/** Cron-only Autonomous mode: fixed-interval sentinel only. */
const CRON_AUTONOMOUS = `## Autonomous mode

Use this for a bare \`/loop <interval>\` (an interval, no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:

- Fixed interval (\`/loop <interval>\`, no prompt) → CronCreate \`prompt\`: \`<<autonomous-loop>>\` (with \`recurring: true\` and \`durable: true\`)

The first immediate check, and each scheduled fire, advance work the conversation already established — finish things the user started, maintain an in-progress PR (address review threads, fix failing CI, resolve conflicts), honor "I'll also…" commitments. You are a steward, not an initiator: act on what the transcript already established; never invent new work or make irreversible changes (push, delete, send) without clear authorization. If everything is genuinely quiet, say so in one sentence and stop. The first fire (and the first after a compaction) delivers fuller guidance; later fires send a short reminder pointing back to it. Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.
`;

/** Wakeup-only Autonomous mode: self-paced sentinel only. */
const WAKEUP_AUTONOMOUS = `## Autonomous mode

Use this for a bare \`/loop\` (no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:

- Self-paced (empty input) → LoopWakeup \`prompt\`: \`<<autonomous-loop-dynamic>>\`

The first immediate check, and each scheduled fire, advance work the conversation already established — finish things the user started, maintain an in-progress PR (address review threads, fix failing CI, resolve conflicts), honor "I'll also…" commitments. You are a steward, not an initiator: act on what the transcript already established; never invent new work or make irreversible changes (push, delete, send) without clear authorization. If everything is genuinely quiet, say so in one sentence and stop. The first fire (and the first after a compaction) delivers fuller guidance; later fires send a short reminder pointing back to it. Re-arm LoopWakeup with \`<<autonomous-loop-dynamic>>\` (same "don't re-arm if complete/blocked" rules). Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.
`;

/**
 * Build the Managed loop skill body for a profile from the bundled local body
 * (the SKILL.md content after its frontmatter). The union profile keeps every
 * section with Managed wording; cron-only drops the self-paced path; wakeup-only
 * drops the fixed-interval path. The returned body never names a creator the
 * profile lacks.
 */
export function buildManagedLoopBody(
  profile: ManagedLoopProfile,
  bundledBody: string,
): string {
  const substituted = applyWording(bundledBody);
  if (profile === 'union') {
    return substituted.replace(/^\n+/, '');
  }
  const { preamble, sections } = splitSections(substituted);
  const getSection = (name: string): string => {
    const found = sections.get(name);
    if (found === undefined) {
      throw new Error(`Bundled loop body is missing section: ${name}`);
    }
    return found;
  };
  const parts: string[] = [preamble];
  parts.push(getSection('Subcommands'));
  if (profile === 'cron') {
    parts.push(CRON_PARSING);
    parts.push(getSection(FIXED_INTERVAL));
    parts.push(CRON_LOOP_MD);
    parts.push(CRON_AUTONOMOUS);
  } else {
    parts.push(WAKEUP_PARSING);
    // The bundled self-paced path opens with "Do not call CronCreate for this
    // path."; a wakeup-only Session has no cron_create, so even that negative
    // mention must go — replace it with a creator-free statement.
    const selfPaced = getSection(SELF_PACED).replace(
      '1. Do not call CronCreate for this path.',
      '1. This path follows up through self-paced wakeups only.',
    );
    if (selfPaced.includes('CronCreate')) {
      throw new Error('Wakeup-only self-paced path still names CronCreate.');
    }
    parts.push(selfPaced);
    parts.push(WAKEUP_LOOP_MD);
    parts.push(WAKEUP_AUTONOMOUS);
  }
  if (sections.has('Input')) parts.push(getSection('Input'));
  const body = parts.join('\n');
  const absent =
    profile === 'cron' ? /loop_wakeup|LoopWakeup/ : /cron_create|CronCreate/;
  if (absent.test(body)) {
    throw new Error(
      `Managed ${profile} loop body names a creator the profile lacks.`,
    );
  }
  return body.replace(/^\n+/, '');
}
