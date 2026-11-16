/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// One escaper for every workspace-controlled string this command family
// prints.
//
// The review reads three classes of attacker-or-model-written text and writes
// them to a terminal: filenames (git permits almost any byte in one), the
// review cache's own fields (`lastModelId`, `stateId`, `target` — written by
// a model under prose rules, or planted on disk), and `JSON.parse` failure
// messages, which embed a snippet of the offending file's bytes verbatim,
// control characters included. Printed raw, any of them can forge a second
// warning line — SKILL.md tells the orchestrator to repeat stderr lines back
// to the user, so a forged line reaches the model's context too — or emit
// OSC/CSI sequences at the operator's terminal.
//
// `capture-local` has escaped filenames this way since its own review found
// the hole; this module is that rule, extracted, so the newer sinks cannot
// each re-derive it (and re-forget it).

/**
 * Everything the rule this module extracted swept — no less.
 *
 * `\p{Cc}` is C0, DEL **and the ECMA-48 C1 range** U+0080–U+009F, whose
 * members are the 8-bit CSI/OSC/DCS/ST introducers: a terminal acts on those
 * exactly as it acts on `ESC [`. `\p{Cf}` is the INVISIBLE formatting class —
 * bidi overrides and isolates can reverse the rendering of the rest of the
 * line, and zero-width joiners and the BOM hide characters inside a value the
 * operator is being asked to judge. `\p{Zl}`/`\p{Zp}` are U+2028/U+2029,
 * which open a new line wherever this text is rendered, so a forged second
 * line needs no `\n`.
 *
 * The extraction had kept C0 and DEL alone, which let all three through
 * verbatim and unquoted — through the very sinks it was extracted to protect:
 * `cache-commit`'s refusals over a candidate its own intake comment calls
 * tamperable, `capture-local`'s warnings, and the symlink guards.
 */
export const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The part of that class `JSON.stringify` does NOT escape on its own.
 *
 * Measured, not assumed: `JSON.stringify` escapes C0 (U+0000–U+001F) and
 * passes DEL, the C1 range, the Cf class and U+2028/U+2029 through verbatim.
 * Pre-escaping the whole class double-escaped the half it already handles —
 * ESC came out as `\\u001b` where `\u001b` is what the sinks read — so the
 * replacement covers exactly the remainder and `JSON.stringify` finishes the
 * job. One class still decides WHETHER to quote; this one decides what the
 * quoting cannot express by itself.
 */
const NEEDS_PRE_ESCAPE = /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Render untrusted text inert for a terminal: quoted-and-escaped when it
 * carries control characters, verbatim otherwise (the overwhelming case, and
 * quoting every ordinary string would make every message harder to read).
 *
 * `maxChars` caps the result BEFORE escaping so a hostile value cannot flood
 * the line; the cap counts source characters, and the truncation marker is
 * added outside the quoting so it can never be mistaken for content.
 */
export function inertText(value: string, maxChars = 200): string {
  const clipped = value.length > maxChars ? value.slice(0, maxChars) : value;
  // `JSON.stringify` alone is not enough: it escapes the familiar control
  // characters and passes everything else through verbatim — DEL, the C1
  // range, the invisible Cf class, U+2028/U+2029. Each of those is a terminal
  // control code or a rendering attack like any other, so the replacement
  // sweeps the SAME class the classifier does and the two cannot drift.
  //
  // They did drift, and that is why this reads as one expression now: an
  // earlier fix widened `CONTROL` alone, so the value was correctly judged
  // dangerous, correctly quoted — and still carried the raw bytes inside the
  // quotes, while the comment here claimed every control character was
  // replaced.
  const rendered = CONTROL.test(clipped)
    ? JSON.stringify(
        clipped.replace(NEEDS_PRE_ESCAPE, (c) => {
          const hex = c.codePointAt(0)!.toString(16).padStart(4, '0');
          return `\\u${hex}`;
        }),
      )
    : clipped;
  return clipped.length < value.length ? `${rendered}…` : rendered;
}
