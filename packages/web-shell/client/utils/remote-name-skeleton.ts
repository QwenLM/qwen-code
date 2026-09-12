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
  let out = '';
  for (const ch of name) {
    const direct = CONFUSABLE_PROTOTYPES.get(ch);
    if (direct !== undefined) {
      out += direct;
      continue;
    }
    // Table-absent: fold the compatibility shapes (a ligature, a
    // fullwidth form) and give each half its own table chance.
    for (const folded of ch.normalize('NFKC')) {
      out += CONFUSABLE_PROTOTYPES.get(folded) ?? folded;
    }
  }
  // Canonical closure: a precomposed é and its decomposed twin fold
  // per code point to the same decomposed string — NFC the skeleton so
  // the comparison (and the raw ≠ skeleton polarity) works on canonical
  // forms.
  return out.normalize('NFC');
}
