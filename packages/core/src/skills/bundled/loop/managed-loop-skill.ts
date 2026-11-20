/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AUTONOMOUS_SENTINEL_DYNAMIC } from './autonomous-loop.js';
import { LOOP_SENTINEL_DYNAMIC } from './loop-tick-resolver.js';

/**
 * Derives the Managed `/loop` skill (description + body) from the bundled local
 * SKILL.md. The Managed variant differs from the local skill in three ways:
 *  - wording: a Managed schedule is always durable, runs until cancelled (no
 *    7-day expiry), defaults to UTC, and reads only the global
 *    `$QWEN_HOME/loop.md` the wakeup fire resolves (the workspace project copy
 *    is never read);
 *  - surface: it describes only the creators the Session's tool profile
 *    declares, so it never steers the model toward a refused tool;
 *  - fire mechanics: a Managed cron fire does NOT expand loop sentinels and the
 *    model cannot open the Harness-host home file, so the cron path teaches
 *    natural-language prompts and carries no loop.md task-file mode; only the
 *    self-paced wakeup path uses the sentinels the wakeup fire expands (and the
 *    loop.md file mode, which that fire resolves).
 *
 * Shared prose is derived from the bundled source through substitutions that
 * throw when the source sentence is missing, and every top-level section must be
 * classified, so a drift in SKILL.md reddens the parity test rather than silently
 * stale-ing the managed bodies. Java reads the committed JSON sidecar
 * (description + body) for the Session's profile and does no string composition.
 *
 * See docs/design/2026-11-14-managed-loop-skill-asset.md.
 */

/** The creator surfaces a Managed profile declares — the single source the
 * parity tests iterate, so an added or removed profile cannot drift across
 * hand-kept lists. */
export const MANAGED_LOOP_PROFILES = ['union', 'cron', 'wakeup'] as const;

/** The creator surface a Managed profile declares. */
export type ManagedLoopProfile = (typeof MANAGED_LOOP_PROFILES)[number];

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

// Every top-level section of the bundled SKILL.md must be classified here: a
// new or renamed section fails the generator until it is deliberately consumed
// or ignored, so shared guidance cannot silently drop out of the managed bodies.
const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  'Subcommands',
  'Parsing',
  SELF_PACED,
  FIXED_INTERVAL,
  LOOP_MD,
  AUTONOMOUS,
  'Input',
]);

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
  // unless the model passes the user's IANA zone. `0 0 */N * *` is a
  // day-of-month step (days 1, 1+N, … resetting at each month start), not a
  // rolling N-day cadence — the source table and its caveat say so, and the
  // managed wording keeps that accurate.
  out = sub(
    out,
    '| `Nd`               | `0 0 */N * *`          | midnight local on days 1, 1+N, … of each month |',
    "| `Nd`               | `0 0 */N * *`          | midnight UTC on days 1, 1+N, … of each month (pass the user's IANA `timezone` for local midnight) |",
  );
  return out;
}

/** The home-only loop.md intro paragraph (just the intro, not the bullets). */
function managedLoopMdIntro(section: string): string {
  const afterHeader = section.replace(/^## loop\.md task-file mode\n\n/, '');
  const introEnd = afterHeader.indexOf('\n\n');
  const intro = introEnd < 0 ? afterHeader : afterHeader.slice(0, introEnd);
  let out = sub(
    intro,
    "Tasks live in `.qwen/loop.md` (project) or `~/.qwen/loop.md` (home; project wins). Instead of a natural-language prompt, set the loop's `prompt` to a sentinel so each fire re-reads the file:",
    'Tasks live in `$QWEN_HOME/loop.md` (the global loop.md the wakeup fire reads; the workspace project copy is not read on Managed).',
  );
  // Drop the project-path trigger phrase too: the body must not advertise a
  // file it then says is not read.
  out = sub(out, '"loop over the tasks in .qwen/loop.md", or ', 'or ');
  return out;
}

/** The shared "At each fire" prose, derived from the source loop.md section.
 * Cut before the absent-file fallback: each profile appends that fallback and
 * the plain-language confirmation once, so they are not shipped twice. */
function loopMdFireProse(section: string): string {
  const marker = 'At each fire you receive';
  const idx = section.indexOf(marker);
  if (idx < 0) {
    throw new Error(
      'Bundled loop.md section is missing the "At each fire" prose.',
    );
  }
  const prose = section.slice(idx);
  const cut = prose.indexOf(' If `.qwen/loop.md` is absent at fire time');
  if (cut < 0) {
    throw new Error(
      'Bundled loop.md section is missing the absent-file fallback marker.',
    );
  }
  return prose.slice(0, cut).trimEnd();
}

/** The shared steward prose, derived from the source Autonomous section. The
 * self-paced re-arm sentence is always dropped (each profile appends its own);
 * the "later fires send a short reminder" sentence is dropped for cron, whose
 * fires re-deliver the identical instruction rather than a sentinel reminder. */
function stewardProse(section: string, dropReminder: boolean): string {
  const marker =
    'The first immediate check, and each scheduled fire, advance work';
  const idx = section.indexOf(marker);
  if (idx < 0) {
    throw new Error('Bundled Autonomous section is missing the steward prose.');
  }
  let prose = section.slice(idx);
  const cut = prose.indexOf(' In self-paced mode re-arm');
  if (cut < 0) {
    throw new Error(
      'Bundled Autonomous section is missing the self-paced re-arm marker.',
    );
  }
  prose = prose.slice(0, cut);
  if (dropReminder) {
    const reminder = prose.indexOf(
      ' The first fire (and the first after a compaction) delivers fuller guidance',
    );
    if (reminder < 0) {
      throw new Error(
        'Bundled Autonomous section is missing the short-reminder marker.',
      );
    }
    prose = prose.slice(0, reminder);
  }
  return prose.trimEnd();
}

/** The leading-interval detection, derived from the source Parsing rule so a
 * change to the interval syntax reaches every managed body. */
function parsingIntervalGrammar(parsing: string): string {
  const start = parsing.indexOf(
    'the first whitespace-delimited token matches ',
  );
  const end = parsing.indexOf(
    ', this is the fixed-interval recurring path.',
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error('Bundled Parsing is missing the leading-interval rule.');
  }
  return parsing.slice(start, end);
}

/** The trailing-"every" detection (both the compact and unit-word forms),
 * derived from the source Parsing rule. */
function parsingEveryGrammar(parsing: string): string {
  const start = parsing.indexOf('the input ends with ');
  const end = parsing.indexOf(
    ', this is the fixed-interval recurring path.',
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error('Bundled Parsing is missing the trailing-"every" rule.');
  }
  return parsing.slice(start, end);
}

/** Source Parsing rules each profile shell intentionally does not carry: cron
 * has no self-paced route, wakeup folds the two interval rules into one
 * "Interval requested" rule. Every other source rule's full text must appear in
 * the body, so a reworded or newly added rule reddens the generator. */
const PARSING_OMITTED_RULES: Record<ManagedLoopProfile, ReadonlySet<string>> = {
  union: new Set(),
  cron: new Set(['Empty input', 'Prompt-only input']),
  wakeup: new Set(['Leading interval token', 'Trailing "every" clause']),
};

function assertParsingDriftCovered(
  parsingSource: string,
  body: string,
  profile: ManagedLoopProfile,
): void {
  const omitted = PARSING_OMITTED_RULES[profile];
  for (const line of parsingSource.split('\n')) {
    const rule = /^\d+\. \*\*([^*]+)\*\*/.exec(line);
    if (rule) {
      if (omitted.has(rule[1])) continue;
      const text = line.replace(/^\d+\. /, '');
      if (!body.includes(text)) {
        throw new Error(
          `Bundled Parsing rule not carried into the ${profile} body: ${rule[1]}`,
        );
      }
      continue;
    }
    if (profile === 'union' && line.startsWith('- ')) {
      const input = line.slice(2).split('→')[0].trim();
      if (input && !body.includes(input)) {
        throw new Error(
          `Bundled Parsing example not carried into the union body: ${input}`,
        );
      }
    }
  }
}

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
  for (const name of sections.keys()) {
    if (!KNOWN_SECTIONS.has(name)) {
      throw new Error(`Unclassified bundled loop section: ${name}`);
    }
  }
  const get = (name: string): string => {
    const found = sections.get(name);
    if (found === undefined) {
      throw new Error(`Bundled loop body is missing section: ${name}`);
    }
    return found;
  };

  const parsingSource = get('Parsing');
  const intervalGrammar = parsingIntervalGrammar(parsingSource);
  const everyGrammar = parsingEveryGrammar(parsingSource);
  const loopMdSource = get(LOOP_MD);
  const autonomousSource = get(AUTONOMOUS);
  // The cut fire prose carries no file path; the home-only fallback and
  // confirmation appended per profile name only $QWEN_HOME/loop.md.
  const fireProse = loopMdFireProse(loopMdSource);
  const steward = stewardProse(autonomousSource, profile === 'cron');
  const homeIntro = managedLoopMdIntro(loopMdSource);
  const loopMdFallback =
    'If `$QWEN_HOME/loop.md` is absent at fire time, the loop falls back to autonomous mode; a recreated file is picked up on the next fire.';

  const parts: string[] = [preamble, get('Subcommands')];
  let description: string;

  if (profile === 'cron') {
    description =
      'Create a loop that runs a prompt now and follows up on a fixed schedule. Usage - /loop 5m check the build, /loop check the PR every 30m. /loop list to show jobs, /loop clear to cancel all.';
    parts.push(
      `## Parsing\n\nParse the input after removing the \`/loop\` prefix:\n\n` +
        `1. **Leading interval token**: if ${intervalGrammar}, this is the fixed-interval recurring path. The rest is the prompt.\n` +
        `2. **Trailing "every" clause**: otherwise, if ${everyGrammar}, this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — \`check every PR\` has no interval.\n` +
        '3. **No interval**: a Managed schedule on this Session requires a fixed interval. If the input has no interval, tell the user this Session schedules fixed-interval loops only and ask for an interval (for example `/loop 5m check the build`); do not schedule.\n\n' +
        'If an interval was given but the prompt is empty (e.g. `/loop 5m`), this is a fixed-interval **autonomous** loop — see the Autonomous mode section.\n\n' +
        'Examples:\n\n' +
        '- `5m /babysit-prs` → fixed interval `5m`, prompt `/babysit-prs` (leading interval token)\n' +
        '- `check the deploy every 20m` → fixed interval `20m`, prompt `check the deploy` (trailing "every" clause)\n' +
        '- `run tests every 5 minutes` → fixed interval `5m`, prompt `run tests` (trailing "every" clause)\n' +
        '- `check every PR` → no interval; ask for one ("every" is not followed by a time expression)\n' +
        '- `5m` → fixed-interval autonomous loop (interval `5m`)\n',
    );
    parts.push(managedFixedInterval(get(FIXED_INTERVAL)));
    // Cron fires do not expand sentinels and the model cannot open the home
    // file, so there is no loop.md task-file mode here; the autonomous loop is a
    // natural-language steward instruction the model executes each fire.
    parts.push(
      `## ${AUTONOMOUS}\n\nUse this for a bare \`/loop <interval>\` (an interval, no prompt, no file) — the user wants you to keep their work moving while they're away.\n\n` +
        '- Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: a natural-language steward instruction (with `recurring: true` and `durable: true`) telling you to advance the work this conversation already established. Each fire delivers that instruction.\n\n' +
        `${steward} Confirm to the user in plain language ("running an autonomous loop on your work…").`,
    );
  } else if (profile === 'wakeup') {
    description =
      'Create a loop that runs a prompt now and follows up through self-paced wakeups. Usage - /loop check the deploy. /loop list to show jobs, /loop clear to cancel all.';
    parts.push(
      `## Parsing\n\nParse the input after removing the \`/loop\` prefix:\n\n` +
        '1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.\n' +
        `2. **Interval requested**: if ${intervalGrammar} or ${everyGrammar}, strip the interval token (or trailing "every" clause) and run the remainder as the prompt now with a self-paced wakeup; tell the user this Session schedules self-paced follow-ups only, not a fixed cron schedule.\n` +
        '3. **Interval with no prompt**: if stripping the interval leaves no prompt (e.g. `/loop 5m`), run the self-paced autonomous loop instead (`<<autonomous-loop-dynamic>>`) and tell the user this Session schedules self-paced follow-ups only.\n' +
        '4. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.\n\n' +
        'Examples:\n\n' +
        '- `5m /babysit-prs` → self-paced, prompt `/babysit-prs` (interval stripped; self-paced follow-ups only)\n' +
        '- `check the deploy every 20m` → self-paced, prompt `check the deploy` (interval stripped)\n' +
        '- `run tests every 5 minutes` → self-paced, prompt `run tests` (interval stripped)\n' +
        '- `check every PR` → prompt-only self-paced path, prompt `check every PR`\n' +
        '- `check the deploy` → prompt-only self-paced path, prompt `check the deploy`\n' +
        '- (empty) → self-paced autonomous loop (sentinel `<<autonomous-loop-dynamic>>`)\n' +
        '- `5m` → self-paced autonomous loop (sentinel `<<autonomous-loop-dynamic>>`; self-paced follow-ups only)\n',
    );
    const selfPaced = sub(
      get(SELF_PACED),
      '1. Do not call CronCreate for this path.',
      '1. This path follows up through self-paced wakeups only.',
    );
    parts.push(selfPaced);
    parts.push(
      `## ${LOOP_MD}\n\n${homeIntro} Set the loop's \`prompt\` to a sentinel so each wakeup re-reads the file:\n\n` +
        '- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`\n\n' +
        `${fireProse} ${loopMdFallback} Confirm to the user in plain language ("looping over your \`$QWEN_HOME/loop.md\` task list…"), not the raw sentinel.`,
    );
    parts.push(
      `## ${AUTONOMOUS}\n\nUse this for a bare \`/loop\` (no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:\n\n` +
        '- Self-paced (empty input) → LoopWakeup `prompt`: `<<autonomous-loop-dynamic>>`\n\n' +
        `${steward} In self-paced mode re-arm LoopWakeup with \`<<autonomous-loop-dynamic>>\` (same "don't re-arm if complete/blocked" rules). Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.`,
    );
  } else {
    description = frontmatterDescription;
    parts.push(
      `## Parsing\n\nParse the input after removing the \`/loop\` prefix:\n\n` +
        '1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.\n' +
        `2. **Leading interval token**: if ${intervalGrammar}, this is the fixed-interval recurring path. The rest is the prompt.\n` +
        `3. **Trailing "every" clause**: otherwise, if ${everyGrammar}, this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — \`check every PR\` has no interval.\n` +
        '4. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.\n\n' +
        'If an interval was given but the prompt is empty (e.g. `/loop 5m`), this is a fixed-interval **autonomous** loop — see the Autonomous mode section.\n\n' +
        'Examples:\n\n' +
        '- `5m /babysit-prs` → fixed interval `5m`, prompt `/babysit-prs` (leading interval token)\n' +
        '- `check the deploy every 20m` → fixed interval `20m`, prompt `check the deploy` (trailing "every" clause)\n' +
        '- `run tests every 5 minutes` → fixed interval `5m`, prompt `run tests` (trailing "every" clause)\n' +
        '- `check every PR` → prompt-only self-paced path, prompt `check every PR` ("every" is not followed by a time expression)\n' +
        '- `check the deploy` → prompt-only self-paced path, prompt `check the deploy`\n' +
        '- (empty) → self-paced autonomous loop (sentinel `<<autonomous-loop-dynamic>>`)\n' +
        '- `5m` → fixed-interval autonomous loop (interval `5m`, natural-language steward prompt)\n',
    );
    parts.push(get(SELF_PACED));
    parts.push(managedFixedInterval(get(FIXED_INTERVAL)));
    // loop.md task-file mode is self-paced only on Managed: the wakeup fire
    // resolves the sentinel, while a cron fire neither expands it nor lets the
    // model open the home file, so the cron half carries no loop.md mode.
    parts.push(
      `## ${LOOP_MD}\n\n${homeIntro} Set the loop's \`prompt\` to a sentinel so each wakeup re-reads the file:\n\n` +
        '- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`\n\n' +
        `${fireProse} ${loopMdFallback} Confirm to the user in plain language ("looping over your \`$QWEN_HOME/loop.md\` task list…").`,
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
  assertParsingDriftCovered(parsingSource, body, profile);
  const absent =
    profile === 'cron' ? /loop_wakeup|LoopWakeup/ : /cron_create|CronCreate/;
  if (profile !== 'union' && absent.test(body)) {
    throw new Error(
      `Managed ${profile} loop body names a creator the profile lacks.`,
    );
  }
  if (
    body.includes('.qwen/loop.md` (project)') ||
    body.includes('the tasks in .qwen/loop.md')
  ) {
    throw new Error(
      'Managed loop body still claims the workspace project file.',
    );
  }
  assertSentinelsExpanded(body, profile);
  return { description, body };
}

/** The only sentinels a Managed body may teach: the wakeup-expanded -dynamic
 * forms, taken from the runtime constants that actually expand them so "what
 * expands" has a single source — a runtime rename reddens the parity build
 * here rather than silently whitelisting a token nothing expands. An
 * allow-list, not a deny-list of known non-expanding forms, so a newly added
 * sentinel ships red instead of slipping through. Cron fires expand no
 * sentinel at all. Kept a top-level pure declaration so the parity test can
 * execute it against a hostile body. */
const EXPANDING_SENTINELS: ReadonlySet<string> = new Set([
  LOOP_SENTINEL_DYNAMIC,
  AUTONOMOUS_SENTINEL_DYNAMIC,
]);

export function assertSentinelsExpanded(
  body: string,
  profile: ManagedLoopProfile,
): void {
  for (const sentinel of body.match(/<<[^>]+>>/g) ?? []) {
    // Report only what the guard established. Cron fires expand no sentinel at
    // all, so any sentinel is wrong there. For the other profiles the fact is
    // membership, not expansion: an unknown sentinel may well expand
    // somewhere, and calling it "non-expanding" would assert something this
    // allow-list never checked.
    if (profile === 'cron') {
      throw new Error(
        `Managed cron loop body teaches a sentinel, but cron fires expand none: ${sentinel}.`,
      );
    }
    if (!EXPANDING_SENTINELS.has(sentinel)) {
      throw new Error(
        `Managed ${profile} loop body teaches a sentinel outside the expanding allow-list: ${sentinel}.`,
      );
    }
  }
}
