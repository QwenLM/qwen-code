/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManagedLoopSkill,
  type ManagedLoopProfile,
} from './managed-loop-skill.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '../../../managed-runtime/contracts');

/** The bundled body + frontmatter description exactly as the daemon reads them. */
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

describe('managed loop skill parity', () => {
  const { body, description } = bundled();

  it.each(['union', 'cron', 'wakeup'] as const)(
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
    for (const profile of ['union', 'cron', 'wakeup'] as const) {
      const b = asset(profile).body;
      expect(b).not.toContain('`.qwen/loop.md` (project)');
      expect(b).not.toContain('project wins');
      expect(b).toContain('~/.qwen/loop.md');
    }
  });

  it('the cron and union bodies teach no non-expanding cron sentinel', () => {
    // Managed cron fires do not expand sentinels; only the wakeup path may use
    // the self-paced sentinels the wakeup fire expands.
    for (const profile of ['union', 'cron'] as const) {
      expect(asset(profile).body).not.toMatch(
        /<<loop\.md>>|<<autonomous-loop>>/,
      );
    }
    expect(asset('wakeup').body).toContain('<<loop.md-dynamic>>');
    expect(asset('wakeup').body).toContain('<<autonomous-loop-dynamic>>');
  });

  it('no body says midnight local (Managed defaults to UTC)', () => {
    for (const profile of ['union', 'cron', 'wakeup'] as const) {
      const b = asset(profile).body;
      expect(b).not.toContain('midnight local');
    }
    expect(asset('cron').body).toContain('midnight UTC');
    expect(asset('union').body).toContain('midnight UTC');
  });

  it('the wakeup parsing strips a requested interval', () => {
    const wakeup = asset('wakeup').body;
    expect(wakeup).toContain('strip the interval token');
    expect(wakeup).toContain('self-paced follow-ups only');
  });

  it('pins the shared steward prose to the bundled source', () => {
    // The steward paragraph is derived from the source Autonomous section; a
    // change to it in SKILL.md must redden every profile, not just union.
    const marker =
      'The first immediate check, and each scheduled fire, advance work';
    const idx = body.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const cut = body.indexOf(' In self-paced mode re-arm', idx);
    const steward = body.slice(idx, cut < 0 ? undefined : cut).trimEnd();
    for (const profile of ['union', 'cron', 'wakeup'] as const) {
      expect(asset(profile).body).toContain(steward);
    }
  });
});
