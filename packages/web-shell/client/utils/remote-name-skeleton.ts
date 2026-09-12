import { CONFUSABLE_PROTOTYPES } from './unicodeConfusables';

// The Unicode TR39 confusables fold: two names whose per-code-point
// prototypes match ink (nearly) identically through NO invisible
// character — a ligature (`of\uFB01ce` vs `office`), a dotless `ı`, a
// Kelvin sign, a cross-script twin — so the per-property arms alone
// have no last corner. The TABLE answers first: its prototype is the
// authoritative one (a Greek lunate sigma Ϲ folds to C — asking NFKC
// first would route it through Σ to a different class, defeating the
// entry the table carries for exactly this pair). NFKC is the fallback
// for the compatibility shapes the table does not list (a name's own
// precomposed é must still meet its decomposed twin). Rows
// mark by COLLISION with a sibling's skeleton, never by a blanket
// non-ASCII test: a lone `上游` (no table entry) keeps its own skeleton
// and stays plain.
export function remoteNameSkeleton(name: string): string {
  // Iterated to a fixed point, not a single pass: the closing NFC can
  // compose a code point that is itself a table key (`0` maps to `O`,
  // then NFC composes `O` + U+030B into Ő, whose prototype is Ö), and
  // a decomposed spelling only meets the table after that composition
  // (`o` + U+0308 → ö → ة) — one pass would put ink-identical names
  // in different skeletons. The cap guarantees termination (confluence
  // is not proven); measured convergence is ≤2 extra passes over the
  // committed table.
  let out = name;
  for (let pass = 0; pass < 8; pass++) {
    let next = '';
    for (const ch of out) {
      const direct = CONFUSABLE_PROTOTYPES.get(ch);
      if (direct !== undefined) {
        next += direct;
        continue;
      }
      // Table-absent: fold the compatibility shapes (a ligature, a
      // fullwidth form) and give each half its own table chance.
      for (const folded of ch.normalize('NFKC')) {
        next += CONFUSABLE_PROTOTYPES.get(folded) ?? folded;
      }
    }
    // Canonical closure: a precomposed é and its decomposed twin fold
    // per code point to the same decomposed string — NFC the skeleton
    // so the comparison (and the raw ≠ skeleton polarity) works on
    // canonical forms.
    next = next.normalize('NFC');
    if (next === out) break;
    out = next;
  }
  return out;
}
