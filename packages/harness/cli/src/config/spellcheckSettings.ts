/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution of the `spellcheck` block.
 *
 * Read from trusted scopes only, and taken whole rather than merged field by
 * field. `checker` and `language` decide which executable is spawned and with
 * what arguments, so a block that travels with a repository would be a way to
 * pick the program this process runs. Trust filtering is not enough on its own:
 * it empties `workspace` in an untrusted folder, but `.qwen/settings.local.json`
 * is read as-is and a clone can carry one.
 *
 * Taking the block whole is what makes "the trusted scopes decide" true. Under a
 * field-level merge a repository could supply `checker` while the user supplied
 * only `enabled`, and the effective configuration would be neither party's.
 */

import { runLogger } from '@qwen-code/core';
import type { SettingsFile } from './settings.js';
import type { SpellcheckCheckerSetting } from './settingsSchema.js';
import { isValidDictionaryName } from '../spellcheck/protocol.js';

/** The subset of `LoadedSettings` / `LoadedSettingsSnapshot` this reads. */
export interface SpellcheckSettingsSource {
  user: SettingsFile;
  project: SettingsFile;
  local: SettingsFile;
  flag: SettingsFile;
}

export interface ResolvedSpellcheckSettings {
  enabled: boolean;
  checker: SpellcheckCheckerSetting;
  /** A validated plain dictionary name, or undefined for the checker's own default. */
  language: string | undefined;
  /** Normalized by the render layer, which owns the color forms. */
  color: string | undefined;
}

export const SPELLCHECK_DISABLED: ResolvedSpellcheckSettings = Object.freeze({
  enabled: false,
  checker: 'auto' as const,
  language: undefined,
  color: undefined,
});

type SpellcheckBlock = NonNullable<SettingsFile['settings']['spellcheck']>;

// Advisory logs, once per process each. They explain a block that was written
// but does not apply; repeating that on every keystroke would bury it.
let warnedRepositoryScope = false;
let warnedMaskedEnable = false;

/** Test seam: the warnings are one-shot, so a suite needs to rearm them. */
export function resetSpellcheckSettingsWarningsForTesting(): void {
  warnedRepositoryScope = false;
  warnedMaskedEnable = false;
}

function readBlock(file: SettingsFile | undefined): SpellcheckBlock | undefined {
  const block = file?.settings?.spellcheck;
  return block && typeof block === 'object' ? block : undefined;
}

function isEnabled(block: SpellcheckBlock | undefined): boolean {
  return block?.enabled === true;
}

/**
 * The effective spellcheck configuration.
 *
 * The flag scope wins over the user scope, whole block against whole block.
 * Repository scopes are not read.
 */
export function resolveSpellcheckSettings(
  settings: SpellcheckSettingsSource,
): ResolvedSpellcheckSettings {
  const flagBlock = readBlock(settings.flag);
  const userBlock = readBlock(settings.user);
  const effective = flagBlock ?? userBlock;

  const projectBlock = readBlock(settings.project);
  const localBlock = readBlock(settings.local);
  if (!warnedRepositoryScope && (projectBlock || localBlock)) {
    warnedRepositoryScope = true;
    runLogger.debug(
      '[spellcheck] a `spellcheck` block in project settings is ignored; ' +
        'configure spell checking in your own settings file instead',
    );
  }

  const enabled = isEnabled(effective);
  if (!warnedMaskedEnable && !enabled) {
    // Only speak up when someone actually asked for spell checking somewhere
    // and it did not survive. `enabled: false` is not a mistake to report.
    const maskedScope = [
      projectBlock,
      localBlock,
      effective === flagBlock ? userBlock : undefined,
    ].find(isEnabled);
    if (maskedScope) {
      warnedMaskedEnable = true;
      runLogger.debug(
        '[spellcheck] `enabled: true` is set in a block that does not apply, ' +
          'so spell checking is off. The whole block from the ' +
          'highest-precedence trusted scope applies; blocks are not merged ' +
          'field by field.',
      );
    }
  }

  if (!effective) return SPELLCHECK_DISABLED;

  const language = effective.language;
  let resolvedLanguage: string | undefined;
  if (typeof language === 'string' && language !== '') {
    if (isValidDictionaryName(language)) {
      resolvedLanguage = language;
    } else {
      runLogger.debug(
        `[spellcheck] ignoring language "${language}" (not a plain dictionary ` +
          `name); the checker's default dictionary applies`,
      );
    }
  }

  return {
    enabled,
    // `checker` is an enum, so settings validation has already pruned any value
    // outside the option set before this reads it.
    checker: (effective.checker as SpellcheckCheckerSetting | undefined) ?? 'auto',
    language: resolvedLanguage,
    color: typeof effective.color === 'string' ? effective.color : undefined,
  };
}
