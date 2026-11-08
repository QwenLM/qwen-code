import { PROMPT_UNSAFE_INVISIBLES } from './sanitize.js';
import type { ChannelMemoryEntry } from './types.js';

export const CHANNEL_MEMORY_RECALL_MAX_ENTRIES = 3;
export const CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS = 1_200;
export const CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS = 120;

const CHANNEL_MEMORY_RECALL_TRUNCATION_SUFFIX = ' [truncated]';

const TERM_RUN_PATTERN =
  /\p{Script=Latin}+|\p{Decimal_Number}+|\p{Script_Extensions=Han}+|\p{Script_Extensions=Hiragana}+|\p{Script_Extensions=Katakana}+|\p{Script_Extensions=Hangul}+/gu;

type IndexedCandidate = {
  entry: ChannelMemoryEntry;
  index: number;
  entryTerms: Set<string>;
  normalizedLength: number;
};

type Candidate = IndexedCandidate & {
  score: number;
};

export interface ChannelMemoryRecallIndex {
  readonly candidates: readonly IndexedCandidate[];
}

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(PROMPT_UNSAFE_INVISIBLES, ' ');
}

function terms(normalized: string): Set<string> {
  const result = new Set<string>();

  for (const match of normalized.matchAll(TERM_RUN_PATTERN)) {
    const run = Array.from(match[0]);
    const first = run[0];
    if (!first) continue;

    if (/\p{Script=Latin}/u.test(first)) {
      if (run.length >= 2) result.add(`latin:${run.join('')}`);
      continue;
    }

    if (/\p{Decimal_Number}/u.test(first)) {
      if (run.length >= 2) result.add(`number:${run.join('')}`);
      continue;
    }

    const namespace = /\p{Script_Extensions=Han}/u.test(first)
      ? 'han'
      : /\p{Script_Extensions=Hiragana}/u.test(first)
        ? 'hiragana'
        : /\p{Script_Extensions=Katakana}/u.test(first)
          ? 'katakana'
          : 'hangul';
    for (let index = 0; index + 1 < run.length; index += 1) {
      result.add(`${namespace}:${run[index]}${run[index + 1]}`);
    }
  }

  return result;
}

function overlapSize(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const term of left) {
    if (right.has(term)) score += 1;
  }
  return score;
}

function truncateEntryToRecallBudget(
  entry: ChannelMemoryEntry,
): ChannelMemoryEntry {
  const suffix = Array.from(CHANNEL_MEMORY_RECALL_TRUNCATION_SUFFIX);
  const text = Array.from(entry.text)
    .slice(0, CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS - suffix.length)
    .concat(suffix)
    .join('');
  return { ...entry, text };
}

export function selectRelevantChannelMemory(
  message: string,
  entries: readonly ChannelMemoryEntry[],
): ChannelMemoryEntry[] {
  return selectRelevantChannelMemoryFromIndex(
    message,
    createChannelMemoryRecallIndex(entries),
  );
}

export function createChannelMemoryRecallIndex(
  entries: readonly ChannelMemoryEntry[],
): ChannelMemoryRecallIndex {
  return {
    candidates: entries.map((entry, index) => {
      const normalized = normalize(entry.text);
      return {
        entry: { ...entry },
        index,
        entryTerms: terms(normalized),
        normalizedLength: Array.from(normalized).length,
      };
    }),
  };
}

export function selectRelevantChannelMemoryFromIndex(
  message: string,
  recallIndex: ChannelMemoryRecallIndex,
): ChannelMemoryEntry[] {
  const messageTerms = terms(normalize(message));
  const candidates: Candidate[] = recallIndex.candidates.map((candidate) => ({
    ...candidate,
    score: overlapSize(messageTerms, candidate.entryTerms),
  }));
  const positive = candidates
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const fallback = candidates.filter(
    ({ score, normalizedLength }) =>
      score === 0 &&
      normalizedLength <= CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS,
  );
  const selected: ChannelMemoryEntry[] = [];
  let usedCodePoints = 0;

  for (const { entry, score } of [...positive, ...fallback]) {
    if (selected.length >= CHANNEL_MEMORY_RECALL_MAX_ENTRIES) break;
    const entryCodePoints = Array.from(entry.text).length;
    if (
      usedCodePoints + entryCodePoints >
      CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS
    ) {
      if (
        score > 0 &&
        selected.length === 0 &&
        entryCodePoints > CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS
      ) {
        selected.push(truncateEntryToRecallBudget(entry));
        break;
      }
      continue;
    }
    selected.push(entry);
    usedCodePoints += entryCodePoints;
  }

  return selected;
}
