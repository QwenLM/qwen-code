/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManagedLoopSkill,
  assertSentinelsExpanded,
  MANAGED_LOOP_PROFILES,
  type ManagedLoopProfile,
} from './managed-loop-skill.js';
import { parseSkillContent } from '../../skill-load.js';
import { compileCron } from '../../../managed-runtime/managed-automation-slots.js';
import { parseCron } from '../../../utils/cronParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '../../../managed-runtime/contracts');

/** The raw bundled body + frontmatter description, as the variant generator
 * consumes them (it normalizes internally). The daemon publishes the body
 * trimmed; the bundled-body reference sidecar pins that trimmed wire value
 * against parseSkillContent in its own test below. */
function bundled(): { body: string; description: string } {
  const raw = readFileSync(join(here, 'SKILL.md'), 'utf8');
  const normalized = raw
    .replace(/^/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md frontmatter not found');
  const descLine = match[1]
    .split('\n')
    .find((line) => line.startsWith('description:'));
  if (!descLine) throw new Error('SKILL.md frontmatter has no description');
  return {
    body: match[2],
    description: descLine.slice('description:'.length).trim(),
  };
}

const ASSETS: Record<ManagedLoopProfile, string> = {
  union: 'managed-loop-skill-union.json',
  cron: 'managed-loop-skill-cron.json',
  wakeup: 'managed-loop-skill-wakeup.json',
};

function asset(profile: ManagedLoopProfile): {
  description: string;
  body: string;
} {
  return JSON.parse(readFileSync(join(contractsDir, ASSETS[profile]), 'utf8'));
}

/** The loop.md section of a body, up to the next top-level heading. */
function loopMdSection(body: string): string {
  const start = body.indexOf('## loop.md task-file mode');
  if (start < 0) return '';
  const next = body.indexOf('\n## ', start + 1);
  return body.slice(start, next < 0 ? undefined : next);
}

describe('managed loop skill parity', () => {
  const { body, description } = bundled();

  it.each(MANAGED_LOOP_PROFILES)(
    'the committed %s sidecar equals the generator output byte-for-byte',
    (profile) => {
      // Regenerate after editing SKILL.md:
      //   npx tsx packages/core/src/skills/bundled/loop/regenerate-managed-loop-assets.ts
      // A drift in the bundled source or the committed sidecar reddens this.
      const expected = buildManagedLoopSkill(profile, body, description);
      const committed = asset(profile);
      expect(committed.description).toBe(expected.description);
      expect(committed.body).toBe(expected.body);
    },
  );

  it('the union description is the bundled frontmatter description', () => {
    expect(asset('union').description).toBe(description);
    expect(asset('cron').description).toContain('fixed schedule');
    expect(asset('cron').description).not.toContain('self-paced wakeups');
    expect(asset('wakeup').description).toContain('self-paced wakeups');
    expect(asset('wakeup').description).not.toContain('fixed schedule');
  });

  it('the union body keeps both creators with Managed wording', () => {
    const union = asset('union').body;
    expect(union).toContain('CronCreate');
    expect(union).toContain('LoopWakeup');
    expect(union).toContain('a Managed schedule is always durable');
    expect(union).toContain('runs until cancelled');
    expect(union).not.toContain('defaults to session-only');
    expect(union).not.toContain('7 days after creation');
  });

  it('the cron body names cron creators and never the wakeup creator', () => {
    const cron = asset('cron').body;
    expect(cron).toContain('CronCreate');
    expect(cron).toContain('CronList');
    expect(cron).toContain('CronDelete');
    expect(cron).not.toMatch(/loop_wakeup|LoopWakeup/);
    expect(cron).not.toContain('## Prompt-only self-paced path');
  });

  it('the wakeup body names the wakeup creator and never cron_create', () => {
    const wakeup = asset('wakeup').body;
    expect(wakeup).toContain('LoopWakeup');
    expect(wakeup).toContain('CronList');
    expect(wakeup).toContain('CronDelete');
    expect(wakeup).not.toMatch(/cron_create|CronCreate/);
    expect(wakeup).not.toContain('## Fixed-interval recurring path');
  });

  it('no body claims the workspace project loop.md file', () => {
    for (const profile of MANAGED_LOOP_PROFILES) {
      const b = asset(profile).body;
      expect(b).not.toContain('`.qwen/loop.md` (project)');
      expect(b).not.toContain('project wins');
      // The project-path trigger phrase must not be advertised either.
      expect(b).not.toContain('the tasks in .qwen/loop.md');
    }
    // The wakeup fire resolves <QWEN_HOME>/loop.md (every managed deployment
    // sets QWEN_HOME), so the bodies must name that spelling, not ~/.qwen.
    expect(asset('union').body).toContain('$QWEN_HOME/loop.md');
    expect(asset('wakeup').body).toContain('$QWEN_HOME/loop.md');
    expect(asset('union').body).not.toContain('~/.qwen/loop.md');
    expect(asset('wakeup').body).not.toContain('~/.qwen/loop.md');
  });

  it('the bundled-body reference sidecar equals the body the daemon publishes', () => {
    const reference = JSON.parse(
      readFileSync(
        join(contractsDir, 'managed-loop-skill-bundled-body.json'),
        'utf8',
      ),
    );
    // Pin the reference to the producer that actually publishes the wire value
    // (parseSkillContent trims), not to the raw frontmatter remainder: an
    // untrimmed reference never matches a real creation's trimmed body.
    const published = parseSkillContent(
      readFileSync(join(here, 'SKILL.md'), 'utf8'),
      join(here, 'SKILL.md'),
    );
    expect(reference.body).toBe(published.body);
  });

  it('the cron body carries no loop.md task-file mode and no sentinel at all', () => {
    // A cron fire expands no sentinel and the model cannot open the home file,
    // so the cron body must not teach the file mode or any sentinel.
    const cron = asset('cron').body;
    expect(cron).not.toContain('## loop.md task-file mode');
    expect(cron).not.toMatch(/<<[^>]+>>/);
  });

  it('the union loop.md mode is self-paced only (no cron file bullet)', () => {
    const section = loopMdSection(asset('union').body);
    expect(section).toContain('<<loop.md-dynamic>>');
    expect(section).not.toContain('CronCreate');
  });

  it('the cron and union bodies teach no non-expanding cron sentinel', () => {
    for (const profile of ['union', 'cron'] as const) {
      expect(asset(profile).body).not.toMatch(
        /<<loop\.md>>|<<autonomous-loop>>/,
      );
    }
    expect(asset('wakeup').body).toContain('<<loop.md-dynamic>>');
    expect(asset('wakeup').body).toContain('<<autonomous-loop-dynamic>>');
  });

  it('the loop.md fallback/confirmation passage ships exactly once', () => {
    const count = (b: string) => (b.match(/absent at fire time/g) ?? []).length;
    expect(count(asset('union').body)).toBe(1);
    expect(count(asset('wakeup').body)).toBe(1);
    expect(count(asset('cron').body)).toBe(0);
  });

  it('the cron body drops the sentinel-era short-reminder sentence', () => {
    expect(asset('cron').body).not.toContain(
      'later fires send a short reminder',
    );
    expect(asset('union').body).toContain('later fires send a short reminder');
    expect(asset('wakeup').body).toContain('later fires send a short reminder');
  });

  it('no body says midnight local (Managed defaults to UTC)', () => {
    for (const profile of MANAGED_LOOP_PROFILES) {
      expect(asset(profile).body).not.toContain('midnight local');
    }
    expect(asset('cron').body).toContain('midnight UTC');
    expect(asset('union').body).toContain('midnight UTC');
  });

  it('the wakeup parsing strips a requested interval and routes interval-only input', () => {
    const wakeup = asset('wakeup').body;
    expect(wakeup).toContain('strip the interval token');
    expect(wakeup).toContain('self-paced follow-ups only');
    // Both the compact and the unit-word "every" forms are honoured.
    expect(wakeup).toContain('every <N> <unit-word>');
    // An interval with no prompt routes to the self-paced autonomous sentinel.
    expect(wakeup).toContain('Interval with no prompt');
    expect(wakeup).toContain('`5m` → self-paced autonomous loop');
  });

  it('pins the shared steward prose to the bundled source per profile', () => {
    const marker =
      'The first immediate check, and each scheduled fire, advance work';
    const idx = body.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const cut = body.indexOf(' In self-paced mode re-arm', idx);
    const steward = body.slice(idx, cut < 0 ? undefined : cut).trimEnd();
    expect(asset('union').body).toContain(steward);
    expect(asset('wakeup').body).toContain(steward);
    // Cron additionally drops the short-reminder sentence.
    const rem = steward.indexOf(
      ' The first fire (and the first after a compaction) delivers fuller guidance',
    );
    const cronSteward = (rem < 0 ? steward : steward.slice(0, rem)).trimEnd();
    expect(asset('cron').body).toContain(cronSteward);
  });

  it('rejects an unclassified bundled section instead of silently dropping it', () => {
    const withNewSection = `${body}\n## What to do on failure\n\nNew guidance.\n`;
    for (const profile of MANAGED_LOOP_PROFILES) {
      expect(() =>
        buildManagedLoopSkill(profile, withNewSection, description),
      ).toThrow(/Unclassified bundled loop section: What to do on failure/);
    }
  });

  it('rejects any sentinel smuggled into the cron body, including -dynamic', () => {
    const mutated = body.replace(
      '# /loop — run a prompt repeatedly',
      '# /loop — run a prompt repeatedly\n\n<<loop.md-dynamic>>',
    );
    expect(() => buildManagedLoopSkill('cron', mutated, description)).toThrow(
      /non-expanding sentinel/,
    );
  });

  it('rejects a non-expanding sentinel in every profile, including wakeup', () => {
    const mutated = body.replace(
      '# /loop — run a prompt repeatedly',
      '# /loop — run a prompt repeatedly\n\n<<autonomous-loop>>',
    );
    expect(mutated).not.toBe(body);
    for (const profile of MANAGED_LOOP_PROFILES) {
      expect(() =>
        buildManagedLoopSkill(profile, mutated, description),
      ).toThrow(/non-expanding sentinel/);
    }
  });

  it('throws when the loop.md fallback sentence drifts (fail-closed cut)', () => {
    const mutated = body.replace(
      'is absent at fire time',
      'is missing at fire time',
    );
    expect(mutated).not.toBe(body);
    expect(() => buildManagedLoopSkill('union', mutated, description)).toThrow(
      /absent-file fallback marker/,
    );
  });

  it('throws when the steward re-arm sentence drifts (fail-closed cut)', () => {
    const mutated = body.replace(
      'In self-paced mode re-arm',
      'In self-paced mode rearm',
    );
    expect(mutated).not.toBe(body);
    expect(() => buildManagedLoopSkill('union', mutated, description)).toThrow(
      /self-paced re-arm marker/,
    );
  });

  it('throws when a Parsing rule is added that a profile shell does not carry', () => {
    const mutated = body.replace(
      'Examples:',
      '5. **Stop keyword**: a new rule.\n\nExamples:',
    );
    expect(mutated).not.toBe(body);
    for (const profile of MANAGED_LOOP_PROFILES) {
      expect(() =>
        buildManagedLoopSkill(profile, mutated, description),
      ).toThrow(
        new RegExp(
          `Parsing rule not carried into the ${profile} body: Stop keyword`,
        ),
      );
    }
  });

  it('throws when a carried Parsing rule sentence is reworded', () => {
    const mutated = body.replace(
      'Only match when what follows "every" is a time expression',
      'Only match when "every" is followed by a duration',
    );
    expect(mutated).not.toBe(body);
    expect(() => buildManagedLoopSkill('union', mutated, description)).toThrow(
      /Parsing rule not carried into the union body: Trailing "every" clause/,
    );
  });

  it('throws when the short-reminder marker drifts (fail-closed cut, cron)', () => {
    const mutated = body.replace(
      'The first fire (and the first after a compaction) delivers fuller guidance',
      'The first fire (and the first after a compaction) delivers full guidance',
    );
    expect(mutated).not.toBe(body);
    expect(() => buildManagedLoopSkill('cron', mutated, description)).toThrow(
      /short-reminder marker/,
    );
  });

  it('the bundled Parsing section keeps the full rule inventory', () => {
    // The drift guard checks source→body coverage, so a rule DELETED from the
    // bundled source is invisible to it (fewer rules to carry). Pin the rule
    // inventory itself so deleting a rule reddens here instead of silently
    // shrinking the contract.
    const start = body.indexOf('## Parsing');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = body.slice(start);
    const next = rest.indexOf('\n## ', 1);
    const section = next < 0 ? rest : rest.slice(0, next);
    const rules = [...section.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map(
      (match) => match[1],
    );
    expect(rules).toEqual([
      'Empty input',
      'Leading interval token',
      'Trailing "every" clause',
      'Prompt-only input',
    ]);
  });

  it('each profile shell keeps its own Parsing rule inventory', () => {
    // The bundled inventory above cannot see the managed-only rules the cron
    // and wakeup shells write themselves: deleting the cron shell's "No
    // interval" rule, or renaming wakeup's "Interval requested", would
    // regenerate green. Pin each shell's rule names. The Record is keyed by
    // ManagedLoopProfile, so a new profile cannot skip this pin.
    const expected: Record<ManagedLoopProfile, readonly string[]> = {
      union: [
        'Empty input',
        'Leading interval token',
        'Trailing "every" clause',
        'Prompt-only input',
      ],
      cron: [
        'Leading interval token',
        'Trailing "every" clause',
        'No interval',
      ],
      wakeup: [
        'Empty input',
        'Interval requested',
        'Interval with no prompt',
        'Prompt-only input',
      ],
    };
    for (const profile of MANAGED_LOOP_PROFILES) {
      const text = asset(profile).body;
      const start = text.indexOf('## Parsing');
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = text.slice(start);
      const next = rest.indexOf('\n## ', 1);
      const section = next < 0 ? rest : rest.slice(0, next);
      const rules = [...section.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map(
        (match) => match[1],
      );
      expect({ profile, rules }).toEqual({
        profile,
        rules: [...expected[profile]],
      });
    }
  });

  it('the committed sidecar set equals the declared profile set', () => {
    // The producer derives its targets from MANAGED_LOOP_PROFILES; this pins
    // the other direction — a profile removed without deleting its sidecar
    // (still copied to the Java classpath and served) reddens here. The
    // bundled-body reference is not a profile and is excluded.
    const committed = readdirSync(contractsDir)
      .filter(
        (name) =>
          name.startsWith('managed-loop-skill-') &&
          name.endsWith('.json') &&
          name !== 'managed-loop-skill-bundled-body.json',
      )
      .sort();
    const declared = MANAGED_LOOP_PROFILES.map(
      (profile) => `managed-loop-skill-${profile}.json`,
    ).sort();
    expect(committed).toEqual(declared);
  });

  it('the Java sidecar map and routing serve exactly the declared profile set', () => {
    // Two hand-kept Java sites decide whether a profile gets a /loop skill,
    // and neither is bound to the TypeScript tuple: sidecars() only SUPPLIES
    // bodies, while forProfile()'s routing chain decides which workspace
    // profile reaches one. Pin the supply key set AND the profile→key mapping
    // — a target set alone cannot see two profiles swapping bodies, which
    // would hand a workspace the wrong creators. The provenance-only
    // "bundled" key is allowed in sidecars() (it backs the bundled-import
    // comparison, not a tool profile); a creator-less profile routes to null
    // and never assigns a key, so it is absent from the mapping.
    const javaSource = readFileSync(
      join(
        here,
        '../../../../../managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedLoopSkill.java',
      ),
      'utf8',
    );
    // Scrape code, not prose: a comment that happens to spell an assignment
    // must not redden this suite. The file carries no string literal
    // containing a comment marker, so the two comment forms strip cleanly.
    const javaCode = javaSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const javaKeys = [...javaCode.matchAll(/"(\w+)",\s*readSidecar\(/g)]
      .map((match) => match[1])
      .filter((key) => key !== 'bundled')
      .sort();
    expect(javaKeys).toEqual([...MANAGED_LOOP_PROFILES].sort());
    // Each routing branch: the profile constants in its condition, then the
    // key it assigns. A branch may serve several profiles (FILES_V4 and
    // INTERNAL_TEAM_LEAD_V2 share cron), so the mapping is many-to-one.
    const routing = [
      ...javaCode.matchAll(
        /((?:WorkspaceToolProfiles\.\w+\.equals\(profile\)[\s|)]*)+)\{\s*key = "(\w+)";/g,
      ),
    ].flatMap((match) =>
      [...match[1]!.matchAll(/WorkspaceToolProfiles\.(\w+)\.equals/g)].map(
        (profile) => [profile[1]!, match[2]!] as const,
      ),
    );
    expect(Object.fromEntries(routing)).toEqual({
      SHELL_V4: 'union',
      FILES_V4: 'cron',
      INTERNAL_TEAM_LEAD_V2: 'cron',
      SHELL_V3: 'wakeup',
    });
    expect([...new Set(routing.map(([, key]) => key))].sort()).toEqual(
      [...MANAGED_LOOP_PROFILES].sort(),
    );
  });

  it('the Nd month-boundary caveat matches the Managed slot compiler', () => {
    // The caveat flows verbatim from SKILL.md (no substitution), so deleting
    // or rewording it would otherwise regenerate green. Its arithmetic is
    // DERIVED from compileCron — the TypeScript twin of the Java CronSlots
    // scanner that actually fires a Managed schedule — instead of restated as
    // prose, so a wrong bound or a wrong example gap reddens even when the pin
    // text is updated to match it. The N ≤ 31 off-by-one survived two review
    // rounds precisely because nothing computed the bound. utils/cronParser
    // serves the local CLI scheduler, not this one: a Managed slot-semantics
    // change would leave that parser (and a pin derived from it) untouched.
    const daySet = (step: number): ReadonlySet<number> =>
      compileCron(`0 0 */${step} * *`).dayOfMonth;
    // The day-of-month field is [1, 31] and a step past 31 collects day 1
    // alone, so scanning 1..31 covers every distinct day set.
    let maxStep = 1;
    for (let step = 1; step <= 31; step += 1) {
      if (daySet(step).size > 1) maxStep = step;
    }
    const exampleDays = [...daySet(2)];
    const lastFire = (monthLength: number): number =>
      Math.max(...exampleDays.filter((day) => day <= monthLength));
    // The boundary gap runs from the month's last fire to the next month's
    // day 1, which the step always collects.
    const boundaryGap = (monthLength: number): number =>
      monthLength - lastFire(monthLength) + 1;
    const ordinal = (day: number): string => {
      const teen = day % 100 >= 11 && day % 100 <= 13;
      return `${day}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th')}`;
    };
    // The caveat also reaches the local CLI scheduler, whose CronCreate
    // validates with utils/cronParser. Bind the two evaluators: they expand
    // */N identically today, and a divergence must redden here rather than
    // leave one scheduler teaching a cadence the other does not honour.
    for (let step = 1; step <= 31; step += 1) {
      expect([...parseCron(`0 0 */${step} * *`).dayOfMonth].sort()).toEqual(
        [...daySet(step)].sort(),
      );
    }
    for (const profile of ['cron', 'union'] as const) {
      const text = asset(profile).body;
      expect(text).toContain('day-of-month step, not a rolling N-day cadence');
      expect(text).toContain('at most N days');
      expect(text).toContain(`Keep N ≤ ${maxStep}`);
      // Each worked example is asserted as ONE clause, so a gap cannot be
      // swapped between the two month lengths: separate presence checks
      // would both still pass while the pairing taught the wrong arithmetic.
      expect(text).toContain(
        `in a 30-day month \`*/2\` fires on the ${ordinal(lastFire(30))} then the 1st — a ${boundaryGap(30)}-day gap`,
      );
      expect(text).toContain(
        `in a 31-day month on the ${ordinal(lastFire(31))} then the 1st — a ${boundaryGap(31)}-day gap`,
      );
    }
  });

  it('the managed Nd table cell keeps the corrected substitution', () => {
    // The managed-side half of the Nd fix is the sub() that rewrites the
    // table row; reverting its replacement string and regenerating would
    // otherwise teach "every N days" again with every gate green. Pin the
    // substituted cell and forbid the pre-fix wording.
    for (const profile of ['cron', 'union'] as const) {
      const text = asset(profile).body;
      expect(text).toContain('midnight UTC on days 1, 1+N, … of each month');
      expect(text).not.toContain('every N days');
    }
  });

  it('the sentinel guard is an allow-list, so a new sentinel ships red', () => {
    // Only the two wakeup-expanded -dynamic forms may appear in a union or
    // wakeup body; cron may carry none. A deny-list of known non-expanding
    // forms would let a newly added sentinel slip through.
    expect(() =>
      assertSentinelsExpanded(
        'uses <<loop.md-dynamic>> and <<autonomous-loop-dynamic>>',
        'union',
      ),
    ).not.toThrow();
    expect(() =>
      assertSentinelsExpanded('uses <<loop.md-dynamic>>', 'wakeup'),
    ).not.toThrow();
    expect(() =>
      assertSentinelsExpanded('no sentinels here', 'cron'),
    ).not.toThrow();
    expect(() =>
      assertSentinelsExpanded('teaches <<brand-new-sentinel>>', 'union'),
    ).toThrow(/non-expanding sentinel: <<brand-new-sentinel>>/);
    expect(() =>
      assertSentinelsExpanded('teaches <<brand-new-sentinel>>', 'wakeup'),
    ).toThrow(/non-expanding sentinel/);
    expect(() =>
      assertSentinelsExpanded('teaches <<loop.md>>', 'union'),
    ).toThrow(/non-expanding sentinel/);
    expect(() =>
      assertSentinelsExpanded('teaches <<loop.md-dynamic>>', 'cron'),
    ).toThrow(/non-expanding sentinel/);
  });

  it('the sentinel guard runs on the assembled body at its call site', () => {
    // The isolated-helper test above would still pass if a later edit inlined
    // a deny-list back into buildManagedLoopSkill and left the export unused.
    // Inject a brand-new sentinel into the Input section (carried verbatim
    // into every profile body) and require the real build to reject it, so the
    // call site itself is load-bearing.
    const mutated = body.replace(
      '## Input',
      '## Input\n\nArm <<brand-new-sentinel>>.',
    );
    expect(mutated).not.toBe(body);
    for (const profile of MANAGED_LOOP_PROFILES) {
      expect(() =>
        buildManagedLoopSkill(profile, mutated, description),
      ).toThrow(/non-expanding sentinel: <<brand-new-sentinel>>/);
    }
  });
});
