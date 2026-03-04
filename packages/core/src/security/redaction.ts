/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { Content, ContentListUnion, Part, PartUnion } from '@google/genai';

export type RedactionBuiltin =
  | 'email'
  | 'china_phone'
  | 'china_id'
  | 'uuid'
  | 'ipv4'
  | 'mac';

export interface RedactionConfig {
  enabled?: boolean;
  /**
   * Placeholder prefix. Keep `__VG_` for compatibility with VibeGuard.
   */
  placeholderPrefix?: string;
  /**
   * Exact substring matches.
   * Map: keyword -> category
   */
  keywords?: Record<string, string>;
  /**
   * Regex matches (JavaScript RegExp syntax).
   * Map: pattern -> category
   */
  patterns?: Record<string, string>;
  /**
   * Built-in detectors. Unknown values are ignored.
   */
  builtins?: string[];
  /**
   * Exact matches to exclude from redaction (e.g. localhost, 127.0.0.1).
   */
  exclude?: string[];
  ttlMinutes?: number;
  maxSize?: number;
}

const DEFAULT_PLACEHOLDER_PREFIX = '__VG_';
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_MAX_SIZE = 10_000;

const BUILTIN_RULES: Record<
  RedactionBuiltin,
  { pattern: string; flags?: string; category: string }
> = {
  email: {
    pattern: `[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}`,
    flags: 'gi',
    category: 'EMAIL',
  },
  china_phone: {
    // Capture group 1 ensures we only redact the phone number itself,
    // keeping non-digit boundaries intact.
    pattern: `(?:^|\\D)(1[3-9]\\d{9})(?:$|\\D)`,
    flags: 'gd',
    category: 'CHINA_PHONE',
  },
  china_id: {
    // Capture group 1 ensures we only redact the ID itself.
    pattern: `(?:^|\\D)(\\d{17}[\\dXx])(?:$|\\D)`,
    flags: 'gd',
    category: 'CHINA_ID',
  },
  uuid: {
    pattern: `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
    flags: 'gd',
    category: 'UUID',
  },
  ipv4: {
    pattern: `(?:\\d{1,3}\\.){3}\\d{1,3}`,
    flags: 'gd',
    category: 'IPV4',
  },
  mac: {
    pattern: `(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`,
    flags: 'gdi',
    category: 'MAC',
  },
};

type Match = {
  start: number;
  end: number;
  original: string;
  category: string;
  placeholder?: string;
};

type Span = { start: number; end: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return DEFAULT_PLACEHOLDER_PREFIX;
  return prefix;
}

function normalizeConfig(
  config: RedactionConfig | undefined,
): Required<
  Pick<
    RedactionConfig,
    | 'enabled'
    | 'placeholderPrefix'
    | 'keywords'
    | 'patterns'
    | 'builtins'
    | 'exclude'
    | 'ttlMinutes'
    | 'maxSize'
  >
> {
  return {
    enabled: config?.enabled ?? false,
    placeholderPrefix: normalizePrefix(config?.placeholderPrefix),
    keywords: config?.keywords ?? {},
    patterns: config?.patterns ?? {},
    builtins: config?.builtins ?? [],
    exclude: config?.exclude ?? [],
    ttlMinutes: config?.ttlMinutes ?? DEFAULT_TTL_MINUTES,
    maxSize: config?.maxSize ?? DEFAULT_MAX_SIZE,
  };
}

function toLowerHex12(bytes: Buffer): string {
  return bytes.toString('hex').slice(0, 12);
}

export class RedactionSession {
  private readonly secret: Buffer;
  private readonly forward = new Map<string, string>(); // placeholder -> original
  private readonly reverse = new Map<string, string>(); // original -> placeholder
  private readonly created = new Map<string, number>(); // placeholder -> createdAtMs
  private lastCleanupMs = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
  ) {
    this.secret = randomBytes(32);
  }

  size(): number {
    return this.forward.size;
  }

  lookup(placeholder: string): string | undefined {
    this.cleanupIfNeeded();
    return this.forward.get(placeholder);
  }

  lookupReverse(original: string): string | undefined {
    this.cleanupIfNeeded();
    return this.reverse.get(original);
  }

  register(placeholder: string, original: string): void {
    this.cleanupIfNeeded();

    if (this.reverse.has(original)) {
      return;
    }

    if (this.forward.size >= this.maxSize) {
      this.evictOldest();
    }

    this.forward.set(placeholder, original);
    this.reverse.set(original, placeholder);
    this.created.set(placeholder, Date.now());
  }

  generatePlaceholder(
    original: string,
    category: string,
    prefix: string,
  ): string {
    this.cleanupIfNeeded();

    const hmac = createHmac('sha256', this.secret);
    hmac.update(original);
    const hash12 = toLowerHex12(hmac.digest());

    const base = `${prefix}${category}_${hash12}__`;
    const existing = this.lookup(base);
    if (existing === undefined || existing === original) {
      return base;
    }

    // Collision: add disambiguator suffix `_N__`, starting from 2.
    for (let i = 2; ; i++) {
      const candidate = `${prefix}${category}_${hash12}_${i}__`;
      const candidateExisting = this.lookup(candidate);
      if (candidateExisting === undefined || candidateExisting === original) {
        return candidate;
      }
    }
  }

  private cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanupMs < 60_000) {
      return;
    }
    this.lastCleanupMs = now;

    const expired: string[] = [];
    for (const [placeholder, createdAt] of this.created.entries()) {
      if (now - createdAt > this.ttlMs) {
        expired.push(placeholder);
      }
    }
    for (const placeholder of expired) {
      const original = this.forward.get(placeholder);
      this.forward.delete(placeholder);
      this.created.delete(placeholder);
      if (original !== undefined) {
        this.reverse.delete(original);
      }
    }
  }

  private evictOldest(): void {
    let oldestPlaceholder: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [placeholder, createdAt] of this.created.entries()) {
      if (createdAt < oldestTime) {
        oldestTime = createdAt;
        oldestPlaceholder = placeholder;
      }
    }
    if (!oldestPlaceholder) {
      return;
    }
    const original = this.forward.get(oldestPlaceholder);
    this.forward.delete(oldestPlaceholder);
    this.created.delete(oldestPlaceholder);
    if (original !== undefined) {
      this.reverse.delete(original);
    }
  }
}

export class RestoreEngine {
  private readonly placeholderRegex: RegExp;

  constructor(
    private readonly session: RedactionSession,
    private readonly prefix: string,
  ) {
    const escapedPrefix = escapeRegExp(prefix);
    const pattern = `${escapedPrefix}[A-Za-z0-9_]+_[a-f0-9]{12}(?:_\\d+)?__`;
    this.placeholderRegex = new RegExp(pattern, 'g');
  }

  restoreString(input: string): string {
    if (!input) return input;
    return input.replace(this.placeholderRegex, (placeholder) => this.session.lookup(placeholder) ?? placeholder);
  }

  prefixString(): string {
    return this.prefix;
  }

  matchAt(input: string, start: number): { end: number; ok: boolean } {
    if (start < 0 || start >= input.length) return { end: 0, ok: false };
    const slice = input.slice(start);
    const m = this.placeholderRegex.exec(slice);
    // Reset lastIndex (since placeholderRegex is global)
    this.placeholderRegex.lastIndex = 0;
    if (!m || m.index !== 0) return { end: 0, ok: false };
    return { end: start + m[0].length, ok: true };
  }
}

export class TextStreamRestorer {
  private buffer = '';

  constructor(private readonly restoreEngine: RestoreEngine) {}

  feed(fragment: string): string {
    if (!fragment) return '';
    this.buffer += fragment;

    const cut = safeEmitCut(this.buffer, this.restoreEngine);
    if (cut <= 0) {
      return '';
    }

    const out = this.restoreEngine.restoreString(this.buffer.slice(0, cut));
    this.buffer = this.buffer.slice(cut);
    return out;
  }

  flush(): string {
    if (!this.buffer) return '';
    const out = this.restoreEngine.restoreString(this.buffer);
    this.buffer = '';
    return out;
  }
}

function suffixPrefixLen(data: string, prefix: string): number {
  if (!data || prefix.length <= 1) return 0;
  const max = Math.min(prefix.length - 1, data.length);
  for (let k = max; k > 0; k--) {
    if (data.endsWith(prefix.slice(0, k))) {
      return k;
    }
  }
  return 0;
}

function safeEmitCut(data: string, engine: RestoreEngine): number {
  if (!data) return 0;
  const prefix = engine.prefixString();
  if (!prefix) return data.length;

  // 1) If the last prefix starts a complete placeholder that reaches the end,
  // we can safely emit everything.
  const lastPrefix = data.lastIndexOf(prefix);
  if (lastPrefix !== -1) {
    const { end, ok } = engine.matchAt(data, lastPrefix);
    if (ok && end === data.length) {
      return data.length;
    }

    // If it's not a placeholder start, keep a bounded tail to avoid unbounded buffering
    // when normal text contains "__VG_".
    if (!ok) {
      const maxTail = 512;
      if (data.length - lastPrefix <= maxTail) {
        return lastPrefix;
      }
    }
  }

  // 2) If the prefix itself is split across chunk boundary, keep the partial suffix.
  const partial = suffixPrefixLen(data, prefix);
  const cut = data.length - partial;
  return Math.max(0, Math.min(cut, data.length));
}

export class RedactionEngine {
  private readonly keywords: Map<string, string>;
  private readonly regexes: Array<{ re: RegExp; category: string }>;
  private readonly exclude: Set<string>;

  constructor(
    config: Required<
      Pick<RedactionConfig, 'keywords' | 'patterns' | 'builtins' | 'exclude'>
    >,
  ) {
    this.keywords = new Map(Object.entries(config.keywords));
    this.exclude = new Set(config.exclude);
    this.regexes = [];

    for (const builtin of config.builtins) {
      if (!(builtin in BUILTIN_RULES)) {
        continue;
      }
      const rule = BUILTIN_RULES[builtin as RedactionBuiltin];
      this.regexes.push({
        re: compileWithIndices(rule.pattern, rule.flags),
        category: rule.category,
      });
    }

    for (const [pattern, category] of Object.entries(config.patterns)) {
      this.regexes.push({
        re: compileWithIndices(pattern, 'g'),
        category,
      });
    }
  }

  redactString(
    input: string,
    session: RedactionSession,
    prefix: string,
  ): { output: string; matches: Match[] } {
    if (!input) return { output: input, matches: [] };

    const matches: Match[] = [];

    for (const [keyword, category] of this.keywords.entries()) {
      if (!keyword) continue;
      let idx = 0;
      for (;;) {
        const pos = input.indexOf(keyword, idx);
        if (pos === -1) break;
        const start = pos;
        const end = start + keyword.length;
        const original = input.slice(start, end);
        if (!this.exclude.has(original)) {
          matches.push({ start, end, original, category });
        }
        idx = end;
      }
    }

    for (const { re, category } of this.regexes) {
      const localRe = cloneRegex(re);
      for (const m of input.matchAll(localRe)) {
        const whole = m[0];
        if (!whole) continue;

        const indices = (
          m as unknown as { indices?: Array<[number, number] | undefined> }
        ).indices;
        let start = typeof m.index === 'number' ? m.index : -1;
        let end = start >= 0 ? start + whole.length : -1;

        // Prefer capture group 1 range if present.
        const group1 = indices?.[1];
        if (group1 && group1[0] >= 0 && group1[1] >= 0) {
          start = group1[0];
          end = group1[1];
        }

        if (start < 0 || end < 0 || start >= end || end > input.length) {
          continue;
        }

        const original = input.slice(start, end);
        if (!this.exclude.has(original)) {
          matches.push({ start, end, original, category });
        }
      }
    }

    if (matches.length === 0) {
      return { output: input, matches: [] };
    }

    // Sort by start desc, end desc (rightmost/longest first).
    matches.sort((a, b) => {
      if (a.start !== b.start) return b.start - a.start;
      return b.end - a.end;
    });

    const planned: Match[] = [];
    let covered: Span[] = [];

    for (const m of matches) {
      const segments = subtractCovered(m.start, m.end, covered);
      for (const seg of segments) {
        if (seg.start < 0 || seg.end > input.length || seg.start >= seg.end) {
          continue;
        }
        planned.push({
          start: seg.start,
          end: seg.end,
          original: input.slice(seg.start, seg.end),
          category: m.category,
        });
        covered = insertCovered(covered, seg);
      }
    }

    planned.sort((a, b) => b.start - a.start);

    let output = input;
    for (const m of planned) {
      const placeholder = session.generatePlaceholder(
        m.original,
        m.category,
        prefix,
      );
      session.register(placeholder, m.original);
      m.placeholder = placeholder;
      output = output.slice(0, m.start) + placeholder + output.slice(m.end);
    }

    return { output, matches: planned };
  }
}

function subtractCovered(start: number, end: number, covered: Span[]): Span[] {
  if (start >= end) return [];
  const out: Span[] = [];
  let cur = start;
  for (const c of covered) {
    if (c.end <= cur) continue;
    if (c.start >= end) break;
    if (c.start > cur) {
      out.push({ start: cur, end: Math.min(c.start, end) });
    }
    if (c.end >= end) {
      cur = end;
      break;
    }
    cur = Math.max(cur, c.end);
  }
  if (cur < end) {
    out.push({ start: cur, end });
  }
  return out;
}

function insertCovered(covered: Span[], s: Span): Span[] {
  if (s.start >= s.end) return covered;
  const idx = covered.findIndex((c) => c.start > s.start);
  const at = idx === -1 ? covered.length : idx;
  const next = [...covered.slice(0, at), s, ...covered.slice(at)];
  if (next.length <= 1) return next;

  const merged: Span[] = [];
  for (const c of next) {
    if (merged.length === 0) {
      merged.push({ ...c });
      continue;
    }
    const last = merged[merged.length - 1];
    if (c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      continue;
    }
    merged.push({ ...c });
  }
  return merged;
}

function compileWithIndices(
  pattern: string,
  flags: string | undefined,
): RegExp {
  const normalized = normalizeInlineFlags(pattern);
  const want = new Set((flags ?? '').split(''));
  want.add('g');
  want.add('d');
  for (const f of normalized.flags) {
    want.add(f);
  }
  const finalFlags = [...want].join('');
  return new RegExp(normalized.pattern, finalFlags);
}

function normalizeInlineFlags(pattern: string): {
  pattern: string;
  flags: string[];
} {
  // Minimal compatibility: translate a leading `(?i)` into JS `i` flag.
  if (pattern.startsWith('(?i)')) {
    return { pattern: pattern.slice(4), flags: ['i'] };
  }
  return { pattern, flags: [] };
}

function cloneRegex(re: RegExp): RegExp {
  // Preserve source and flags, but reset state like lastIndex.
  return new RegExp(re.source, re.flags);
}

function redactUnknown(
  value: unknown,
  apply: (input: string) => string,
): unknown {
  if (typeof value === 'string') {
    return apply(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redactUnknown(item, apply);
      changed ||= next !== item;
      return next;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const next = redactUnknown(v, apply);
      out[k] = next;
      changed ||= next !== v;
    }
    return changed ? out : value;
  }
  return value;
}

function isContentLike(value: unknown): value is Content {
  return (
    !!value &&
    typeof value === 'object' &&
    'role' in (value as Record<string, unknown>) &&
    'parts' in (value as Record<string, unknown>)
  );
}

function toPart(part: PartUnion): Part {
  if (typeof part === 'string') {
    return { text: part };
  }
  return part as Part;
}

function toContents(contents: ContentListUnion): Content[] {
  if (Array.isArray(contents)) {
    // If this is already a list of Content messages, keep it.
    if (contents.every((c) => isContentLike(c))) {
      return contents as Content[];
    }

    // Otherwise treat it as a list of parts (single user message).
    return [
      {
        role: 'user',
        parts: (contents as PartUnion[]).filter((p) => p != null).map(toPart),
      },
    ];
  }

  if (typeof contents === 'string') {
    return [{ role: 'user', parts: [{ text: contents }] }];
  }

  if (isContentLike(contents)) {
    return [contents];
  }

  // Single part union.
  return [{ role: 'user', parts: [toPart(contents as PartUnion)] }];
}

function cloneContents(contents: Content[]): Content[] {
  return structuredClone(contents);
}

export class RedactionManager {
  private config: ReturnType<typeof normalizeConfig>;
  private readonly session: RedactionSession;
  private engine: RedactionEngine;
  private restoreEngine: RestoreEngine;

  constructor(config: RedactionConfig | undefined) {
    this.config = normalizeConfig(config);
    this.session = new RedactionSession(
      this.config.ttlMinutes * 60_000,
      this.config.maxSize,
    );
    this.engine = new RedactionEngine(this.config);
    this.restoreEngine = new RestoreEngine(
      this.session,
      this.config.placeholderPrefix,
    );
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
  }

  getStats(): { enabled: boolean; mappings: number; prefix: string } {
    return {
      enabled: this.config.enabled,
      mappings: this.session.size(),
      prefix: this.config.placeholderPrefix,
    };
  }

  redactContents(contents: ContentListUnion): ContentListUnion {
    if (!this.config.enabled) {
      return contents;
    }

    const baseContents = toContents(contents);
    const cloned = cloneContents(baseContents);

    const apply = (text: string): string =>
      this.engine.redactString(
        text,
        this.session,
        this.config.placeholderPrefix,
      ).output;

    for (const content of cloned) {
      if (!content.parts) continue;

      for (const part of content.parts) {
        if (!part) continue;

        // Text parts (including thought text) — always safe to redact.
        if (typeof part.text === 'string' && part.text) {
          part.text = apply(part.text);
        }

        // Tool call args can contain sensitive strings after local restoration.
        if (part.functionCall?.args) {
          part.functionCall.args = redactUnknown(
            part.functionCall.args,
            apply,
          ) as Record<string, unknown>;
        }

        // Tool results often include secrets (e.g. reading .env files).
        // Only redact the response payload, never mutate tool identifiers.
        if (part.functionResponse?.response) {
          part.functionResponse.response = redactUnknown(
            part.functionResponse.response,
            apply,
          ) as Record<string, unknown>;
        }
      }
    }

    return cloned;
  }

  restoreString(input: string): string {
    if (!this.config.enabled) {
      return input;
    }
    return this.restoreEngine.restoreString(input);
  }

  createStreamRestorer(): TextStreamRestorer {
    return new TextStreamRestorer(this.restoreEngine);
  }

  restoreUnknown(value: unknown): unknown {
    if (!this.config.enabled) {
      return value;
    }
    return redactUnknown(value, (s) => this.restoreEngine.restoreString(s));
  }
}
