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
  buildManagedLoopBody,
  type ManagedLoopProfile,
} from './managed-loop-skill.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '../../../managed-runtime/contracts');

/** The bundled body exactly as the daemon publishes it (frontmatter stripped). */
function bundledBody(): string {
  const raw = readFileSync(join(here, 'SKILL.md'), 'utf8');
  const normalized = raw
    .replace(/^/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md frontmatter not found');
  return match[2];
}

const ASSETS: Record<ManagedLoopProfile, string> = {
  union: 'managed-loop-skill-union.md',
  cron: 'managed-loop-skill-cron.md',
  wakeup: 'managed-loop-skill-wakeup.md',
};

function asset(profile: ManagedLoopProfile): string {
  return readFileSync(join(contractsDir, ASSETS[profile]), 'utf8');
}

describe('managed loop skill parity', () => {
  const body = bundledBody();

  it.each(['union', 'cron', 'wakeup'] as const)(
    'the committed %s asset equals the generator output byte-for-byte',
    (profile) => {
      // Regenerate the assets with: tsx the generator against SKILL.md. A drift
      // in either the bundled source or the committed asset reddens this case.
      expect(asset(profile)).toBe(buildManagedLoopBody(profile, body));
    },
  );

  it('the union body is the bundled body under the Managed wording substitutions', () => {
    const union = buildManagedLoopBody('union', body);
    // Managed durable/expiry wording replaces the local semantics.
    expect(union).toContain('a Managed schedule is always durable');
    expect(union).toContain(
      'runs until cancelled (a Managed schedule does not expire)',
    );
    expect(union).not.toContain('defaults to session-only');
    expect(union).not.toContain('7 days after creation');
    expect(union).not.toContain('if persistence is implied');
    // The union keeps both creators and every section.
    expect(union).toContain('CronCreate');
    expect(union).toContain('LoopWakeup');
    expect(union).toContain('## Prompt-only self-paced path');
    expect(union).toContain('## Fixed-interval recurring path');
  });

  it('the cron-only body names cron creators and never the wakeup creator', () => {
    const cron = buildManagedLoopBody('cron', body);
    expect(cron).toContain('CronCreate');
    expect(cron).toContain('CronList');
    expect(cron).toContain('CronDelete');
    expect(cron).not.toMatch(/loop_wakeup|LoopWakeup/);
    expect(cron).not.toContain('## Prompt-only self-paced path');
    expect(cron).toContain('## Fixed-interval recurring path');
  });

  it('the wakeup-only body names the wakeup creator and never cron_create', () => {
    const wakeup = buildManagedLoopBody('wakeup', body);
    expect(wakeup).toContain('LoopWakeup');
    expect(wakeup).toContain('CronList');
    expect(wakeup).toContain('CronDelete');
    expect(wakeup).not.toMatch(/cron_create|CronCreate/);
    expect(wakeup).not.toContain('## Fixed-interval recurring path');
    expect(wakeup).toContain('## Prompt-only self-paced path');
  });

  it('binds the shared sections to the bundled source', () => {
    // The Subcommands section is shared verbatim across every profile; if the
    // bundled source changes it, the generator output (and thus the parity
    // above) moves with it. Pin one shared anchor to the live source.
    const subcommands = body.split('## Subcommands')[1].split('\n## ')[0];
    for (const profile of ['union', 'cron', 'wakeup'] as const) {
      expect(buildManagedLoopBody(profile, body)).toContain(
        subcommands.trimEnd(),
      );
    }
  });
});
