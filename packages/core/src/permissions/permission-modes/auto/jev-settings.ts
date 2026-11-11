/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Trusted, user-only configuration for the permission judge. */
import { readFileSync } from 'node:fs';
import stripJsonComments from 'strip-json-comments';
import { stripBOM } from '../../../utils/stripBom.js';
import { Storage } from '../../../config/storage.js';
import {
  parseJudgmentSettings,
  type JudgmentSettings,
} from '../../../judgment/settings.js';
import { expandEnvVars } from '../../../utils/envExpansion.js';

export type JevQuestionMode = 'single' | 'multi';

export interface AutoJudgmentSettings {
  classifier: 'llm' | 'jev';
  jevQuestionMode?: JevQuestionMode;
  judgment?: JudgmentSettings;
}

// Never consume merged workspace settings here: a checkout must not select
// the server deciding whether that checkout's commands may execute.
export function readAutoJudgmentSettings(
  options: {
    defaultJudgment?: JudgmentSettings;
    parseJudgment?: (value: unknown) => JudgmentSettings | undefined;
  } = {},
): AutoJudgmentSettings {
  let raw: {
    autoMode?: { classifier?: unknown; jevQuestionMode?: unknown };
    judgment?: unknown;
  };
  try {
    raw = JSON.parse(
      stripJsonComments(
        stripBOM(readFileSync(Storage.getGlobalSettingsPath(), 'utf8')),
      ),
    );
  } catch (error) {
    // Missing user settings use the host default; corrupt/unreadable settings fail closed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return { classifier: 'jev' };
    raw = {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { classifier: 'jev' };
  if (
    raw.autoMode?.classifier === 'llm' ||
    (raw.autoMode?.classifier === undefined &&
      raw.judgment === undefined &&
      !options.defaultJudgment)
  ) {
    return { classifier: 'llm' };
  }
  // Invalid explicit selections fail closed, rather than switching engines.
  if (
    raw.autoMode?.classifier !== undefined &&
    raw.autoMode.classifier !== 'jev'
  )
    return { classifier: 'jev' };
  try {
    const expand = (value: unknown): unknown => {
      if (typeof value === 'string') return expandEnvVars(value, process.env);
      if (Array.isArray(value)) return value.map(expand);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, expand(v)]),
        );
      return value;
    };
    const mode = raw.autoMode?.jevQuestionMode;
    if (mode !== undefined && mode !== 'single' && mode !== 'multi')
      return { classifier: 'jev' };
    const judgment =
      raw.judgment === undefined
        ? options.defaultJudgment
        : (options.parseJudgment ?? parseJudgmentSettings)(
            expand(raw.judgment),
          );
    return {
      classifier: 'jev',
      judgment,
      ...(mode === undefined ? {} : { jevQuestionMode: mode }),
    };
  } catch {
    return { classifier: 'jev' };
  }
}
