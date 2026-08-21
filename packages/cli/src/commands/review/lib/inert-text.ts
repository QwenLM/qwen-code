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

/** Control characters, including DEL — the forgery and escape-sequence set. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  // characters but passes DEL (U+007F) through verbatim, and DEL is a
  // terminal control code like any other. Every control character is
  // replaced explicitly, then the whole value is quoted so it cannot be
  // read as prose.
  const rendered = CONTROL.test(clipped)
    ? JSON.stringify(
        // eslint-disable-next-line no-control-regex
        clipped.replace(/[\u0000-\u001f\u007f]/g, (c) => {
          const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
          return `\\u${hex}`;
        }),
      )
    : clipped;
  return clipped.length < value.length ? `${rendered}…` : rendered;
}
