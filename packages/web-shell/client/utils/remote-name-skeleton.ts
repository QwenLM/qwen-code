import { CONFUSABLE_PROTOTYPES } from './unicodeConfusables';

// The Unicode TR39 confusables fold: two names whose per-code-point
// prototypes match ink (nearly) identically through NO invisible
// character — a ligature (`of\uFB01ce` vs `office`), a dotless `ı`, a
// Kelvin sign, a cross-script twin — so the per-property arms alone
// have no last corner. The TABLE answers first: its prototype is the
// authoritative one (a Greek lunate sigma Ϲ folds to C — normalizing
// first would route it through Σ to a different class, defeating the
// entry the table carries for exactly this pair). Rows mark by
// COLLISION with a sibling's skeleton, never by a blanket non-ASCII
// test: a lone `上游` (no table entry) keeps its own skeleton and stays
// plain.
//
// A code point the table does not list is decided by its PARTS, and
// which parts matters: a remote name may spell the same character
// precomposed or decomposed, and the entrance NFC recomposes canonical
// spellings so both offer the same code points to the direct branch.
// The fallback walks the canonical parts first — each with its own
// table chance — and only then folds compatibility shapes, or the two
// spellings part company (`\u1E9B`, whose one-step NFKD would flatten
// its own `ſ` part to `s` before the table could answer `f` for it).
// The generator resolves every prototype in this same space, so the
// table agrees with the fold in both directions and
// canonically-equivalent names share a skeleton whichever spelling
// they arrive in (`i\u0146fra` and `in\u0327fra`, NFC and NFD alike).
// Known limitation: a confusable base plus an
// extra combining mark (K+M beside its prototype spelling P+M) can
// still split when the folded marks land in equal combining class —
// unifying that class needs a combining-class-aware comparison space
// (follow-up), not this fold.
export function remoteNameSkeleton(name: string): string {
  // Iterated to a fixed point, not a single pass: the closing NFC can
  // compose a code point that is itself a table key (`0` maps to `O`,
  // then NFC composes `O` + U+030B into Ő, whose prototype is Ö), and
  // a decomposed spelling only meets the table after that composition
  // (`o` + U+0308 → ö → ة) — one pass would put ink-identical names
  // in different skeletons. The cap guarantees termination (confluence
  // is not proven); the generator drops any entry whose fold would
  // cycle instead of settling, so measured convergence is ≤2 extra
  // passes over the committed table.
  // Canonicalize the ENTRANCE to NFC: NFC is a canonical function
  // (NFC(NFD(x)) === NFC(x)), so every canonical spelling of a name
  // enters the same representative — the closing NFC alone cannot
  // achieve that, because a mark arriving inside a precomposed char's
  // prototype stays glued to its base while canonical ordering moves
  // it first in a decomposed spelling, and the two spellings recompose
  // different stacks.
  let out = name.normalize('NFC');
  for (let pass = 0; pass < 8; pass++) {
    let next = '';
    for (const ch of out) {
      const direct = CONFUSABLE_PROTOTYPES.get(ch);
      if (direct !== undefined) {
        next += direct;
        continue;
      }
      const parts = [...ch.normalize('NFD')];
      // The entrance NFC can fuse a table base with a following mark
      // into a code point that is NOT a table key (ö + U+0304 →
      // U+022B): the longest decomposed prefix whose recomposition IS
      // a key still gets the table's answer first (the module's
      // table-first doctrine), and the remaining marks process as
      // usual.
      let consumed = 0;
      for (let len = parts.length - 1; len > 1; len--) {
        const hit = CONFUSABLE_PROTOTYPES.get(
          parts.slice(0, len).join('').normalize('NFC'),
        );
        if (hit !== undefined) {
          next += hit;
          consumed = len;
          break;
        }
      }
      for (let i = consumed; i < parts.length; i++) {
        const part = parts[i];
        const partDirect = CONFUSABLE_PROTOTYPES.get(part);
        if (partDirect !== undefined) {
          next += partDirect;
          continue;
        }
        for (const folded of part.normalize('NFKD')) {
          next += CONFUSABLE_PROTOTYPES.get(folded) ?? folded;
        }
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
