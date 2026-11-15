/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derives the Managed `/loop` skill (description + body) from the bundled local
 * SKILL.md. The Managed variant differs from the local skill in three ways:
 *  - wording: a Managed schedule is always durable, runs until cancelled (no
 *    7-day expiry), defaults to UTC, and reads only the user-owned home
 *    `~/.qwen/loop.md` (the workspace project copy is never read);
 *  - surface: it describes only the creators the Session's tool profile
 *    declares, so it never steers the model toward a refused tool;
 *  - fire mechanics: a Managed cron fire does NOT expand loop sentinels, so the
 *    cron path teaches natural-language prompts the model executes each fire
 *    (reading the home file itself); only the self-paced wakeup path uses the
 *    sentinels the wakeup fire expands.
 *
 * Shared prose is derived from the bundled source through substitutions that
 * throw when the source sentence is missing, so a drift in SKILL.md reddens the
 * parity test rather than silently stale-ing the managed bodies. Java reads the
 * committed JSON sidecar (description + body) for the Session's profile and does
 * no string composition.
 *
 * See docs/design/2026-11-14-managed-loop-skill-asset.md.
 */

/** The creator surface a Managed profile declares. */
export type ManagedLoopProfile = 'union' | 'cron' | 'wakeup';

export interface ManagedLoopSkill {
  description: string;
  body: string;
}

/** A source→managed substitution; throws if the source sentence is absent. */
function sub(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(
      `Managed loop substitution source not found in bundled SKILL.md: ${from.slice(0, 70)}…`,
    );
  }
  return text.split(from).join(to);
}

const SELF_PACED = 'Prompt-only self-paced path';
const FIXED_INTERVAL = 'Fixed-interval recurring path';
const LOOP_MD = 'loop.md task-file mode';
const AUTONOMOUS = 'Autonomous mode';

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

/** Managed wording applied to the fixed-interval Action section (from source). */
function managedFixedInterval(section: string): string {
  let out = sub(
    section,
    '`durable`: `true` if the user\'s language implies persistence ("keep doing this", "set this up permanently", "every day even after restart"). Otherwise omit (defaults to session-only).',
    '`durable`: `true` (a Managed schedule is always durable; `durable: false` is refused).',
  );
  out = sub(
    out,
    'the auto-expiry (7 days after creation by default — the CronCreate tool description states the configured limit, which may differ or be disabled), and that they can cancel sooner with CronDelete (include the job ID).',
    'that it runs until cancelled (a Managed schedule does not expire), and that they can cancel with CronDelete (include the job ID).',
  );
  // Managed cron_create defaults the timezone to UTC; "midnight local" is wrong
  // unless the model passes the user's IANA zone.
  out = sub(
    out,
    '| `Nd`               | `0 0 */N * *`          | every N days at midnight local            |',
    "| `Nd`               | `0 0 */N * *`          | every N days at midnight UTC (pass the user's IANA `timezone` for local midnight) |",
  );
  return out;
}

/** The home-only loop.md intro paragraph (just the intro, not the bullets). */
function managedLoopMdIntro(section: string): string {
  const afterHeader = section.replace(/^## loop\.md task-file mode\n\n/, '');
  const introEnd = afterHeader.indexOf('\n\n');
  const intro = introEnd < 0 ? afterHeader : afterHeader.slice(0, introEnd);
  return sub(
    intro,
    "Tasks live in `.qwen/loop.md` (project) or `~/.qwen/loop.md` (home; project wins). Instead of a natural-language prompt, set the loop's `prompt` to a sentinel so each fire re-reads the file:",
    'Tasks live in `~/.qwen/loop.md` (the user-owned home file; the workspace project copy is not read on Managed).',
  );
}

/** The shared "At each fire" prose, derived from the source loop.md section. */
function loopMdFireProse(section: string): string {
  const marker = 'At each fire you receive';
  const idx = section.indexOf(marker);
  if (idx < 0) {
    throw new Error(
      'Bundled loop.md section is missing the "At each fire" prose.',
    );
  }
  return section.slice(idx).trimEnd();
}

/** The shared steward prose, derived from the source Autonomous section. */
function stewardProse(section: string): string {
  const marker =
    'The first immediate check, and each scheduled fire, advance work';
  const idx = section.indexOf(marker);
  if (idx < 0) {
    throw new Error('Bundled Autonomous section is missing the steward prose.');
  }
  // Drop the trailing self-paced re-arm sentence; each profile appends its own.
  const prose = section.slice(idx);
  const cut = prose.indexOf(' In self-paced mode re-arm');
  return (cut < 0 ? prose : prose.slice(0, cut)).trimEnd();
}

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
- \`5m\` → fixed-interval autonomous loop (interval \`5m\`)
`;

/** Union Parsing: both paths, but the cron path uses no sentinel (cron fires do
 * not expand them); derived from the source examples with the cron sentinel
 * example adapted to a natural-language prompt. */
const UNION_PARSING = `## Parsing

Parse the input after removing the \`/loop\` prefix:

1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.
2. **Leading interval token**: if the first whitespace-delimited token matches \`^\\d+[smhd]$\` (e.g. \`5m\`, \`2h\`), this is the fixed-interval recurring path. The rest is the prompt.
3. **Trailing "every" clause**: otherwise, if the input ends with \`every <N><unit>\` or \`every <N> <unit-word>\` (e.g. \`every 20m\`, \`every 5 minutes\`, \`every 2 hours\`), this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — \`check every PR\` has no interval.
4. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.

If an interval was given but the prompt is empty (e.g. \`/loop 5m\`), this is a fixed-interval **autonomous** loop — see the Autonomous mode section.

Examples:

- \`5m /babysit-prs\` → fixed interval \`5m\`, prompt \`/babysit-prs\` (leading interval token)
- \`check the deploy every 20m\` → fixed interval \`20m\`, prompt \`check the deploy\` (trailing "every" clause)
- \`run tests every 5 minutes\` → fixed interval \`5m\`, prompt \`run tests\` (trailing "every" clause)
- \`check every PR\` → prompt-only self-paced path, prompt \`check every PR\` ("every" is not followed by a time expression)
- \`check the deploy\` → prompt-only self-paced path, prompt \`check the deploy\`
- (empty) → self-paced autonomous loop (sentinel \`<<autonomous-loop-dynamic>>\`)
- \`5m\` → fixed-interval autonomous loop (interval \`5m\`, natural-language steward prompt)
`;

/** Cron-only loop.md fire prose: no wakeup creator or sentinel. */
const CRON_FIRE_PROSE =
  'At each fire you receive the instruction to read `~/.qwen/loop.md` and work through its tasks. Read the file yourself each fire and work the tasks; if the file changed since the last fire, work the updated list.';

const WAKEUP_PARSING = `## Parsing

Parse the input after removing the \`/loop\` prefix:

1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.
2. **Interval requested**: if the first token matches \`^\\d+[smhd]$\` or the input ends with \`every <N><unit>\`, strip the interval token (or trailing "every" clause) and run the remainder as the prompt now with a self-paced wakeup; tell the user this Session schedules self-paced follow-ups only, not a fixed cron schedule.
3. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.

Examples:

- \`5m /babysit-prs\` → self-paced, prompt \`/babysit-prs\` (interval stripped; self-paced follow-ups only)
- \`check the deploy every 20m\` → self-paced, prompt \`check the deploy\` (interval stripped)
- \`check every PR\` → prompt-only self-paced path, prompt \`check every PR\`
- \`check the deploy\` → prompt-only self-paced path, prompt \`check the deploy\`
- (empty) → self-paced autonomous loop (sentinel \`<<autonomous-loop-dynamic>>\`)
`;

/**
 * Build the Managed loop skill (description + body) for a profile from the
 * bundled local body (SKILL.md after its frontmatter) and frontmatter
 * description. The body never names a creator the profile lacks, never teaches
 * a cron sentinel (cron fires do not expand them), and never claims the
 * workspace project loop.md file.
 */
export function buildManagedLoopSkill(
  profile: ManagedLoopProfile,
  bundledBody: string,
  frontmatterDescription: string,
): ManagedLoopSkill {
  const { preamble, sections } = splitSections(bundledBody);
  const get = (name: string): string => {
    const found = sections.get(name);
    if (found === undefined) {
      throw new Error(`Bundled loop body is missing section: ${name}`);
    }
    return found;
  };

  const loopMdSource = get(LOOP_MD);
  const autonomousSource = get(AUTONOMOUS);
  // The source fire prose names the workspace project path; Managed reads only
  // the user-owned home file, so adapt every project reference to the home path.
  const fireProse = sub(
    loopMdFireProse(loopMdSource),
    '`.qwen/loop.md`',
    '`~/.qwen/loop.md`',
  );
  const steward = stewardProse(autonomousSource);
  const homeIntro = managedLoopMdIntro(loopMdSource);

  const parts: string[] = [preamble, get('Subcommands')];
  let description: string;

  if (profile === 'cron') {
    description =
      'Create a loop that runs a prompt now and follows up on a fixed schedule. Usage - /loop 5m check the build, /loop check the PR every 30m. /loop list to show jobs, /loop clear to cancel all.';
    parts.push(CRON_PARSING);
    parts.push(managedFixedInterval(get(FIXED_INTERVAL)));
    // Cron fires do not expand sentinels: teach a natural-language prompt the
    // model executes each fire, reading the home file itself.
    parts.push(
      `## ${LOOP_MD}\n\n${homeIntro}\n\n` +
        '- Fixed interval → CronCreate `prompt`: a natural-language instruction to read `~/.qwen/loop.md` and work through its tasks (with `recurring: true` and `durable: true`). Each fire delivers that instruction and you re-read the file yourself.\n\n' +
        `${CRON_FIRE_PROSE} If \`~/.qwen/loop.md\` is absent at fire time, keep working autonomously instead of no-op'ing; a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your \`~/.qwen/loop.md\` task list…").`,
    );
    parts.push(
      `## ${AUTONOMOUS}\n\nUse this for a bare \`/loop <interval>\` (an interval, no prompt, no file) — the user wants you to keep their work moving while they're away.\n\n` +
        '- Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: a natural-language steward instruction (with `recurring: true` and `durable: true`) telling you to advance the work this conversation already established. Each fire delivers that instruction.\n\n' +
        `${steward} Confirm to the user in plain language ("running an autonomous loop on your work…").`,
    );
  } else if (profile === 'wakeup') {
    description =
      'Create a loop that runs a prompt now and follows up through self-paced wakeups. Usage - /loop check the deploy. /loop list to show jobs, /loop clear to cancel all.';
    parts.push(WAKEUP_PARSING);
    const selfPaced = sub(
      get(SELF_PACED),
      '1. Do not call CronCreate for this path.',
      '1. This path follows up through self-paced wakeups only.',
    );
    parts.push(selfPaced);
    parts.push(
      `## ${LOOP_MD}\n\n${homeIntro} Set the loop's \`prompt\` to a sentinel so each wakeup re-reads the file:\n\n` +
        '- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`\n\n' +
        `${fireProse} If \`~/.qwen/loop.md\` is absent at fire time, the loop falls back to autonomous mode; a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your \`~/.qwen/loop.md\` task list…"), not the raw sentinel.`,
    );
    parts.push(
      `## ${AUTONOMOUS}\n\nUse this for a bare \`/loop\` (no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:\n\n` +
        '- Self-paced (empty input) → LoopWakeup `prompt`: `<<autonomous-loop-dynamic>>`\n\n' +
        `${steward} In self-paced mode re-arm LoopWakeup with \`<<autonomous-loop-dynamic>>\` (same "don't re-arm if complete/blocked" rules). Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.`,
    );
  } else {
    description = frontmatterDescription;
    parts.push(UNION_PARSING);
    parts.push(get(SELF_PACED));
    parts.push(managedFixedInterval(get(FIXED_INTERVAL)));
    // Union: the cron half uses natural-language prompts (cron fires do not
    // expand sentinels); the self-paced half uses the sentinels wakeups expand.
    parts.push(
      `## ${LOOP_MD}\n\n${homeIntro}\n\n` +
        '- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`\n' +
        '- Fixed interval → CronCreate `prompt`: a natural-language instruction to read `~/.qwen/loop.md` and work through its tasks (with `recurring: true` and `durable: true`). Cron fires do not expand sentinels, so each fire delivers that instruction and you re-read the file yourself.\n\n' +
        `${fireProse} If \`~/.qwen/loop.md\` is absent at fire time, the loop falls back to autonomous mode; a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your \`~/.qwen/loop.md\` task list…").`,
    );
    parts.push(
      `## ${AUTONOMOUS}\n\nUse this for a bare \`/loop\` (no prompt, no file) — the user wants you to keep their work moving while they're away. Run the first check now:\n\n` +
        '- Self-paced (empty input) → LoopWakeup `prompt`: `<<autonomous-loop-dynamic>>`\n' +
        '- Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: a natural-language steward instruction (with `recurring: true` and `durable: true`). Cron fires do not expand sentinels, so each fire delivers that instruction.\n\n' +
        `${steward} In self-paced mode re-arm LoopWakeup with \`<<autonomous-loop-dynamic>>\` (same "don't re-arm if complete/blocked" rules). Confirm to the user in plain language ("running an autonomous loop on your work…").`,
    );
  }
  if (sections.has('Input')) parts.push(get('Input'));

  const body = parts.join('\n').replace(/^\n+/, '');
  const absent =
    profile === 'cron' ? /loop_wakeup|LoopWakeup/ : /cron_create|CronCreate/;
  if (profile !== 'union' && absent.test(body)) {
    throw new Error(
      `Managed ${profile} loop body names a creator the profile lacks.`,
    );
  }
  if (body.includes('.qwen/loop.md` (project)')) {
    throw new Error(
      'Managed loop body still claims the workspace project file.',
    );
  }
  if (profile !== 'wakeup' && /<<loop\.md>>|<<autonomous-loop>>/.test(body)) {
    throw new Error(
      'Managed cron path still teaches a non-expanding sentinel.',
    );
  }
  return { description, body };
}
