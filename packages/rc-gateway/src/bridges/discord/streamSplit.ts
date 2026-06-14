/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Split a markdown string into Discord messages each ≤ `max` characters
 * (`add-discord-bridge`: "session_update rendering with 2000-char cap"). The
 * split prefers, in order, a fenced code-block close > a paragraph/line break >
 * a word break > a hard cut.
 *
 * The load-bearing subtlety is **code-fence balancing**: if a fenced block (```)
 * spans a cut, the message that ends mid-block MUST close the fence, and the
 * next message MUST reopen it with the SAME language tag — otherwise Discord
 * renders the tail as prose and the head as an unterminated block. Critically,
 * the closing/reopening fence characters COUNT against the 2000 budget, so the
 * packer reserves that overhead rather than filling to 2000 and then overflowing
 * when it appends the closing fence.
 *
 * Fences are line-oriented in markdown: a line whose trimmed form starts with
 * ``` toggles fence state (the opener may carry a language tag; the closer is
 * bare). The packer works at line granularity (so every natural break is a line
 * boundary) and only falls to word/hard splitting for a single line that alone
 * exceeds the budget.
 */

const FENCE = '```';

/** A line that toggles fenced-code state, plus the opener's language tag. */
function fenceToggle(line: string): { toggle: boolean; lang: string } {
  const t = line.trimStart();
  if (!t.startsWith(FENCE)) return { toggle: false, lang: '' };
  // Opener `\`\`\`lang` → lang is the first token after the fence; closer is bare.
  const rest = t.slice(FENCE.length).trim();
  return { toggle: true, lang: rest };
}

/** Render a message body, prepending a reopen fence and/or appending a close. */
function render(
  bodyLines: string[],
  openedInFence: boolean,
  openLang: string,
  endsInFence: boolean,
): string {
  let s = '';
  if (openedInFence) s += `${FENCE}${openLang}\n`;
  s += bodyLines.join('\n');
  if (endsInFence) s += `\n${FENCE}`;
  return s;
}

/** Split one over-long line into ≤budget pieces, preferring a trailing space. */
function splitLongLine(line: string, budget: number): string[] {
  const out: string[] = [];
  let rest = line;
  // budget can be tiny in pathological cases; clamp to ≥1 so we always progress.
  const b = Math.max(1, budget);
  while (rest.length > b) {
    let cut = rest.lastIndexOf(' ', b);
    if (cut <= 0) cut = b; // no usable space → hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, ''); // drop the boundary space
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export function splitForDiscord(text: string, max = 2000): string[] {
  if (text.length === 0) return [];
  // Fast path: already fits and balanced (no need to even scan fences).
  if (text.length <= max && countFences(text) % 2 === 0) return [text];

  const lines = text.split('\n');
  const messages: string[] = [];

  // Fence state as lines are CONSUMED (global across the whole text). Annotated
  // ternary results (nextInFence/nextLang) below break the circular inference;
  // these can stay literal-inferred.
  let inFence = false;
  let fenceLang = '';

  // The message currently being accumulated.
  let curLines: string[] = [];
  let openedInFence = false; // started inside a fence (needs reopen)
  let openLang = '';

  const flush = () => {
    if (curLines.length === 0 && !openedInFence) return;
    messages.push(render(curLines, openedInFence, openLang, inFence));
    curLines = [];
    openedInFence = inFence; // the NEXT message inherits the open-fence state
    openLang = fenceLang;
  };

  // The fixed overhead a message pays for reopen prefix + closing suffix, given
  // the fence state at its start/end. Used to size the budget for long-line cuts.
  const overhead = (startInFence: boolean, endInFence: boolean) =>
    (startInFence ? FENCE.length + fenceLang.length + 1 : 0) +
    (endInFence ? 1 + FENCE.length : 0);

  for (const line of lines) {
    const tog = fenceToggle(line);
    const nextInFence: boolean = tog.toggle ? !inFence : inFence;
    const nextLang: string = tog.toggle ? (inFence ? '' : tog.lang) : fenceLang;

    const candidate = render(
      [...curLines, line],
      openedInFence,
      openLang,
      nextInFence,
    );
    if (candidate.length <= max) {
      curLines.push(line);
      inFence = nextInFence;
      fenceLang = nextLang;
      continue;
    }

    // Doesn't fit. If the current message has content, flush it (ending in the
    // PRE-line fence state) and retry the line in a fresh message.
    if (curLines.length > 0) {
      flush();
      const retry = render([line], openedInFence, openLang, nextInFence);
      if (retry.length <= max) {
        curLines.push(line);
        inFence = nextInFence;
        fenceLang = nextLang;
        continue;
      }
    }

    // The line alone exceeds the budget — split it. A toggle line is short and
    // always fits, so here the line is plain content and fence state is unchanged
    // (nextInFence === inFence). Each piece is its own message.
    const budget = max - overhead(openedInFence, inFence);
    for (const piece of splitLongLine(line, budget)) {
      messages.push(render([piece], openedInFence, openLang, inFence));
      openedInFence = inFence; // subsequent pieces reopen if still in a fence
      openLang = fenceLang;
    }
    curLines = [];
  }

  flush();
  return messages.filter((m) => m.length > 0);
}

/** Count fence markers (for the fast-path balance check). */
function countFences(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (fenceToggle(line).toggle) n++;
  }
  return n;
}
