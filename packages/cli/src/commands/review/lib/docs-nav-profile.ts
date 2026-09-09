/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse, type ParseError } from 'jsonc-parser';
import { isFileSourcedEnvKey } from '../../../config/environment.js';
import { parseDiff } from './diff-plan.js';

export const DOCS_NAV_PROFILE = 'docs-nav';

/**
 * Whether this capture is the automatic workflow's. Operator-only, in the
 * same two tiers as the review prebuild switch (lib/prebuild.ts): the key
 * sits in `PROJECT_ENV_HARDCODED_EXCLUSIONS` so repository content never
 * writes it into the environment (the provenance registry is per-process,
 * and a child inherits a file-sourced value with no provenance attached),
 * and this read refuses a value this process's own loader sourced from a
 * file. The reviewed checkout must not choose its own review depth: the
 * profile is derived from the base/head diff, never from a flag a
 * repository can set.
 */
export function automaticReviewRequested(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): boolean {
  return (
    env['QWEN_REVIEW_AUTOMATIC']?.trim() === 'true' &&
    !fileSourced('QWEN_REVIEW_AUTOMATIC')
  );
}

type NavObject = { [key: string]: string | NavObject };

function literalNavigation(source: string): NavObject | null {
  if (source.length > 32_768 || /[\u2028\u2029]/.test(source)) return null;
  // Recognize only this literal subset. Unsupported JavaScript stays on the
  // full review path; no imported or PR-authored code is ever evaluated.
  const token =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'[^'\\\r\n]*'|"[^"\\\r\n]*"|[A-Za-z_$][\w$]*|[{}:,;]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) return null;
    offset = token.lastIndex;
    if (!/^\s|^\//.test(match[0])) tokens.push(match[0]);
  }
  if (tokens.shift() !== 'export' || tokens.shift() !== 'default') return null;
  if (tokens.at(-1) === ';') tokens.pop();
  const json: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i];
    if (/^[A-Za-z_$]/.test(value)) {
      if (tokens[i + 1] !== ':') return null;
      json.push(JSON.stringify(value));
    } else if (value.startsWith("'")) {
      json.push(JSON.stringify(value.slice(1, -1)));
    } else {
      json.push(value);
    }
    if (
      tokens[i + 1] === ':' &&
      ['__proto__', 'constructor', 'prototype'].includes(
        value.replace(/^['"]|['"]$/g, ''),
      )
    ) {
      return null;
    }
  }
  try {
    const errors: ParseError[] = [];
    const result: unknown = parse(json.join(' '), errors, {
      allowTrailingComma: true,
      disallowComments: true,
    });
    return errors.length === 0 && result !== null && typeof result === 'object'
      ? (result as NavObject)
      : null;
  } catch {
    return null;
  }
}

function nonPresentation(value: string | NavObject): string | null {
  if (typeof value === 'string') return '{}';
  const { title, display, ...rest } = value;
  if (title !== undefined && typeof title !== 'string') return null;
  if (display !== undefined && display !== 'hidden' && display !== 'normal') {
    return null;
  }
  return JSON.stringify(rest);
}

export function isStaticDocsNavDiff(
  diff: string,
  readFile: (side: 'base' | 'head', path: string) => string,
): boolean {
  const { files } = parseDiff(diff);
  const file = files[0];
  if (
    files.length !== 1 ||
    !/^docs\/(?:[A-Za-z0-9_-]+\/)*_meta\.ts$/.test(file.path) ||
    file.binary ||
    file.renameFrom ||
    file.addedLines + file.removedLines === 0 ||
    file.addedLines + file.removedLines >= 25 ||
    !/^index [a-f0-9]+\.\.[a-f0-9]+ 100644$/m.test(diff) ||
    /^(?:old mode|new mode|new file mode|deleted file mode|copy from|copy to) /m.test(
      diff,
    )
  ) {
    return false;
  }
  try {
    const base = literalNavigation(readFile('base', file.path));
    const head = literalNavigation(readFile('head', file.path));
    if (!base || !head) return false;
    const keys = Object.keys(base);
    return (
      keys.length > 0 &&
      keys.length === Object.keys(head).length &&
      // Order is structure on a Nextra _meta.ts: it is the sidebar order,
      // and a `type: 'separator'` groups the entries AFTER it, so a pure
      // reorder changes the information architecture the full review
      // exists to judge. (Keys cannot contain a newline — the token
      // grammar's string classes exclude one — so the join is
      // unambiguous.)
      keys.join('\n') === Object.keys(head).join('\n') &&
      keys.every((key) => {
        if (!Object.hasOwn(head, key)) return false;
        const before = nonPresentation(base[key]);
        return before !== null && before === nonPresentation(head[key]);
      })
    );
  } catch {
    return false;
  }
}
